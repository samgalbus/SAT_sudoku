# Sudoku SAT Solver

USI 2026 Theory of Computation project.

This is a Flask web app for solving Sudoku with a SAT encoding. The Sudoku
constraints are written as Boolean clauses in DIMACS CNF and solved by `z3`.
The web layer adds a browser UI, generated puzzles, account support, and a
weekly leaderboard.

## Main Files

- `template.py`: SAT variable mapping, clause generation, DIMACS output, z3 call,
  and the original command-line interface.
- `app.py`: Flask routes, SQLite storage, sessions, generated puzzles, and the
  wrapper around `solveBoard`.
- `templates/`: Jinja templates for the pages.
- `static/`: JavaScript and CSS for the browser UI.

## Setup

Install z3 first:

```sh
brew install z3
```

Then create a Python environment and install the requirements:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

The local server runs at <http://127.0.0.1:5000> by default.

## SAT Encoding

For each row `r`, column `c`, and number `n`, the encoding uses a Boolean
variable:

```text
X(r,c,n)
```

For a standard 9x9 Sudoku this gives 729 variables. The fixed constraints are:

- each cell contains at least one number
- each cell contains at most one number
- a number appears at most once in each row
- a number appears at most once in each column
- a number appears at most once in each 3x3 box

Given cells are added as unit clauses. If z3 returns a satisfying assignment,
the positive `X(r,c,n)` variables are converted back into a 9x9 grid.

## Web Features

- solve a typed or pasted Sudoku
- generate puzzles at four clue counts: easy 40, medium 30, hard 25, expert 22
- check entries against the stored solution for generated puzzles
- request hints during normal play
- save the current puzzle in browser storage
- optional account login and weekly leaderboard

Puzzle generation uses backtracking to create a full grid and to check
uniqueness after removing clues. The solving endpoint still uses the SAT
encoding in `template.py`.

## API

All endpoints use JSON. Boards are 9x9 arrays of integers, with `0` for an
empty cell.

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /solve` | `{board, puzzle_id?}` | solved grid or an error |
| `POST /check` | `{board, puzzle_id?}` | correct and wrong cell positions |
| `POST /hint` | `{board, puzzle_id?}` | one row, column, and value |
| `POST /validate` | `{board}` | duplicate conflicts in rows, columns, and boxes |
| `POST /generate` | `{difficulty}` | generated puzzle and puzzle id |

## Command Line

The original CLI remains available:

```sh
python3 template.py input.txt output.txt
```

Both files use 9 lines of 9 digits. Use `0` for empty cells in the input.

## Notes

- The server expects `z3` to be available on `PATH`.
- `puzzles.db` is created automatically for local storage.
- Hints are limited in the browser UI. The `/hint` endpoint itself does not
  enforce that limit.
