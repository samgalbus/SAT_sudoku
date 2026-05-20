"""Flask server wrapping the SAT-based Sudoku solver.

The SAT encoding lives in template.py and is graded as-is. This module owns
everything around it: per-request CNF temp files, concurrency lock (template.py
mutates module globals during encoding), subprocess timeout, SQLite sudoku
cache, and the JSON API the frontend talks to.

Endpoints (POST, JSON):
    /solve     - solve a board; smart-fallback to cached clues on UNSAT
    /check     - per-cell correct/wrong vs cached solution           (Phase C)
    /hint      - return one correct cell from the solver             (Phase D)
    /validate  - structural duplicate scan, no solver call           (Phase C)
    /generate  - random uniquely-solvable sudoku for chosen difficulty (Phase E)
"""

import contextlib
import io
import json
import logging
import os
import random
import re
import secrets
import shutil
import smtplib
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from functools import wraps
from subprocess import TimeoutExpired

from flask import Flask, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from template import solveBoard

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "puzzles.db")
SOLVER_LOCK = threading.Lock()
WEEKLY_GEN_LOCK = threading.Lock()
DIFFICULTY_CLUES = {"easy": 40, "medium": 30, "hard": 25, "expert": 22}
WEEKLY_DIFFICULTIES = ("easy", "medium", "hard")
RESET_TOKEN_TTL_SECONDS = 3600

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

log = logging.getLogger(__name__)

# templates/ is Flask's default lookup; sudoku.html lives there now.
app = Flask(__name__, static_folder="static")
app.secret_key = os.environ.get("SUDOKU_SECRET_KEY", "dev-only-change-me")
app.permanent_session_lifetime = timedelta(days=30)


# ---------------------------- DB helpers ----------------------------

def _db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    conn = _db_connect()
    try:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS puzzles (
                id TEXT PRIMARY KEY,
                clues_json TEXT NOT NULL,
                solution_json TEXT NOT NULL,
                difficulty TEXT,
                created_at REAL NOT NULL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                username_lower TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE,
                password_hash TEXT,
                created_at REAL NOT NULL,
                deleted_at REAL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS password_reset_tokens (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at REAL NOT NULL,
                used_at REAL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS weekly_puzzles (
                id TEXT PRIMARY KEY,
                week_id TEXT NOT NULL,
                difficulty TEXT NOT NULL,
                clues_json TEXT NOT NULL,
                solution_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(week_id, difficulty)
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS weekly_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                week_id TEXT NOT NULL,
                difficulty TEXT NOT NULL,
                puzzle_id TEXT NOT NULL,
                started_at REAL NOT NULL,
                completed_at REAL,
                elapsed_ms INTEGER,
                disqualified INTEGER DEFAULT 0,
                grid_state_json TEXT,
                UNIQUE(user_id, week_id, difficulty),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_attempts_leaderboard
                ON weekly_attempts (week_id, difficulty, disqualified, elapsed_ms, completed_at)"""
        )
        conn.commit()
    finally:
        conn.close()


def _save_puzzle(pid, clues, solution, difficulty):
    conn = _db_connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO puzzles (id, clues_json, solution_json, difficulty, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (pid, json.dumps(clues), json.dumps(solution), difficulty, time.time()),
        )
        conn.commit()
    finally:
        conn.close()


def _load_puzzle(pid):
    if not pid:
        return None
    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT clues_json, solution_json, difficulty FROM puzzles WHERE id = ?",
            (pid,),
        ).fetchone()
        if row is None:
            return None
        return {
            "clues": json.loads(row["clues_json"]),
            "solution": json.loads(row["solution_json"]),
            "difficulty": row["difficulty"],
        }
    finally:
        conn.close()

_init_db()


# ---------------------------- Auth helpers ----------------------------

def _current_week_id():
    """ISO year-week string (Monday 00:00 UTC rollover)."""
    iso = datetime.now(timezone.utc).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def _format_user(row):
    """Public-safe user view; strips email + password hash."""
    if row is None:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "created_at": row["created_at"],
    }


def _current_user():
    """Reads session, returns the user row dict or None.

    Returns None for soft-deleted users so the rest of the app can treat them
    as logged-out.
    """
    uid = session.get("user_id")
    if not uid:
        return None
    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT id, username, username_lower, email, created_at, deleted_at "
            "FROM users WHERE id = ?",
            (uid,),
        ).fetchone()
        if row is None or row["deleted_at"] is not None:
            session.clear()
            return None
        return dict(row)
    finally:
        conn.close()


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = _current_user()
        if user is None:
            return jsonify({"success": False, "message": "auth required"}), 401
        return fn(user, *args, **kwargs)
    return wrapper


def _validate_username(value):
    if not isinstance(value, str):
        return False, "username must be a string"
    if not USERNAME_RE.match(value):
        return False, "username must be 3-20 characters: letters, digits, or underscore"
    return True, None


def _validate_password(value):
    if not isinstance(value, str) or len(value) < 8:
        return False, "password must be at least 8 characters"
    return True, None


def _validate_email(value):
    if not isinstance(value, str) or not EMAIL_RE.match(value):
        return False, "email is not valid"
    return True, None


def _get_or_create_weekly_puzzle(week_id, difficulty):
    """Returns this (week, difficulty)'s sudoku row, generating it on first request.

    Serialized via WEEKLY_GEN_LOCK to keep two simultaneous first-visitors from
    each running _generate_puzzle. INSERT OR IGNORE means the loser of the race
    no-ops cleanly.
    """
    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT id, clues_json, solution_json FROM weekly_puzzles "
            "WHERE week_id = ? AND difficulty = ?",
            (week_id, difficulty),
        ).fetchone()
        if row is not None:
            return {
                "id": row["id"],
                "clues": json.loads(row["clues_json"]),
                "solution": json.loads(row["solution_json"]),
            }
    finally:
        conn.close()

    with WEEKLY_GEN_LOCK:
        conn = _db_connect()
        try:
            row = conn.execute(
                "SELECT id, clues_json, solution_json FROM weekly_puzzles "
                "WHERE week_id = ? AND difficulty = ?",
                (week_id, difficulty),
            ).fetchone()
            if row is not None:
                return {
                    "id": row["id"],
                    "clues": json.loads(row["clues_json"]),
                    "solution": json.loads(row["solution_json"]),
                }
            clues, solution, _ = _generate_puzzle(difficulty)
            pid = str(uuid.uuid4())
            conn.execute(
                "INSERT OR IGNORE INTO weekly_puzzles "
                "(id, week_id, difficulty, clues_json, solution_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (pid, week_id, difficulty,
                 json.dumps(clues), json.dumps(solution), time.time()),
            )
            conn.commit()
            row = conn.execute(
                "SELECT id, clues_json, solution_json FROM weekly_puzzles "
                "WHERE week_id = ? AND difficulty = ?",
                (week_id, difficulty),
            ).fetchone()
            return {
                "id": row["id"],
                "clues": json.loads(row["clues_json"]),
                "solution": json.loads(row["solution_json"]),
            }
        finally:
            conn.close()


def _attempt_status(row, now=None):
    """Builds the attempt sub-object returned by /weekly/<difficulty>."""
    if row is None:
        return {"status": "not_started"}
    now = now if now is not None else time.time()
    if row["completed_at"] is not None:
        return {
            "status": "completed",
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
            "elapsed_ms": row["elapsed_ms"],
            "disqualified": bool(row["disqualified"]),
        }
    grid_state = None
    if row["grid_state_json"]:
        try:
            grid_state = json.loads(row["grid_state_json"])
        except (TypeError, ValueError):
            grid_state = None
    return {
        "status": "in_progress",
        "started_at": row["started_at"],
        "elapsed_ms": int((now - row["started_at"]) * 1000),
        "disqualified": bool(row["disqualified"]),
        "grid_state": grid_state,
    }


def _load_attempt(conn, user_id, week_id, difficulty):
    return conn.execute(
        "SELECT * FROM weekly_attempts "
        "WHERE user_id = ? AND week_id = ? AND difficulty = ?",
        (user_id, week_id, difficulty),
    ).fetchone()


def _send_reset_email(to_email, link):
    """Send the reset link via SMTP. Falls back to logging the link if SMTP env vars
    aren't configured — handy for local dev (read it from the server log)."""
    host = os.environ.get("SUDOKU_SMTP_HOST")
    user = os.environ.get("SUDOKU_SMTP_USER")
    password = os.environ.get("SUDOKU_SMTP_PASS")
    sender = os.environ.get("SUDOKU_MAIL_FROM", user or "no-reply@localhost")
    if not host or not user or not password:
        log.warning("SMTP not configured; password reset link for %s: %s", to_email, link)
        return

    port = int(os.environ.get("SUDOKU_SMTP_PORT", "587"))
    msg = EmailMessage()
    msg["Subject"] = "Reset your Sudoku account password"
    msg["From"] = sender
    msg["To"] = to_email
    msg.set_content(
        "Someone (hopefully you) asked to reset your Sudoku password.\n\n"
        f"Open this link within 1 hour to choose a new password:\n{link}\n\n"
        "If it wasn't you, ignore this email — your password stays the same."
    )
    try:
        with smtplib.SMTP(host, port, timeout=10) as smtp:
            smtp.starttls()
            smtp.login(user, password)
            smtp.send_message(msg)
    except (OSError, smtplib.SMTPException) as exc:
        log.error("Failed to send reset email to %s: %s", to_email, exc)


# ---------------------------- Input validation ----------------------------

def _grid_from_payload(payload):
    """Coerce the JSON 'board' field into a 9x9 list[list[int]] with values 0-9.

    The frontend sends cells as strings (empty string = empty cell); we coerce
    to int. Raises ValueError on any shape or range problem.
    """
    if not isinstance(payload, dict) or "board" not in payload:
        raise ValueError("missing 'board' field")
    board = payload["board"]
    if not isinstance(board, list) or len(board) != 9:
        raise ValueError("board must have 9 rows")

    grid = []
    for r, row in enumerate(board):
        if not isinstance(row, list) or len(row) != 9:
            raise ValueError(f"row {r} must have 9 cells")
        coerced = []
        for c, cell in enumerate(row):
            if cell == "" or cell is None:
                coerced.append(0)
                continue
            try:
                v = int(cell)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"cell [{r},{c}] is not an integer") from exc
            if v < 0 or v > 9:
                raise ValueError(f"cell [{r},{c}] out of range 0-9")
            coerced.append(v)
        grid.append(coerced)
    return grid


def _find_conflicts(grid):
    """Cells whose value duplicates another in the same row, column, or 3x3 box.

    Zeros are ignored. Pure structural check, no solver call. Both members of
    a duplicate pair are flagged so the frontend can highlight either end.
    """
    conflicts = set()

    for r in range(9):
        seen = {}
        for c in range(9):
            v = grid[r][c]
            if v == 0:
                continue
            if v in seen:
                conflicts.add((r, c))
                conflicts.add((r, seen[v]))
            else:
                seen[v] = c

    for c in range(9):
        seen = {}
        for r in range(9):
            v = grid[r][c]
            if v == 0:
                continue
            if v in seen:
                conflicts.add((r, c))
                conflicts.add((seen[v], c))
            else:
                seen[v] = r

    for br in (0, 3, 6):
        for bc in (0, 3, 6):
            seen = {}
            for dr in range(3):
                for dc in range(3):
                    r, c = br + dr, bc + dc
                    v = grid[r][c]
                    if v == 0:
                        continue
                    if v in seen:
                        conflicts.add((r, c))
                        conflicts.add(seen[v])
                    else:
                        seen[v] = (r, c)

    return [[r, c] for (r, c) in sorted(conflicts)]


# ---------------------------- Backtracking (sudoku generation only) ----------------------------
#
# These helpers are used ONLY for random sudoku generation:
#   _backtrack_fill   - produce a complete random valid grid to start from
#   _has_unique_sol   - verify a generated sudoku has exactly one solution
#
# The actual /solve, /check, /hint endpoints still use the SAT encoding in
# template.py. Backtracking here is a generation utility, not a competing
# Sudoku solver.

def _is_placement_valid(grid, r, c, v):
    for i in range(9):
        if grid[r][i] == v or grid[i][c] == v:
            return False
    br, bc = (r // 3) * 3, (c // 3) * 3
    for dr in range(3):
        for dc in range(3):
            if grid[br + dr][bc + dc] == v:
                return False
    return True


def _backtrack_fill(grid):
    """Fill in-place starting from the first empty cell. Random digit order
    yields a different valid grid every run."""
    for r in range(9):
        for c in range(9):
            if grid[r][c] == 0:
                digits = list(range(1, 10))
                random.shuffle(digits)
                for v in digits:
                    if _is_placement_valid(grid, r, c, v):
                        grid[r][c] = v
                        if _backtrack_fill(grid):
                            return True
                        grid[r][c] = 0
                return False
    return True


def _count_solutions_upto(grid, limit=2):
    """Backtracking solution counter with early termination at `limit`. Used
    to verify uniqueness during sudoku generation; not exposed via the API."""
    grid = [row[:] for row in grid]
    count = [0]

    def candidates_for(r, c):
        return [v for v in range(1, 10) if _is_placement_valid(grid, r, c, v)]

    def next_empty_with_fewest_candidates():
        best = None
        best_candidates = None
        for r in range(9):
            for c in range(9):
                if grid[r][c] == 0:
                    candidates = candidates_for(r, c)
                    if not candidates:
                        return (r, c), []
                    if best is None or len(candidates) < len(best_candidates):
                        best = (r, c)
                        best_candidates = candidates
        return best, best_candidates

    def backtrack():
        if count[0] >= limit:
            return
        pos, candidates = next_empty_with_fewest_candidates()
        if pos is None:
            count[0] += 1
            return
        if not candidates:
            return

        r, c = pos
        for v in candidates:
            grid[r][c] = v
            backtrack()
            grid[r][c] = 0
            if count[0] >= limit:
                return

    backtrack()
    return count[0]


def _has_unique_solution(grid):
    return _count_solutions_upto(grid, limit=2) == 1


def _generate_puzzle(difficulty):
    """Fill a random complete grid, then symmetrically remove pairs of cells
    while preserving solution uniqueness. Returns (puzzle, solution, clue_count).
    """
    target = DIFFICULTY_CLUES[difficulty]

    solution = [[0] * 9 for _ in range(9)]
    _backtrack_fill(solution)

    pairs = []
    seen = set()
    for r in range(9):
        for c in range(9):
            if (r, c) in seen:
                continue
            partner = (8 - r, 8 - c)
            seen.add((r, c))
            seen.add(partner)
            pairs.append(((r, c), partner))
    random.shuffle(pairs)

    puzzle = [row[:] for row in solution]
    clue_count = 81
    for (p1, p2) in pairs:
        if clue_count <= target:
            break
        saved = [(p1, puzzle[p1[0]][p1[1]])]
        puzzle[p1[0]][p1[1]] = 0
        if p1 != p2:
            saved.append((p2, puzzle[p2[0]][p2[1]]))
            puzzle[p2[0]][p2[1]] = 0

        if len(saved) > clue_count - target:
            for (pos, val) in saved:
                puzzle[pos[0]][pos[1]] = val
            continue

        if _has_unique_solution(puzzle):
            clue_count -= len(saved)
        else:
            # Multi-solution after removal - restore and try a different pair.
            for (pos, val) in saved:
                puzzle[pos[0]][pos[1]] = val

    # Symmetric removal can get stuck above the requested target. Finish with
    # single-cell removals so the selected difficulty maps to the intended clue
    # count when uniqueness allows it.
    while clue_count > target:
        progress = False
        cells = [(r, c) for r in range(9) for c in range(9) if puzzle[r][c] != 0]
        random.shuffle(cells)
        for r, c in cells:
            if clue_count <= target:
                break
            saved = puzzle[r][c]
            puzzle[r][c] = 0
            if _has_unique_solution(puzzle):
                clue_count -= 1
                progress = True
            else:
                puzzle[r][c] = saved
        if not progress:
            break

    return puzzle, solution, clue_count


# ---------------------------- Solver wrapper ----------------------------

def _solve_with_temp(grid, timeout_s=30):
    """Call solveBoard with a per-request temp CNF file.

    SOLVER_LOCK serializes calls because template.py mutates module globals
    during encoding. redirect_stdout swallows getDimacsHeader's print noise
    (the function is annotated "do not modify" so we redirect from outside).
    """
    fd, path = tempfile.mkstemp(suffix=".cnf", prefix="sudoku_")
    os.close(fd)
    try:
        with SOLVER_LOCK, contextlib.redirect_stdout(io.StringIO()):
            return solveBoard(grid, cnf_path=path, timeout_s=timeout_s)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# ---------------------------- Routes ----------------------------

@app.route("/")
def index():
    return render_template("landing.html")


@app.route("/play")
def play():
    return render_template("sudoku.html")


@app.route("/solver")
def solver():
    return render_template("solver.html")


@app.get("/landing-preview")
def landing_preview():
    """Lightweight payload for the landing page: top 3 finishers per difficulty,
    current week. Skips disqualified rows. Used by anonymous + logged-in visitors.
    """
    week_id = _current_week_id()
    conn = _db_connect()
    try:
        out = {"week_id": week_id, "previews": {}}
        for diff in WEEKLY_DIFFICULTIES:
            rows = conn.execute(
                """SELECT users.username, weekly_attempts.elapsed_ms, weekly_attempts.completed_at
                   FROM weekly_attempts
                   JOIN users ON users.id = weekly_attempts.user_id
                   WHERE weekly_attempts.week_id = ?
                     AND weekly_attempts.difficulty = ?
                     AND weekly_attempts.disqualified = 0
                     AND weekly_attempts.completed_at IS NOT NULL
                     AND users.deleted_at IS NULL
                   ORDER BY weekly_attempts.elapsed_ms ASC,
                            weekly_attempts.completed_at ASC
                   LIMIT 3""",
                (week_id, diff),
            ).fetchall()
            out["previews"][diff] = [
                {"username": r["username"], "elapsed_ms": r["elapsed_ms"]}
                for r in rows
            ]
        return jsonify({"success": True, **out})
    finally:
        conn.close()


@app.post("/solve")
def solve():
    try:
        payload = request.get_json(force=True)
        grid = _grid_from_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid board: {exc}"}), 400

    puzzle_id = payload.get("puzzle_id") if isinstance(payload, dict) else None
    user = _current_user()
    disqualified = False
    if user and puzzle_id:
        disqualified = _mark_active_weekly_disqualified(user["id"], puzzle_id)

    started = time.time()
    try:
        solution = _solve_with_temp(grid)
    except TimeoutExpired:
        return jsonify({"success": False, "message": "Solver timed out"}), 504
    except SystemExit:
        # solveBoard calls sys.exit(1) if z3 isn't on PATH.
        return jsonify({"success": False, "message": "SAT solver (z3) not available on the server"}), 500
    elapsed_ms = int((time.time() - started) * 1000)

    if solution is not None:
        resp = {
            "success": True,
            "solution": solution,
            "puzzle_id": puzzle_id,
            "elapsed_ms": elapsed_ms,
            "fallback_used": False,
        }
        if disqualified:
            resp["disqualified"] = True
            resp["message"] = "This attempt is now disqualified from the weekly leaderboard."
        return jsonify(resp)

    # UNSAT. If we have the original clues cached, retry from them so the user
    # still sees a useful answer (their entries were the inconsistency).
    cached = _load_puzzle(puzzle_id)
    if cached is not None:
        try:
            fallback = _solve_with_temp(cached["clues"])
        except TimeoutExpired:
            return jsonify({"success": False, "message": "Solver timed out"}), 504
        if fallback is not None:
            return jsonify({
                "success": True,
                "solution": fallback,
                "puzzle_id": puzzle_id,
                "elapsed_ms": int((time.time() - started) * 1000),
                "fallback_used": True,
                "message": "Your entries conflicted with the sudoku; showing the canonical solution.",
            })

    return jsonify({"success": False, "message": "Sudoku is unsolvable"})


@app.post("/check")
def check():
    try:
        payload = request.get_json(force=True)
        grid = _grid_from_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid board: {exc}"}), 400

    puzzle_id = payload.get("puzzle_id") if isinstance(payload, dict) else None
    cached = _load_puzzle(puzzle_id)

    if cached is not None:
        solution = cached["solution"]
    else:
        # No cached sudoku - re-solve to get a reference. Empty cells in the
        # user grid are fine; the solver completes them.
        try:
            solution = _solve_with_temp(grid)
        except TimeoutExpired:
            return jsonify({"success": False, "message": "Solver timed out"}), 504
        except SystemExit:
            return jsonify({"success": False, "message": "SAT solver (z3) not available"}), 500
        if solution is None:
            return jsonify({"success": False, "message": "Current grid has no valid completion"})

    correct, wrong = [], []
    complete = True
    for r in range(9):
        for c in range(9):
            v = grid[r][c]
            if v == 0:
                complete = False
                continue
            if v == solution[r][c]:
                correct.append([r, c])
            else:
                wrong.append([r, c])
                complete = False

    return jsonify({
        "success": True,
        "complete": complete,
        "correct_cells": correct,
        "wrong_cells": wrong,
    })


@app.post("/hint")
def hint():
    try:
        payload = request.get_json(force=True)
        grid = _grid_from_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid board: {exc}"}), 400

    puzzle_id = payload.get("puzzle_id") if isinstance(payload, dict) else None
    user = _current_user()
    disqualified = False
    if user and puzzle_id:
        disqualified = _mark_active_weekly_disqualified(user["id"], puzzle_id)
    cached = _load_puzzle(puzzle_id)

    if cached is not None:
        solution = cached["solution"]
    else:
        try:
            solution = _solve_with_temp(grid)
        except TimeoutExpired:
            return jsonify({"success": False, "message": "Solver timed out"}), 504
        except SystemExit:
            return jsonify({"success": False, "message": "SAT solver (z3) not available"}), 500
        if solution is None:
            return jsonify({"success": False, "message": "Sudoku is unsolvable"})

    empties = [(r, c) for r in range(9) for c in range(9) if grid[r][c] == 0]
    if not empties:
        return jsonify({"success": False, "message": "Sudoku is already complete"})

    r, c = random.choice(empties)
    resp = {"success": True, "row": r, "col": c, "value": solution[r][c]}
    if disqualified:
        resp["disqualified"] = True
        resp["message"] = "This attempt is now disqualified from the weekly leaderboard."
    return jsonify(resp)


@app.post("/validate")
def validate():
    try:
        payload = request.get_json(force=True)
        grid = _grid_from_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid board: {exc}"}), 400
    return jsonify({"success": True, "conflicts": _find_conflicts(grid)})


@app.post("/generate")
def generate():
    payload = request.get_json(silent=True) or {}
    difficulty = payload.get("difficulty", "medium")
    if difficulty not in DIFFICULTY_CLUES:
        return jsonify({"success": False, "message": "Invalid difficulty"}), 400

    puzzle, solution, clue_count = _generate_puzzle(difficulty)
    pid = str(uuid.uuid4())
    _save_puzzle(pid, puzzle, solution, difficulty)

    return jsonify({
        "success": True,
        "board": puzzle,
        "puzzle_id": pid,
        "difficulty": difficulty,
        "clue_count": clue_count,
    })


# ---------------------------- Auth routes ----------------------------

@app.post("/auth/register")
def auth_register():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""

    ok, msg = _validate_username(username)
    if not ok:
        return jsonify({"success": False, "message": msg}), 400
    ok, msg = _validate_email(email)
    if not ok:
        return jsonify({"success": False, "message": msg}), 400
    ok, msg = _validate_password(password)
    if not ok:
        return jsonify({"success": False, "message": msg}), 400

    uid = str(uuid.uuid4())
    pw_hash = generate_password_hash(password)
    conn = _db_connect()
    try:
        try:
            conn.execute(
                "INSERT INTO users (id, username, username_lower, email, password_hash, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (uid, username, username.lower(), email, pw_hash, time.time()),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            existing = conn.execute(
                "SELECT username_lower, email FROM users WHERE username_lower = ? OR email = ?",
                (username.lower(), email),
            ).fetchone()
            if existing and existing["username_lower"] == username.lower():
                return jsonify({"success": False, "message": "username already taken"}), 409
            return jsonify({"success": False, "message": "email already registered"}), 409
        row = conn.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?", (uid,)
        ).fetchone()
    finally:
        conn.close()

    session.clear()
    session["user_id"] = uid
    session.permanent = True
    return jsonify({"success": True, "user": _format_user(row)})


@app.post("/auth/login")
def auth_login():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip().lower()
    password = payload.get("password") or ""
    if not username or not password:
        return jsonify({"success": False, "message": "username and password required"}), 400

    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT id, username, password_hash, created_at, deleted_at "
            "FROM users WHERE username_lower = ?",
            (username,),
        ).fetchone()
    finally:
        conn.close()

    if row is None or row["deleted_at"] is not None or not row["password_hash"]:
        return jsonify({"success": False, "message": "invalid credentials"}), 401
    if not check_password_hash(row["password_hash"], password):
        return jsonify({"success": False, "message": "invalid credentials"}), 401

    session.clear()
    session["user_id"] = row["id"]
    session.permanent = True
    return jsonify({"success": True, "user": _format_user(row)})


@app.post("/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"success": True})


@app.get("/auth/me")
def auth_me():
    user = _current_user()
    return jsonify({"success": True, "user": _format_user(user) if user else None})


@app.post("/auth/change-password")
@require_auth
def auth_change_password(user):
    payload = request.get_json(silent=True) or {}
    old_pw = payload.get("old") or ""
    new_pw = payload.get("new") or ""
    ok, msg = _validate_password(new_pw)
    if not ok:
        return jsonify({"success": False, "message": msg}), 400

    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        if row is None or not row["password_hash"] or not check_password_hash(row["password_hash"], old_pw):
            return jsonify({"success": False, "message": "current password incorrect"}), 401
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(new_pw), user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"success": True})


@app.post("/auth/delete-account")
@require_auth
def auth_delete_account(user):
    payload = request.get_json(silent=True) or {}
    password = payload.get("password") or ""

    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
        if row is None or not row["password_hash"] or not check_password_hash(row["password_hash"], password):
            return jsonify({"success": False, "message": "password incorrect"}), 401
        conn.execute(
            "UPDATE users SET deleted_at = ?, username = ?, username_lower = ?, "
            "email = NULL, password_hash = NULL WHERE id = ?",
            (time.time(), "[deleted user]", f"__deleted_{user['id']}__", user["id"]),
        )
        conn.execute(
            "DELETE FROM password_reset_tokens WHERE user_id = ?", (user["id"],)
        )
        conn.commit()
    finally:
        conn.close()
    session.clear()
    return jsonify({"success": True})


@app.post("/auth/forgot-password")
def auth_forgot_password():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    # Always answer the same way to avoid email enumeration.
    generic = jsonify({
        "success": True,
        "message": "If that email is registered, a reset link is on its way.",
    })
    if not email:
        return generic

    conn = _db_connect()
    try:
        user_row = conn.execute(
            "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", (email,)
        ).fetchone()
        if user_row is None:
            return generic
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_row["id"], time.time() + RESET_TOKEN_TTL_SECONDS),
        )
        conn.commit()
    finally:
        conn.close()

    base = os.environ.get("SUDOKU_BASE_URL", "http://127.0.0.1:5000").rstrip("/")
    _send_reset_email(email, f"{base}/reset-password?token={token}")
    return generic


@app.post("/auth/reset-password")
def auth_reset_password():
    payload = request.get_json(silent=True) or {}
    token = payload.get("token") or ""
    new_pw = payload.get("new_password") or ""
    ok, msg = _validate_password(new_pw)
    if not ok:
        return jsonify({"success": False, "message": msg}), 400

    conn = _db_connect()
    try:
        row = conn.execute(
            "SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token = ?",
            (token,),
        ).fetchone()
        if row is None or row["used_at"] is not None or row["expires_at"] < time.time():
            return jsonify({"success": False, "message": "reset link is invalid or expired"}), 400
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at IS NULL",
            (generate_password_hash(new_pw), row["user_id"]),
        )
        conn.execute(
            "UPDATE password_reset_tokens SET used_at = ? WHERE token = ?",
            (time.time(), token),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"success": True})


@app.get("/reset-password")
def reset_password_page():
    return render_template("reset_password.html", token=request.args.get("token", ""))


# ---------------------------- Weekly competition routes ----------------------------

@app.get("/weekly")
def weekly_page():
    return render_template("weekly.html")


@app.get("/weekly/<difficulty>")
@require_auth
def weekly_get(user, difficulty):
    if difficulty not in WEEKLY_DIFFICULTIES:
        return jsonify({"success": False, "message": "Invalid difficulty"}), 400
    week_id = _current_week_id()
    puzzle = _get_or_create_weekly_puzzle(week_id, difficulty)

    conn = _db_connect()
    try:
        attempt_row = _load_attempt(conn, user["id"], week_id, difficulty)
    finally:
        conn.close()

    return jsonify({
        "success": True,
        "puzzle_id": puzzle["id"],
        "board": puzzle["clues"],
        "week_id": week_id,
        "difficulty": difficulty,
        "attempt": _attempt_status(attempt_row),
    })


@app.post("/weekly/start")
@require_auth
def weekly_start(user):
    payload = request.get_json(silent=True) or {}
    difficulty = payload.get("difficulty")
    if difficulty not in WEEKLY_DIFFICULTIES:
        return jsonify({"success": False, "message": "Invalid difficulty"}), 400
    week_id = _current_week_id()
    puzzle = _get_or_create_weekly_puzzle(week_id, difficulty)

    conn = _db_connect()
    try:
        # Idempotent: if a row already exists, leave it alone — never reset the clock.
        conn.execute(
            "INSERT OR IGNORE INTO weekly_attempts "
            "(user_id, week_id, difficulty, puzzle_id, started_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (user["id"], week_id, difficulty, puzzle["id"], time.time()),
        )
        conn.commit()
        attempt_row = _load_attempt(conn, user["id"], week_id, difficulty)
    finally:
        conn.close()

    return jsonify({
        "success": True,
        "puzzle_id": puzzle["id"],
        "board": puzzle["clues"],
        "week_id": week_id,
        "difficulty": difficulty,
        "attempt": _attempt_status(attempt_row),
    })


@app.post("/weekly/save-grid")
@require_auth
def weekly_save_grid(user):
    payload = request.get_json(silent=True) or {}
    difficulty = payload.get("difficulty")
    if difficulty not in WEEKLY_DIFFICULTIES:
        return jsonify({"success": False, "message": "Invalid difficulty"}), 400
    try:
        grid = _grid_from_payload({"board": payload.get("grid")})
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid grid: {exc}"}), 400

    week_id = _current_week_id()
    conn = _db_connect()
    try:
        row = _load_attempt(conn, user["id"], week_id, difficulty)
        if row is None or row["completed_at"] is not None:
            # No active attempt to autosave to — silently no-op so the frontend
            # doesn't have to special-case the post-completion state.
            return jsonify({"success": True, "saved": False})
        conn.execute(
            "UPDATE weekly_attempts SET grid_state_json = ? WHERE id = ?",
            (json.dumps(grid), row["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"success": True, "saved": True})


@app.post("/weekly/submit")
@require_auth
def weekly_submit(user):
    payload = request.get_json(silent=True) or {}
    difficulty = payload.get("difficulty")
    if difficulty not in WEEKLY_DIFFICULTIES:
        return jsonify({"success": False, "message": "Invalid difficulty"}), 400
    try:
        board = _grid_from_payload({"board": payload.get("board")})
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid board: {exc}"}), 400

    week_id = _current_week_id()
    conn = _db_connect()
    try:
        row = _load_attempt(conn, user["id"], week_id, difficulty)
        if row is None:
            return jsonify({"success": False, "message": "Start the attempt first"}), 400
        if row["completed_at"] is not None:
            return jsonify({"success": False, "message": "Already completed"}), 409

        puzzle_row = conn.execute(
            "SELECT solution_json FROM weekly_puzzles WHERE id = ?", (row["puzzle_id"],)
        ).fetchone()
        if puzzle_row is None:
            return jsonify({"success": False, "message": "Sudoku missing"}), 500
        solution = json.loads(puzzle_row["solution_json"])

        wrong_cells = []
        complete = True
        for r in range(9):
            for c in range(9):
                v = board[r][c]
                if v == 0:
                    complete = False
                    continue
                if v != solution[r][c]:
                    wrong_cells.append([r, c])
        if not complete:
            return jsonify({
                "success": False,
                "complete": False,
                "wrong_cells": wrong_cells,
                "message": "Board is incomplete.",
            })
        if wrong_cells:
            return jsonify({
                "success": False,
                "complete": True,
                "wrong_cells": wrong_cells,
                "message": "Some cells are wrong.",
            })

        now = time.time()
        elapsed_ms = int((now - row["started_at"]) * 1000)
        conn.execute(
            "UPDATE weekly_attempts SET completed_at = ?, elapsed_ms = ?, grid_state_json = NULL "
            "WHERE id = ?",
            (now, elapsed_ms, row["id"]),
        )
        conn.commit()

        rank = None
        if not row["disqualified"]:
            faster = conn.execute(
                """SELECT COUNT(*) AS c FROM weekly_attempts
                   WHERE week_id = ? AND difficulty = ?
                     AND disqualified = 0
                     AND completed_at IS NOT NULL
                     AND (elapsed_ms < ?
                          OR (elapsed_ms = ? AND completed_at < ?))""",
                (week_id, difficulty, elapsed_ms, elapsed_ms, now),
            ).fetchone()
            rank = (faster["c"] if faster else 0) + 1
    finally:
        conn.close()

    return jsonify({
        "success": True,
        "complete": True,
        "elapsed_ms": elapsed_ms,
        "rank": rank,
        "disqualified": bool(row["disqualified"]),
    })


@app.get("/leaderboard")
def leaderboard_page():
    return render_template("leaderboard.html")


@app.get("/profile/<username>")
def profile_page(username):
    return render_template("profile.html", username=username)


@app.get("/api/profile/<username>")
def profile_api(username):
    if not username:
        return jsonify({"success": False, "message": "username required"}), 400
    conn = _db_connect()
    try:
        user = conn.execute(
            "SELECT id, username, created_at, deleted_at FROM users WHERE username_lower = ?",
            (username.lower(),),
        ).fetchone()
        if user is None or user["deleted_at"] is not None:
            return jsonify({"success": False, "message": "user not found"}), 404

        completed_rows = conn.execute(
            """SELECT week_id, difficulty, elapsed_ms, completed_at
               FROM weekly_attempts
               WHERE user_id = ?
                 AND completed_at IS NOT NULL
                 AND disqualified = 0
               ORDER BY completed_at DESC""",
            (user["id"],),
        ).fetchall()
        total_completed = len(completed_rows)

        best_per_difficulty = dict.fromkeys(WEEKLY_DIFFICULTIES)
        for r in completed_rows:
            d = r["difficulty"]
            if d not in best_per_difficulty:
                continue
            cur_best = best_per_difficulty[d]
            if cur_best is None or r["elapsed_ms"] < cur_best:
                best_per_difficulty[d] = r["elapsed_ms"]

        recent_rows = completed_rows[:5]
        recent = []
        for r in recent_rows:
            faster = conn.execute(
                """SELECT COUNT(*) AS c FROM weekly_attempts
                   WHERE week_id = ? AND difficulty = ?
                     AND disqualified = 0 AND completed_at IS NOT NULL
                     AND (elapsed_ms < ?
                          OR (elapsed_ms = ? AND completed_at < ?))""",
                (r["week_id"], r["difficulty"], r["elapsed_ms"], r["elapsed_ms"], r["completed_at"]),
            ).fetchone()
            recent.append({
                "week_id": r["week_id"],
                "difficulty": r["difficulty"],
                "elapsed_ms": r["elapsed_ms"],
                "completed_at": r["completed_at"],
                "rank": (faster["c"] if faster else 0) + 1,
            })
    finally:
        conn.close()

    return jsonify({
        "success": True,
        "username": user["username"],
        "created_at": user["created_at"],
        "total_completed": total_completed,
        "best_per_difficulty": best_per_difficulty,
        "recent": recent,
    })


@app.get("/weekly/leaderboard/<difficulty>")
def weekly_leaderboard(difficulty):
    if difficulty not in WEEKLY_DIFFICULTIES:
        return jsonify({"success": False, "message": "Invalid difficulty"}), 400
    week_id = _current_week_id()
    viewer = _current_user()
    viewer_id = viewer["id"] if viewer else None

    conn = _db_connect()
    try:
        top_rows = conn.execute(
            """SELECT users.username, users.deleted_at, weekly_attempts.user_id,
                      weekly_attempts.elapsed_ms, weekly_attempts.completed_at
               FROM weekly_attempts
               JOIN users ON users.id = weekly_attempts.user_id
               WHERE weekly_attempts.week_id = ?
                 AND weekly_attempts.difficulty = ?
                 AND weekly_attempts.disqualified = 0
                 AND weekly_attempts.completed_at IS NOT NULL
               ORDER BY weekly_attempts.elapsed_ms ASC,
                        weekly_attempts.completed_at ASC
               LIMIT 50""",
            (week_id, difficulty),
        ).fetchall()
        total_row = conn.execute(
            """SELECT COUNT(*) AS c FROM weekly_attempts
               WHERE week_id = ? AND difficulty = ?
                 AND disqualified = 0 AND completed_at IS NOT NULL""",
            (week_id, difficulty),
        ).fetchone()
        total_completed = total_row["c"] if total_row else 0

        entries = []
        for i, r in enumerate(top_rows):
            entries.append({
                "rank": i + 1,
                "username": r["username"],
                "deleted": r["deleted_at"] is not None,
                "elapsed_ms": r["elapsed_ms"],
                "completed_at": r["completed_at"],
                "is_self": viewer_id is not None and r["user_id"] == viewer_id,
            })

        self_outside_top = None
        if viewer_id is not None and not any(e["is_self"] for e in entries):
            self_row = conn.execute(
                """SELECT users.username, weekly_attempts.elapsed_ms, weekly_attempts.completed_at
                   FROM weekly_attempts
                   JOIN users ON users.id = weekly_attempts.user_id
                   WHERE weekly_attempts.user_id = ?
                     AND weekly_attempts.week_id = ?
                     AND weekly_attempts.difficulty = ?
                     AND weekly_attempts.disqualified = 0
                     AND weekly_attempts.completed_at IS NOT NULL""",
                (viewer_id, week_id, difficulty),
            ).fetchone()
            if self_row is not None:
                faster_row = conn.execute(
                    """SELECT COUNT(*) AS c FROM weekly_attempts
                       WHERE week_id = ? AND difficulty = ?
                         AND disqualified = 0 AND completed_at IS NOT NULL
                         AND (elapsed_ms < ?
                              OR (elapsed_ms = ? AND completed_at < ?))""",
                    (week_id, difficulty,
                     self_row["elapsed_ms"], self_row["elapsed_ms"], self_row["completed_at"]),
                ).fetchone()
                self_outside_top = {
                    "rank": (faster_row["c"] if faster_row else 0) + 1,
                    "username": self_row["username"],
                    "elapsed_ms": self_row["elapsed_ms"],
                    "completed_at": self_row["completed_at"],
                    "is_self": True,
                }
    finally:
        conn.close()

    return jsonify({
        "success": True,
        "week_id": week_id,
        "difficulty": difficulty,
        "total_completed": total_completed,
        "entries": entries,
        "self_outside_top": self_outside_top,
    })


def _mark_active_weekly_disqualified(user_id, puzzle_id):
    """If the caller has an in-progress weekly attempt against this puzzle_id,
    mark it disqualified=1. Returns True if a row was flipped."""
    if not user_id or not puzzle_id:
        return False
    conn = _db_connect()
    try:
        cur = conn.execute(
            "UPDATE weekly_attempts SET disqualified = 1 "
            "WHERE user_id = ? AND puzzle_id = ? AND completed_at IS NULL "
            "AND disqualified = 0",
            (user_id, puzzle_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


if __name__ == "__main__":
    if shutil.which("z3") is None:
        print(
            "WARNING: z3 not on PATH; /solve will fail until you run `brew install z3`.",
            file=sys.stderr,
        )
    _init_db()
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("SUDOKU_PORT", "5000")),
        threaded=True,
        debug=True,
    )
