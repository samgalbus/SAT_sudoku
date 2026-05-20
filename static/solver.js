// /solver page: editable grid + POST /solve + import.
// Depends on grid.js + i18n.js + auth.js (for the toast helper).

(function () {
  const state = {
    grid: null,
    solutionCells: [],
  };

  function setStatus(msg) {
    const el = document.getElementById("solverStatus");
    if (el) el.textContent = msg || "";
  }

  function buildSolutionGrid() {
    const root = document.getElementById("solverSolutionGrid");
    root.innerHTML = "";
    for (let r = 0; r < 9; r++) {
      state.solutionCells[r] = [];
      for (let c = 0; c < 9; c++) {
        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 1;
        input.className = "cell";
        input.readOnly = true;
        input.tabIndex = -1;
        if (c === 2 || c === 5) input.classList.add("right");
        if (r === 2 || r === 5) input.classList.add("bottom");
        root.appendChild(input);
        state.solutionCells[r][c] = input;
      }
    }
  }

  function showSolutionGrid(board) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        state.solutionCells[r][c].value = String(board[r][c]);
      }
    }
    document.getElementById("solverSolutionWrap").hidden = false;
  }

  function hideSolutionGrid() {
    document.getElementById("solverSolutionWrap").hidden = true;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (state.solutionCells[r] && state.solutionCells[r][c]) {
          state.solutionCells[r][c].value = "";
        }
      }
    }
  }

  async function onSolve() {
    let board = state.grid.readBoard();
    const matrixText = document.getElementById("solverMatrix").value;
    if (!boardHasEntries(board) && matrixText.trim()) {
      const imported = parseMatrixText(matrixText);
      if (!imported) {
        const message = t("toast.invalidImport");
        hideSolutionGrid();
        setStatus(message);
        Auth.toast(message, "error", 5000);
        return;
      }
      applyImported(imported);
      board = imported;
    }

    if (!boardHasEntries(board)) {
      const message = t("toast.noSudokuInput");
      hideSolutionGrid();
      setStatus(message);
      Auth.toast(message, "error", 4500);
      return;
    }

    const button = document.getElementById("solverSolve");
    button.disabled = true;
    setStatus(t("toast.solving"));
    try {
      const { status, json } = await Auth.fetchJSON("/solve", {
        method: "POST",
        body: { board },
      });
      if (json.success) {
        showSolutionGrid(json.solution);
        Auth.toast(t("toast.solved"), "success");
        setStatus("");
      } else {
        hideSolutionGrid();
        if (status === 504) Auth.toast(t("toast.timeout"), "error");
        else if (status === 500) Auth.toast(t("toast.solverUnavailable"), "error", 6000);
        else Auth.toast(json.message || t("toast.unsolvable"), "error");
        setStatus(json.message || "");
      }
    } finally {
      button.disabled = false;
    }
  }

  function onClear() {
    state.grid.applyBoard(blankBoard(), { lockNonZero: false });
    state.grid.clearMarks();
    hideSolutionGrid();
    setStatus("");
    const ta = document.getElementById("solverMatrix");
    if (ta) ta.value = "";
    Auth.toast(t("toast.cleared"), "info", 1500);
  }

  function blankBoard() {
    return Array.from({ length: 9 }, () => Array(9).fill(0));
  }

  function boardHasEntries(board) {
    return board.some(row => row.some(value => value !== 0));
  }

  function parseMatrixText(text) {
    const cleaned = (text || "").replace(/\r/g, "").trim();
    if (!cleaned) return null;
    const rows = cleaned.split(/\s+/);
    if (rows.length !== 9) return null;
    const grid = [];
    for (const row of rows) {
      if (!/^[0-9]{9}$/.test(row)) return null;
      grid.push([...row].map(d => parseInt(d, 10)));
    }
    return grid;
  }

  function applyImported(grid) {
    state.grid.applyBoard(grid, { lockNonZero: false });
    state.grid.clearMarks();
    hideSolutionGrid();
    setStatus("");
    Auth.toast(t("toast.imported"), "success", 1500);
  }

  function onMatrixInput() {
    const text = document.getElementById("solverMatrix").value;
    if (!text.trim()) return;
    const grid = parseMatrixText(text);
    if (grid) applyImported(grid);
  }

  function onFileUpload(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const grid = parseMatrixText(e.target.result);
      if (!grid) {
        setStatus(t("toast.invalidImport"));
        Auth.toast(t("toast.invalidImport"), "error");
        return;
      }
      applyImported(grid);
    };
    reader.onerror = () => Auth.toast(t("toast.uploadError"), "error");
    reader.readAsText(file);
    ev.target.value = "";
  }

  function wire() {
    state.grid = Grid.create({
      container: document.getElementById("solverGrid"),
      onChange: () => {
        setStatus("");
      },
    });
    buildSolutionGrid();

    document.getElementById("solverSolve").addEventListener("click", onSolve);
    document.getElementById("solverClear").addEventListener("click", onClear);
    document.getElementById("solverMatrix").addEventListener("input", onMatrixInput);
    document.getElementById("solverUpload").addEventListener("change", onFileUpload);
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
