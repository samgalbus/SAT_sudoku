from template import solveBoard


def parse_grid(text):
    return [[int(ch) for ch in line.strip()] for line in text.strip().splitlines()]


def is_valid_sudoku(grid):
    if len(grid) != 9 or any(len(row) != 9 for row in grid):
        return False
    digits = set(range(1, 10))
    for row in grid:
        if set(row) != digits:
            return False
    for c in range(9):
        if {grid[r][c] for r in range(9)} != digits:
            return False
    for br in (0, 3, 6):
        for bc in (0, 3, 6):
            box = {grid[br + dr][bc + dc] for dr in range(3) for dc in range(3)}
            if box != digits:
                return False
    return True


PUZZLE = parse_grid("""
400003002
092780540
030009010
609000020
070000060
050000107
060800050
025074680
700900001
""")

SOLUTION = parse_grid("""
486513972
192786543
537429816
619357428
874291365
253648197
961832754
325174689
748965231
""")


def test_solvable_puzzle_returns_valid_completed_grid():
    result = solveBoard(PUZZLE)
    assert result is not None
    assert is_valid_sudoku(result)
    for r in range(9):
        for c in range(9):
            if PUZZLE[r][c] != 0:
                assert result[r][c] == PUZZLE[r][c]


def test_contradictory_puzzle_returns_none():
    board = [[0] * 9 for _ in range(9)]
    board[0][0] = 1
    board[0][1] = 1
    assert solveBoard(board) is None


def test_already_solved_puzzle_returns_same_grid():
    assert solveBoard(SOLUTION) == SOLUTION


def test_empty_puzzle_returns_valid_completed_grid():
    board = [[0] * 9 for _ in range(9)]
    result = solveBoard(board)
    assert result is not None
    assert is_valid_sudoku(result)
