"""Flask server wrapping the SAT-based Sudoku solver.

The SAT encoding lives in template.py and is graded as-is. This module owns
everything around it: per-request CNF temp files, concurrency lock (template.py
mutates module globals during encoding), subprocess timeout, SQLite puzzle
cache, and the JSON API the frontend talks to.

Endpoints (POST, JSON):
    /solve     - solve a board; smart-fallback to cached clues on UNSAT
    /check     - per-cell correct/wrong vs cached solution           (Phase C)
    /hint      - return one correct cell from the solver             (Phase D)
    /validate  - structural duplicate scan, no solver call           (Phase C)
    /generate  - random uniquely-solvable puzzle for chosen difficulty (Phase E)
"""

import contextlib
import io
import json
import os
import random
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from subprocess import TimeoutExpired

from flask import Flask, jsonify, render_template, request

from template import solveBoard

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "puzzles.db")
SOLVER_LOCK = threading.Lock()
DIFFICULTY_CLUES = {"easy": 40, "medium": 30, "hard": 25, "expert": 22}

# templates/ is Flask's default lookup; sudoku.html lives there now.
app = Flask(__name__, static_folder="static")


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


# ---------------------------- Backtracking (puzzle generation only) ----------------------------
#
# These helpers are used ONLY for random puzzle generation:
#   _backtrack_fill   - produce a complete random valid grid to start from
#   _has_unique_sol   - verify a generated puzzle has exactly one solution
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
    to verify uniqueness during puzzle generation; not exposed via the API."""
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
    return render_template("sudoku.html")


@app.post("/solve")
def solve():
    try:
        payload = request.get_json(force=True)
        grid = _grid_from_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "message": f"Invalid board: {exc}"}), 400

    puzzle_id = payload.get("puzzle_id") if isinstance(payload, dict) else None

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
        return jsonify({
            "success": True,
            "solution": solution,
            "puzzle_id": puzzle_id,
            "elapsed_ms": elapsed_ms,
            "fallback_used": False,
        })

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
                "message": "Your entries conflicted with the puzzle; showing the canonical solution.",
            })

    return jsonify({"success": False, "message": "Puzzle is unsolvable"})


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
        # No cached puzzle - re-solve to get a reference. Empty cells in the
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
            return jsonify({"success": False, "message": "Puzzle is unsolvable"})

    empties = [(r, c) for r in range(9) for c in range(9) if grid[r][c] == 0]
    if not empties:
        return jsonify({"success": False, "message": "Puzzle is already complete"})

    r, c = random.choice(empties)
    return jsonify({"success": True, "row": r, "col": c, "value": solution[r][c]})


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


if __name__ == "__main__":
    if shutil.which("z3") is None:
        print(
            "WARNING: z3 not on PATH; /solve will fail until you run `brew install z3`.",
            file=sys.stderr,
        )
    _init_db()
    app.run(host="127.0.0.1", port=5000, threaded=True, debug=True)
