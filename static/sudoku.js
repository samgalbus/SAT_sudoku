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
  clues: new Set(),     // "r,c" strings - cells originally given by sudoku
  hintCells: new Set(), // "r,c" strings - cells filled via Hint
  hintsUsed: 0,
  hintsMax: 3,
  difficulty: "medium",
  puzzleId: null,
  startedAt: null,      // Date.now() when timer started
  timerHandle: null,
  elapsedAtStart: 0,    // resumed elapsed ms (for restore)
  settings: {
    liveValidate: false,
    timerEnabled: true,
    tutorialSeen: false,
  },
  validateAbort: null,
  validateTimeout: null,
};

// I18N lives in static/i18n.js (loaded before this file).
// window.t(key, ...args) and window.applyI18n() are available globally.

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
  // Language is owned by i18n.js (also reads sudoku.settings), so we don't track it here.
}

function saveSettings() {
  // Preserve any lang field that i18n.js wrote (read-modify-write merge).
  let existing = {};
  try { existing = JSON.parse(localStorage.getItem(STORAGE.settings) || "{}"); } catch (e) {}
  const merged = { ...existing, ...state.settings };
  try {
    localStorage.setItem(STORAGE.settings, JSON.stringify(merged));
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

function showRevealModal() {
  const modal = document.getElementById("revealModal");
  if (!modal) return false;
  modal.hidden = false;
  return true;
}

function closeRevealModal() {
  const modal = document.getElementById("revealModal");
  if (modal) modal.hidden = true;
}

async function onSolve() {
  if (!showRevealModal()) await runSolveFlow();
}

async function runSolveFlow() {
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
      stopTimer();
      savePuzzleState();
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
    state.puzzleId = null;  // pasted/uploaded sudokus aren't in the server cache
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
//  RESTORE LAST SUDOKU
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
  lang.value = window.getLang ? window.getLang() : "en";
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
    if (window.setLang) window.setLang(lang.value);
  });

  document.getElementById("restartTutorial").addEventListener("click", () => showTutorial());
}

function wireButtons() {
  document.getElementById("solve").addEventListener("click", onSolve);
  document.getElementById("revealConfirm").addEventListener("click", async () => {
    closeRevealModal();
    await runSolveFlow();
  });
  document.querySelectorAll("[data-close-reveal]").forEach(el => {
    el.addEventListener("click", closeRevealModal);
  });
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
    if (e.key === "Escape" && !document.getElementById("revealModal").hidden) {
      closeRevealModal();
    } else if (e.key === "Escape" && !document.getElementById("tutorial").hidden) {
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
