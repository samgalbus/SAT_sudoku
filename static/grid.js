// Reusable 9x9 grid component. Used by free-play (sudoku.js) and the weekly view (weekly.js).
//
// Usage:
//   const grid = Grid.create({
//     container: document.getElementById("weeklyGrid"),
//     onChange: (board) => {},   // fires on every cell edit, board is 9x9 ints (0 = blank)
//     onComplete: (board) => {}, // fires when every cell is filled (no validation)
//   });
//   grid.applyBoard([[0,0,...],...], { lockNonZero: true });
//   grid.applyEntries(savedEntries); // [[r,c,v],...]
//   grid.readBoard();                // 9x9 ints
//   grid.markCells([[r,c],...], "wrong");
//   grid.clearMarks();

window.Grid = (function () {
  function create(opts) {
    const root = opts.container;
    const cells = [];
    const cluePositions = new Set();   // "r,c" — read-only positions
    let onChange = opts.onChange || (() => {});
    let onComplete = opts.onComplete || (() => {});

    root.classList.add("primary-grid");
    root.innerHTML = "";
    for (let r = 0; r < 9; r++) {
      cells[r] = [];
      for (let c = 0; c < 9; c++) {
        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 1;
        input.className = "cell";
        input.inputMode = "numeric";
        input.dataset.row = String(r);
        input.dataset.col = String(c);
        if (c === 2 || c === 5) input.classList.add("right");
        if (r === 2 || r === 5) input.classList.add("bottom");
        input.addEventListener("input", () => onCellInput(input, r, c));
        input.addEventListener("keydown", (e) => onCellKey(e, r, c));
        root.appendChild(input);
        cells[r][c] = input;
      }
    }

    function onCellInput(input, r, c) {
      input.value = input.value.replace(/[^1-9]/g, "");
      clearMark(r, c);
      const board = readBoard();
      onChange(board, r, c);
      if (board.every(row => row.every(v => v !== 0))) onComplete(board);
    }

    function onCellKey(e, r, c) {
      if (e.key === "ArrowRight") { focusCell(r, (c + 1) % 9); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { focusCell(r, (c + 8) % 9); e.preventDefault(); }
      else if (e.key === "ArrowDown") { focusCell((r + 1) % 9, c); e.preventDefault(); }
      else if (e.key === "ArrowUp") { focusCell((r + 8) % 9, c); e.preventDefault(); }
      else if ((e.key === "Backspace" || e.key === "Delete") && !cells[r][c].readOnly) {
        cells[r][c].value = "";
        clearMark(r, c);
        onChange(readBoard(), r, c);
      }
    }

    function focusCell(r, c) { cells[r][c].focus(); }

    function applyBoard(board, options = {}) {
      cluePositions.clear();
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const cell = cells[r][c];
          cell.readOnly = false;
          cell.classList.remove("clue", "hint", "user", "correct", "wrong", "conflict");
          const v = board[r][c] || 0;
          cell.value = v === 0 ? "" : String(v);
          if (options.lockNonZero && v !== 0) {
            cell.readOnly = true;
            cell.classList.add("clue");
            cluePositions.add(`${r},${c}`);
          }
        }
      }
    }

    function applyEntries(entries) {
      if (!Array.isArray(entries)) return;
      for (const [r, c, v] of entries) {
        if (cluePositions.has(`${r},${c}`)) continue;
        if (v && cells[r] && cells[r][c]) cells[r][c].value = String(v);
      }
    }

    function readBoard() {
      const out = [];
      for (let r = 0; r < 9; r++) {
        const row = [];
        for (let c = 0; c < 9; c++) {
          const v = cells[r][c].value;
          row.push(v ? parseInt(v, 10) : 0);
        }
        out.push(row);
      }
      return out;
    }

    function markCells(positions, kind) {
      for (const [r, c] of positions) {
        if (cells[r] && cells[r][c]) cells[r][c].classList.add(kind);
      }
    }

    function clearMark(r, c) {
      cells[r][c].classList.remove("correct", "wrong", "conflict");
    }

    function clearMarks() {
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) clearMark(r, c);
      }
    }

    function setReadOnly(flag) {
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          if (cluePositions.has(`${r},${c}`)) continue;
          cells[r][c].readOnly = !!flag;
        }
      }
    }

    return {
      applyBoard,
      applyEntries,
      readBoard,
      markCells,
      clearMarks,
      setReadOnly,
      focusCell,
    };
  }

  return { create };
})();
