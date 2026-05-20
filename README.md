# Sudoku SAT Solver

A web-based Sudoku solver and sudoku generator. The solving engine encodes
Sudoku as a Boolean satisfiability problem and dispatches the resulting DIMACS
CNF to the **z3** SAT solver via subprocess — no arithmetic constraints, no
third-party Sudoku solver, just pure propositional SAT.

> USI 2026 Theory of Computation project.

## Architecture

```
+-------------------+  fetch JSON   +------------------+   subprocess   +-----+
|  Browser          | <-----------> |  Flask (app.py)  | <------------> | z3  |
|  templates/       |               |                  |    DIMACS      +-----+
|  sudoku.html      |               |  template.py     |
|  static/*.js,*.css|               |  (SAT encoding)  |
+-------------------+               +------------------+
                                            |
                                            | SQLite
                                            v
                                    +------------------+
                                    |  puzzles.db      |
                                    |  (id -> clues +  |
                                    |   solution)      |
                                    +------------------+
```

- `template.py` — SAT encoding (variables, clauses, DIMACS emission, z3 dispatch).
  Includes the original CLI: `python3 template.py input.txt output.txt`.
- `app.py` — Flask server: serves the page, wraps `solveBoard` with per-request
  CNF temp files, a global lock, subprocess timeout, and a SQLite cache for
  sudokus created by `/generate`.
- `templates/sudoku.html` — page markup (dual-grid layout + settings + tutorial).
- `static/sudoku.js` — all UI behavior in vanilla JS (no build step).
- `static/sudoku.css` — themed with CSS custom properties.

## Setup

```sh
# 1. Install the SAT solver
brew install z3            # macOS; Linux: apt install z3 or download release zip

# 2. Set up the Python environment
cd SAT_sudoku
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Run the server
python app.py              # listens on http://127.0.0.1:5000
```

Open <http://127.0.0.1:5000> in a browser.

## Features

- **Dual-grid view** — the left grid is your editable sudoku; after pressing
  **Solve** the canonical solution appears on the right for side-by-side
  comparison. Your attempt is preserved.
- **Generate** — random, **uniqueness-verified** sudokus at four difficulty
  levels (Easy = 40 clues, Medium = 30, Hard = 25, Expert = 22). Uses
  symmetric clue removal for a polished look.
- **Smart-fallback solve** — if your entries conflict with the sudoku, Solve
  detects the UNSAT, retries from the cached clues, and tells you.
- **Check** — per-cell correctness against the cached solution. Highlights
  correct cells green and wrong cells red. Records your time when complete.
- **Hint** — reveals one correct cell, locked so it can't be erased. Three
  hints per sudoku, refilled on each new game.
- **Live error detection** (toggleable) — debounced 200ms server-side
  structural duplicate scan, outlines conflicting cells in red.
- **Paste / upload** — accepts any 9-line `.txt` matrix (digits 0-9, 0 = empty).
- **EN / IT i18n** — toggle in Settings; all UI text is translated.
- **Tutorial overlay** — 4-step walkthrough on first load. Restartable from
  Settings.
- **Resume on reload** — your sudoku, clues, hints, entries, and elapsed time
  are saved to `localStorage` and restored if you close and reopen the tab.
- **Keyboard navigation** — arrow keys, Tab/Shift-Tab, 1-9 to type, Backspace
  to erase.
- **Timer** — starts on New Game, stops when Check confirms completion.

## API

All endpoints accept and return JSON. Grids are 9×9 of integers 0-9 (0 = empty).

| Endpoint        | Body                          | Returns                                                                                |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `POST /solve`   | `{board, puzzle_id?}`         | `{success, solution, puzzle_id, elapsed_ms, fallback_used}` or `{success:false, …}`     |
| `POST /check`   | `{board, puzzle_id?}`         | `{success, complete, correct_cells, wrong_cells}`                                       |
| `POST /hint`    | `{board, puzzle_id?}`         | `{success, row, col, value}` or `{success:false, …}`                                    |
| `POST /validate`| `{board}`                     | `{success, conflicts}` — no solver call, pure structural duplicate scan                 |
| `POST /generate`| `{difficulty}`                | `{success, board, puzzle_id, difficulty, clue_count}`                                   |

## SAT encoding (template.py)

Variables: `X(r,c,n)` for `r,c,n ∈ {1..9}` → 729 boolean variables.

Clauses (~11,745 total):
- **Cell coverage** (81 clauses): each cell has at least one digit
- **Cell uniqueness** (2,916 clauses): each cell has at most one digit
- **Row uniqueness** (2,916 clauses): no digit repeated in a row
- **Column uniqueness** (2,916 clauses): no digit repeated in a column
- **Box uniqueness** (2,916 clauses): no digit repeated in a 3×3 box
- **Clues** (variable): unit clauses for the input digits

A model returned by z3 contains exactly 81 positive `X(r,c,n)` literals — one
per cell — which the decoder reads back into a solved grid.

## CLI

The original CLI from `template.py` still works:

```sh
python3 template.py input.txt output.txt
```

`input.txt` and `output.txt` are 9 lines of 9 digits (0 = empty).

## File layout

```
app.py                  Flask server
template.py             SAT encoding + z3 dispatch (graded portion)
requirements.txt        Flask
templates/sudoku.html   Page markup
static/sudoku.js        UI logic
static/sudoku.css       Theming
puzzles.db              SQLite cache (auto-created, gitignored)
input.txt / output.txt  CLI samples (gitignored)
```

## Known limitations

- Hint rate-limiting is enforced only on the client. A user with devtools could
  call `/hint` directly more often than 3 times per sudoku.
- Uniqueness verification during `/generate` uses a backtracking solution
  counter (not SAT) since `solveBoard` returns only one model. Generation
  alone is *not* SAT-encoded; this is consistent with the spec, which permits
  backtracking for sudoku generation.
- Resume-on-reload does not preserve `.correct`/`.wrong` decorations from a
  prior Check — they're cosmetic and will reappear on the next Check.
