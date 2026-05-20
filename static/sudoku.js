// Sudoku SAT Solver frontend. Vanilla JS, no build step.
//
// Layout: dual grid (primary editable + solution read-only on the right).
// Network: POST JSON to /solve, /check, /hint, /validate, /generate.
// State: single module-level object; persisted to localStorage where useful.

// ============================================================
//  STATE
// ============================================================

const state = {
  cells: [],            // 9x9 of HTMLInputElement (primary, editable)
  solutionCells: [],    // 9x9 of HTMLInputElement (solution grid, read-only)
  clues: new Set(),     // "r,c" strings - cells originally given by puzzle
  hintCells: new Set(), // "r,c" strings - cells filled via Hint
  hintsUsed: 0,
  hintsMax: 3,
  difficulty: "medium",
  puzzleId: null,
  startedAt: null,      // Date.now() when timer started
  timerHandle: null,
  elapsedAtStart: 0,    // resumed elapsed ms (for restore)
  lang: "en",
  settings: {
    liveValidate: false,
    timerEnabled: true,
    tutorialSeen: false,
  },
  validateAbort: null,
  validateTimeout: null,
};

// ============================================================
//  I18N
// ============================================================

const I18N = {
  en: {
    "title": "Sudoku Solver",
    "diff.easy":   "Easy",
    "diff.medium": "Medium",
    "diff.hard":   "Hard",
    "diff.expert": "Expert",
    "btn.new":          "New Game",
    "btn.solve":        "Solve",
    "btn.check":        "Check",
    "btn.hint":         "Hint",
    "btn.clearEntries": "Clear my entries",
    "btn.clearAll":     "Clear everything",
    "section.import":   "Import puzzle",
    "section.settings": "Settings",
    "label.paste":      "Paste 9 lines:",
    "label.upload":     "Or upload .txt:",
    "label.primaryGrid":  "Your puzzle",
    "label.solutionGrid": "Solution",
    "label.time":         "Time:",
    "set.liveErrors":     "Live error detection",
    "set.timer":          "Show timer",
    "set.lang":           "Language:",
    "set.restartTutorial":"Restart tutorial",
    "toast.solved":            "Solved! Solution is shown on the right.",
    "toast.unsolvable":        "Puzzle is unsolvable.",
    "toast.timeout":           "Solver timed out.",
    "toast.fallback":          "Your entries conflicted with the puzzle — showing the canonical solution.",
    "toast.allCorrect":        "All correct! Puzzle complete.",
    "toast.partialCorrect":    (right, wrong) => `${right} cell(s) correct, ${wrong} wrong.`,
    "toast.noEntries":         "Fill in some cells first.",
    "toast.invalidImport":     "Invalid 9x9 matrix.",
    "toast.imported":          "Puzzle imported.",
    "toast.cleared":           "Grid cleared.",
    "toast.entriesCleared":    "Your entries cleared.",
    "toast.generated":         (d, n) => `New ${d} puzzle generated (${n} clues).`,
    "toast.generating":        "Generating puzzle...",
    "toast.hintsExhausted":    "No hints remaining for this puzzle.",
    "toast.hintComplete":      "Puzzle is already complete.",
    "toast.hintPlaced":        "Hint placed.",
    "toast.networkError":      "Network error.",
    "toast.solverUnavailable": "SAT solver (z3) not available on the server. Run: brew install z3",
    "toast.uploadError":       "Could not read file.",
    "tutorial.title":   "Welcome to Sudoku Solver",
    "tutorial.step1":   "Pick a difficulty and click \"New Game\" to generate a uniquely-solvable puzzle.",
    "tutorial.step2":   "Stuck? Click \"Hint\" to reveal one correct cell. You get 3 hints per puzzle.",
    "tutorial.step3":   "Click \"Check\" to see which of your entries are right (green) or wrong (red).",
    "tutorial.step4":   "Click \"Solve\" to see the canonical solution side-by-side with your attempt.",
    "tutorial.next":    "Next",
    "tutorial.prev":    "Back",
    "tutorial.done":    "Got it!",
    "tutorial.skip":    "Skip",
  },
  it: {
    "title": "Risolutore Sudoku",
    "diff.easy":   "Facile",
    "diff.medium": "Medio",
    "diff.hard":   "Difficile",
    "diff.expert": "Esperto",
    "btn.new":          "Nuova partita",
    "btn.solve":        "Risolvi",
    "btn.check":        "Controlla",
    "btn.hint":         "Suggerimento",
    "btn.clearEntries": "Cancella le mie voci",
    "btn.clearAll":     "Cancella tutto",
    "section.import":   "Importa puzzle",
    "section.settings": "Impostazioni",
    "label.paste":      "Incolla 9 righe:",
    "label.upload":     "O carica .txt:",
    "label.primaryGrid":  "Il tuo puzzle",
    "label.solutionGrid": "Soluzione",
    "label.time":         "Tempo:",
    "set.liveErrors":     "Rilevamento errori in tempo reale",
    "set.timer":          "Mostra timer",
    "set.lang":           "Lingua:",
    "set.restartTutorial":"Riavvia tutorial",
    "toast.solved":            "Risolto! La soluzione è mostrata a destra.",
    "toast.unsolvable":        "Il puzzle non è risolvibile.",
    "toast.timeout":           "Tempo scaduto.",
    "toast.fallback":          "Le tue voci sono in conflitto con il puzzle — viene mostrata la soluzione canonica.",
    "toast.allCorrect":        "Tutto corretto! Puzzle completato.",
    "toast.partialCorrect":    (right, wrong) => `${right} cella/e corrette, ${wrong} sbagliate.`,
    "toast.noEntries":         "Inserisci prima alcune celle.",
    "toast.invalidImport":     "Matrice 9x9 non valida.",
    "toast.imported":          "Puzzle importato.",
    "toast.cleared":           "Griglia pulita.",
    "toast.entriesCleared":    "Le tue voci sono state cancellate.",
    "toast.generated":         (d, n) => `Nuovo puzzle ${d} generato (${n} indizi).`,
    "toast.generating":        "Generazione puzzle in corso...",
    "toast.hintsExhausted":    "Nessun suggerimento rimasto per questo puzzle.",
    "toast.hintComplete":      "Il puzzle è già completo.",
    "toast.hintPlaced":        "Suggerimento posizionato.",
    "toast.networkError":      "Errore di rete.",
    "toast.solverUnavailable": "Risolutore SAT (z3) non disponibile sul server. Esegui: brew install z3",
    "toast.uploadError":       "Impossibile leggere il file.",
    "tutorial.title":   "Benvenuto nel Risolutore Sudoku",
    "tutorial.step1":   "Scegli una difficoltà e clicca \"Nuova partita\" per generare un puzzle a soluzione unica.",
    "tutorial.step2":   "Bloccato? Clicca \"Suggerimento\" per rivelare una cella corretta. Hai 3 suggerimenti per puzzle.",
    "tutorial.step3":   "Clicca \"Controlla\" per vedere quali voci sono giuste (verde) o sbagliate (rosso).",
    "tutorial.step4":   "Clicca \"Risolvi\" per vedere la soluzione canonica accanto al tuo tentativo.",
    "tutorial.next":    "Avanti",
    "tutorial.prev":    "Indietro",
    "tutorial.done":    "Capito!",
    "tutorial.skip":    "Salta",
  },
};

function t(key, ...args) {
  const dict = I18N[state.lang] || I18N.en;
  const val = dict[key] ?? I18N.en[key] ?? key;
  return typeof val === "function" ? val(...args) : val;
}

function applyI18n() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const text = t(key);
    if (el.tagName === "TITLE") {
      el.textContent = text;
    } else {
      el.textContent = text;
    }
  });
}

// ============================================================
//  STORAGE
// ============================================================

const STORAGE = {
  settings: "sudoku.settings",
  lastPuzzle: "sudoku.lastPuzzle",
  timesPrefix: "sudoku.times.",
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE.settings);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (e) { /* corrupt storage - ignore */ }
  // Lang lives in settings but is also a top-level field for convenience.
  state.lang = state.settings.lang || "en";
}

function saveSettings() {
  state.settings.lang = state.lang;
  try {
    localStorage.setItem(STORAGE.settings, JSON.stringify(state.settings));
  } catch (e) { /* quota - ignore */ }
}

let _saveTimer = null;
function savePuzzleState() {
  // Debounce: most callers fire on every keystroke; one write per 300ms is plenty.
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_savePuzzleStateNow, 300);
}

function _savePuzzleStateNow() {
  _saveTimer = null;
  if (!state.puzzleId && state.clues.size === 0) {
    // Nothing meaningful to restore
    try { localStorage.removeItem(STORAGE.lastPuzzle); } catch (e) {}
    return;
  }
  const elapsedMs = currentElapsedMs();
  const entries = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const key = `${r},${c}`;
      if (state.clues.has(key) || state.hintCells.has(key)) continue;
      const v = state.cells[r][c].value;
      if (v) entries.push([r, c, parseInt(v, 10)]);
    }
  }
  const data = {
    board: readGrid(),
    clues: [...state.clues],
    hintCells: [...state.hintCells],
    hintsUsed: state.hintsUsed,
    entries,
    puzzleId: state.puzzleId,
    difficulty: state.difficulty,
    elapsedMs,
  };
  try {
    localStorage.setItem(STORAGE.lastPuzzle, JSON.stringify(data));
  } catch (e) { /* quota - ignore */ }
}

function loadPuzzleState() {
  try {
    const raw = localStorage.getItem(STORAGE.lastPuzzle);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function recordTime(difficulty, ms, puzzleId) {
  const key = STORAGE.timesPrefix + difficulty;
  let arr = [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) arr = JSON.parse(raw);
  } catch (e) { arr = []; }
  arr.push({ ms, puzzleId, completedAt: Date.now() });
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
}

// ============================================================
//  TOAST
// ============================================================

function toast(message, kind = "info", ttl = 3000) {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast--fading");
    setTimeout(() => el.remove(), 250);
  }, ttl);
}

// ============================================================
//  GRID HELPERS
// ============================================================

function buildPrimaryGrid() {
  const root = document.getElementById("grid");
  root.innerHTML = "";
  for (let r = 0; r < 9; r++) {
    state.cells[r] = [];
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
      input.addEventListener("keydown", e => onCellKeyDown(e, r, c));
      root.appendChild(input);
      state.cells[r][c] = input;
    }
  }
}

function buildSolutionGrid() {
  const root = document.getElementById("solutionGrid");
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

function readGrid() {
  const grid = [];
  for (let r = 0; r < 9; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) {
      const v = state.cells[r][c].value;
      row.push(v ? parseInt(v, 10) : 0);
    }
    grid.push(row);
  }
  return grid;
}

function setCellValue(r, c, value) {
  const cell = state.cells[r][c];
  cell.value = value === 0 || value == null ? "" : String(value);
}

function setClueMode(r, c, value) {
  const cell = state.cells[r][c];
  cell.value = String(value);
  cell.readOnly = true;
  cell.classList.add("clue");
  cell.classList.remove("user", "hint", "correct", "wrong", "conflict");
  state.clues.add(`${r},${c}`);
}

function setHintMode(r, c, value) {
  const cell = state.cells[r][c];
  cell.value = String(value);
  cell.readOnly = true;
  cell.classList.add("hint");
  cell.classList.remove("clue", "correct", "wrong", "conflict");
  state.hintCells.add(`${r},${c}`);
}

function clearCellDecorations(r, c) {
  state.cells[r][c].classList.remove("correct", "wrong", "conflict");
}

function clearAllDecorations() {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      clearCellDecorations(r, c);
    }
  }
}

function showSolutionGrid(grid) {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      state.solutionCells[r][c].value = String(grid[r][c]);
    }
  }
  document.getElementById("solutionWrap").hidden = false;
}

function hideSolutionGrid() {
  document.getElementById("solutionWrap").hidden = true;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      state.solutionCells[r][c].value = "";
    }
  }
}

// ============================================================
//  NETWORK
// ============================================================

async function api(path, body, signal) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    let data;
    try {
      data = await res.json();
    } catch (e) {
      data = { success: false, message: "Bad response" };
    }
    return { status: res.status, data };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return { status: 0, data: { success: false, message: t("toast.networkError") } };
  }
}

// ============================================================
//  CELL INPUT HANDLER
// ============================================================

function onCellInput(input, r, c) {
  input.value = input.value.replace(/[^1-9]/g, "");
  clearCellDecorations(r, c);
  setStatus("");
  savePuzzleState();
  if (state.settings.liveValidate) {
    queueValidate();
  }
}

function onCellKeyDown(e, r, c) {
  // Arrow nav, Backspace clears cell, Tab and Shift+Tab handled by browser.
  if (e.key === "ArrowRight") { focusCell(r, (c + 1) % 9); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { focusCell(r, (c + 8) % 9); e.preventDefault(); }
  else if (e.key === "ArrowDown") { focusCell((r + 1) % 9, c); e.preventDefault(); }
  else if (e.key === "ArrowUp") { focusCell((r + 8) % 9, c); e.preventDefault(); }
  else if ((e.key === "Backspace" || e.key === "Delete") && !state.cells[r][c].readOnly) {
    state.cells[r][c].value = "";
    clearCellDecorations(r, c);
    savePuzzleState();
    if (state.settings.liveValidate) queueValidate();
  }
}

function focusCell(r, c) {
  state.cells[r][c].focus();
}

// ============================================================
//  ACTIONS
// ============================================================

async function onSolve() {
  const button = document.getElementById("solve");
  button.disabled = true;
  setStatus(t("toast.generating"));
  try {
    const { status, data } = await api("/solve", {
      board: readGrid(),
      puzzle_id: state.puzzleId,
    });
    if (data.success) {
      showSolutionGrid(data.solution);
      if (data.fallback_used) {
        toast(t("toast.fallback"), "warn", 5000);
      } else {
        toast(t("toast.solved"), "success");
      }
      setStatus("");
    } else {
      hideSolutionGrid();
      if (status === 504) toast(t("toast.timeout"), "error");
      else if (status === 500) toast(t("toast.solverUnavailable"), "error", 6000);
      else toast(data.message || t("toast.unsolvable"), "error");
      setStatus(data.message || "");
    }
  } finally {
    button.disabled = false;
  }
}

async function onCheck() {
  const button = document.getElementById("check");
  const grid = readGrid();
  // Skip the round-trip if there's nothing to compare.
  let anyEntry = false;
  for (let r = 0; r < 9 && !anyEntry; r++) {
    for (let c = 0; c < 9 && !anyEntry; c++) {
      if (grid[r][c] !== 0 && !state.clues.has(`${r},${c}`)) anyEntry = true;
    }
  }
  if (!anyEntry) {
    toast(t("toast.noEntries"), "warn");
    return;
  }
  button.disabled = true;
  try {
    clearAllDecorations();
    const { data } = await api("/check", {
      board: grid,
      puzzle_id: state.puzzleId,
    });
    if (!data.success) {
      toast(data.message || t("toast.networkError"), "error");
      return;
    }
    for (const [r, c] of data.correct_cells) {
      if (!state.clues.has(`${r},${c}`)) {
        state.cells[r][c].classList.add("correct");
      }
    }
    for (const [r, c] of data.wrong_cells) {
      state.cells[r][c].classList.add("wrong");
    }
    if (data.complete) {
      stopTimer();
      const ms = currentElapsedMs();
      recordTime(state.difficulty, ms, state.puzzleId);
      toast(t("toast.allCorrect"), "success", 4000);
    } else {
      toast(t("toast.partialCorrect", data.correct_cells.length, data.wrong_cells.length), "info");
    }
  } finally {
    button.disabled = false;
  }
}

async function onHint() {
  if (state.hintsUsed >= state.hintsMax) {
    toast(t("toast.hintsExhausted"), "warn");
    return;
  }
  const button = document.getElementById("hint");
  button.disabled = true;
  try {
    const { data } = await api("/hint", {
      board: readGrid(),
      puzzle_id: state.puzzleId,
    });
    if (!data.success) {
      if (data.message && /complete/i.test(data.message)) toast(t("toast.hintComplete"), "info");
      else toast(data.message || t("toast.networkError"), "error");
      return;
    }
    const { row, col, value } = data;
    setHintMode(row, col, value);
    state.hintsUsed += 1;
    updateHintCounter();
    savePuzzleState();
    toast(t("toast.hintPlaced"), "info", 1500);
  } finally {
    if (state.hintsUsed < state.hintsMax) button.disabled = false;
    else button.disabled = true;
  }
}

async function onGenerate() {
  const button = document.getElementById("generate");
  button.disabled = true;
  setStatus(t("toast.generating"));
  hideSolutionGrid();
  try {
    const difficulty = document.getElementById("difficulty").value;
    const { data } = await api("/generate", { difficulty });
    if (!data.success) {
      toast(data.message || t("toast.networkError"), "error");
      return;
    }
    // Reset state
    state.clues.clear();
    state.hintCells.clear();
    state.hintsUsed = 0;
    state.puzzleId = data.puzzle_id;
    state.difficulty = data.difficulty;
    state.elapsedAtStart = 0;
    // Fill grid
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = state.cells[r][c];
        cell.readOnly = false;
        cell.classList.remove("clue", "hint", "user", "correct", "wrong", "conflict");
        const v = data.board[r][c];
        if (v !== 0) setClueMode(r, c, v);
        else cell.value = "";
      }
    }
    updateHintCounter();
    resetTimer();
    startTimer();
    savePuzzleState();
    setStatus("");
    toast(t("toast.generated", t("diff." + difficulty), data.clue_count), "success");
  } finally {
    button.disabled = false;
  }
}

function queueValidate() {
  if (state.validateTimeout) clearTimeout(state.validateTimeout);
  state.validateTimeout = setTimeout(runValidate, 200);
}

async function runValidate() {
  state.validateTimeout = null;
  if (state.validateAbort) state.validateAbort.abort();
  const ctrl = new AbortController();
  state.validateAbort = ctrl;
  try {
    const { data } = await api("/validate", { board: readGrid() }, ctrl.signal);
    if (!data.success) return;
    // Clear previous conflict marks (but preserve correct/wrong from Check).
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        state.cells[r][c].classList.remove("conflict");
      }
    }
    for (const [r, c] of data.conflicts) {
      state.cells[r][c].classList.add("conflict");
    }
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  } finally {
    if (state.validateAbort === ctrl) state.validateAbort = null;
  }
}

function updateHintCounter() {
  const left = Math.max(0, state.hintsMax - state.hintsUsed);
  document.getElementById("hintsLeft").textContent = String(left);
  document.getElementById("hint").disabled = (left === 0);
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg || "";
}

// ============================================================
//  CLEAR
// ============================================================

function clearEntries() {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const key = `${r},${c}`;
      if (state.clues.has(key) || state.hintCells.has(key)) continue;
      state.cells[r][c].value = "";
      clearCellDecorations(r, c);
    }
  }
  savePuzzleState();
  toast(t("toast.entriesCleared"), "info", 1500);
}

function clearEverything() {
  state.clues.clear();
  state.hintCells.clear();
  state.hintsUsed = 0;
  state.puzzleId = null;
  state.elapsedAtStart = 0;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = state.cells[r][c];
      cell.value = "";
      cell.readOnly = false;
      cell.classList.remove("clue", "hint", "user", "correct", "wrong", "conflict");
    }
  }
  document.getElementById("matrix").value = "";
  hideSolutionGrid();
  resetTimer();
  updateHintCounter();
  setStatus("");
  try { localStorage.removeItem(STORAGE.lastPuzzle); } catch (e) {}
  toast(t("toast.cleared"), "info", 1500);
}

// ============================================================
//  TIMER
// ============================================================

function startTimer() {
  if (!state.settings.timerEnabled) return;
  state.startedAt = Date.now();
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = setInterval(tickTimer, 1000);
  tickTimer();
}

function stopTimer() {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
  }
  // Freeze elapsed time
  state.elapsedAtStart = currentElapsedMs();
  state.startedAt = null;
  tickTimer();
}

function resetTimer() {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
  }
  state.startedAt = null;
  state.elapsedAtStart = 0;
  tickTimer();
}

function currentElapsedMs() {
  if (state.startedAt) return state.elapsedAtStart + (Date.now() - state.startedAt);
  return state.elapsedAtStart;
}

function tickTimer() {
  const ms = currentElapsedMs();
  const secs = Math.floor(ms / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  document.getElementById("timer").textContent = `${mm}:${ss}`;
}

function setTimerVisible(visible) {
  document.querySelector(".timer-wrap").classList.toggle("hidden", !visible);
}

// ============================================================
//  IMPORT (textarea paste + file upload)
// ============================================================

function parseMatrixText(text) {
  // Accept either 9 lines of 9 digits, or 81 contiguous digits split by whitespace.
  const cleaned = text.replace(/\r/g, "").trim();
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

function importGrid(grid) {
  // Wipe state and apply the imported grid as clues + start a fresh timer.
  state.clues.clear();
  state.hintCells.clear();
  state.hintsUsed = 0;
  state.puzzleId = null;  // pasted/uploaded puzzles aren't in the server cache
  state.elapsedAtStart = 0;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = state.cells[r][c];
      cell.readOnly = false;
      cell.classList.remove("clue", "hint", "user", "correct", "wrong", "conflict");
      const v = grid[r][c];
      if (v !== 0) setClueMode(r, c, v);
      else cell.value = "";
    }
  }
  hideSolutionGrid();
  updateHintCounter();
  resetTimer();
  startTimer();
  savePuzzleState();
  toast(t("toast.imported"), "success", 1500);
}

function onMatrixInput() {
  const text = document.getElementById("matrix").value;
  if (!text.trim()) { setStatus(""); return; }
  const grid = parseMatrixText(text);
  if (grid) importGrid(grid);
}

function onFileUpload(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const grid = parseMatrixText(e.target.result);
    if (!grid) {
      toast(t("toast.invalidImport"), "error");
      return;
    }
    importGrid(grid);
  };
  reader.onerror = () => toast(t("toast.uploadError"), "error");
  reader.readAsText(file);
  ev.target.value = "";  // allow re-upload of same file
}

// ============================================================
//  TUTORIAL
// ============================================================

let tutorialStep = 0;
const TUTORIAL_STEPS = ["tutorial.step1", "tutorial.step2", "tutorial.step3", "tutorial.step4"];

function showTutorial() {
  tutorialStep = 0;
  document.getElementById("tutorial").hidden = false;
  renderTutorialStep();
}

function closeTutorial(markSeen) {
  document.getElementById("tutorial").hidden = true;
  if (markSeen) {
    state.settings.tutorialSeen = true;
    saveSettings();
  }
}

function renderTutorialStep() {
  document.getElementById("tutorialBody").textContent = t(TUTORIAL_STEPS[tutorialStep]);
  document.getElementById("tutorialStepIndicator").textContent = `${tutorialStep + 1} / ${TUTORIAL_STEPS.length}`;
  document.getElementById("tutorialPrev").disabled = (tutorialStep === 0);
  const isLast = tutorialStep === TUTORIAL_STEPS.length - 1;
  document.getElementById("tutorialNext").textContent = isLast ? t("tutorial.done") : t("tutorial.next");
}

function maybeShowTutorial() {
  if (!state.settings.tutorialSeen) showTutorial();
}

// ============================================================
//  RESTORE LAST PUZZLE
// ============================================================

function restoreLastPuzzle() {
  const saved = loadPuzzleState();
  if (!saved) return false;
  try {
    state.clues = new Set(saved.clues || []);
    state.hintCells = new Set(saved.hintCells || []);
    state.hintsUsed = saved.hintsUsed || 0;
    state.puzzleId = saved.puzzleId || null;
    state.difficulty = saved.difficulty || "medium";
    state.elapsedAtStart = saved.elapsedMs || 0;
    const board = saved.board;
    if (!Array.isArray(board) || board.length !== 9) return false;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = state.cells[r][c];
        cell.readOnly = false;
        cell.classList.remove("clue", "hint", "user", "correct", "wrong", "conflict");
        cell.value = "";
        const v = board[r][c];
        const key = `${r},${c}`;
        if (state.clues.has(key)) setClueMode(r, c, v);
        else if (state.hintCells.has(key)) setHintMode(r, c, v);
        else if (v !== 0) cell.value = String(v);
      }
    }
    const diffSel = document.getElementById("difficulty");
    if (diffSel && saved.difficulty) diffSel.value = saved.difficulty;
    updateHintCounter();
    tickTimer();
    if (state.elapsedAtStart > 0) startTimer();
    return true;
  } catch (e) {
    console.warn("restoreLastPuzzle failed", e);
    return false;
  }
}

// ============================================================
//  WIRING
// ============================================================

function wireSettings() {
  const live = document.getElementById("setLiveValidate");
  const timerCb = document.getElementById("setTimer");
  const lang = document.getElementById("langSelect");
  live.checked = !!state.settings.liveValidate;
  timerCb.checked = state.settings.timerEnabled !== false;
  lang.value = state.lang;
  setTimerVisible(timerCb.checked);

  live.addEventListener("change", () => {
    state.settings.liveValidate = live.checked;
    saveSettings();
    if (!live.checked) {
      // Clear conflict highlights
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          state.cells[r][c].classList.remove("conflict");
        }
      }
    } else {
      queueValidate();
    }
  });
  timerCb.addEventListener("change", () => {
    state.settings.timerEnabled = timerCb.checked;
    setTimerVisible(timerCb.checked);
    saveSettings();
  });
  lang.addEventListener("change", () => {
    state.lang = lang.value;
    saveSettings();
    applyI18n();
  });

  document.getElementById("restartTutorial").addEventListener("click", () => showTutorial());
}

function wireButtons() {
  document.getElementById("solve").addEventListener("click", onSolve);
  document.getElementById("check").addEventListener("click", onCheck);
  document.getElementById("hint").addEventListener("click", onHint);
  document.getElementById("generate").addEventListener("click", onGenerate);
  document.getElementById("clearEntries").addEventListener("click", clearEntries);
  document.getElementById("clear").addEventListener("click", clearEverything);

  document.getElementById("matrix").addEventListener("input", onMatrixInput);
  document.getElementById("upload").addEventListener("change", onFileUpload);

  document.getElementById("tutorialNext").addEventListener("click", () => {
    if (tutorialStep === TUTORIAL_STEPS.length - 1) closeTutorial(true);
    else { tutorialStep += 1; renderTutorialStep(); }
  });
  document.getElementById("tutorialPrev").addEventListener("click", () => {
    if (tutorialStep > 0) { tutorialStep -= 1; renderTutorialStep(); }
  });
  document.getElementById("tutorialSkip").addEventListener("click", () => closeTutorial(true));

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("tutorial").hidden) {
      closeTutorial(true);
    }
  });
}

// ============================================================
//  INIT
// ============================================================

function init() {
  loadSettings();
  buildPrimaryGrid();
  buildSolutionGrid();
  applyI18n();
  wireSettings();
  wireButtons();
  updateHintCounter();
  resetTimer();
  if (!restoreLastPuzzle()) {
    maybeShowTutorial();
  }
}

init();
