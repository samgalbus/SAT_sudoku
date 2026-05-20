from flask import Flask, render_template, request, jsonify
from template import solveBoard

app = Flask(__name__, template_folder='.')

@app.route('/')
def index():
    return render_template("sudoku.html")

@app.route('/solve', methods=['POST'])
def solve():
    data = request.get_json()
    board = data.get('board')

    grid = []
    for row in board:
        grid.append([int(cell) if cell else 0 for cell in row])
    
    result = solveBoard(grid)
    
    if result is None:
        return jsonify({'success': False, 'message': 'Puzzle is unsolvable'})
    
    return jsonify({'success': True, 'solution': result})

if __name__ == '__main__':
    app.run()