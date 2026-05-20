// Weekly challenge view. Depends on auth.js + i18n.js + grid.js.

(function () {
  const state = {
    difficulty: "easy",
    puzzleId: null,
    weekId: null,
    startedAt: null,        // server timestamp (seconds)
    status: "loading",      // not_started | in_progress | completed | loading
    disqualified: false,
    elapsedMs: 0,
    completedRank: null,
    completedElapsedMs: null,
    timerHandle: null,
    grid: null,
    saveTimer: null,
  };

  function fmtMmSs(ms) {
    const secs = Math.floor((ms || 0) / 1000);
    return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  }

  function setBanner(stateName, text) {
    const b = document.getElementById("weeklyStatusBanner");
    const p = document.getElementById("weeklyStatusText");
    if (!b || !p) return;
    b.dataset.state = stateName;
    p.textContent = text;
  }

  function setActionsForState() {
    const start = document.getElementById("weeklyStartBtn");
    const submit = document.getElementById("weeklySubmitBtn");
    start.hidden = state.status !== "not_started";
    submit.hidden = !(state.status === "in_progress" && !state.disqualified);
  }

  function tickTimer() {
    if (state.status !== "in_progress" || !state.startedAt) return;
    state.elapsedMs = Math.floor((Date.now() / 1000 - state.startedAt) * 1000);
    document.getElementById("weeklyTimer").textContent = fmtMmSs(state.elapsedMs);
  }

  function startTimerInterval() {
    stopTimerInterval();
    state.timerHandle = setInterval(tickTimer, 1000);
    tickTimer();
  }

  function stopTimerInterval() {
    if (state.timerHandle) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
  }

  function renderStatus() {
    if (state.disqualified && state.status !== "completed") {
      setBanner("disqualified", t("weekly.disqualified"));
    } else if (state.status === "not_started") {
      setBanner("not_started", t("weekly.notStarted"));
      document.getElementById("weeklyTimer").textContent = "00:00";
    } else if (state.status === "in_progress") {
      setBanner("in_progress", t("weekly.inProgress"));
    } else if (state.status === "completed") {
      if (state.disqualified) {
        setBanner("disqualified", t("weekly.disqualified"));
      } else {
        const mmss = fmtMmSs(state.completedElapsedMs || state.elapsedMs);
        const rank = state.completedRank || "?";
        setBanner("completed", t("weekly.completed", mmss, rank));
      }
      document.getElementById("weeklyTimer").textContent = fmtMmSs(state.completedElapsedMs || state.elapsedMs);
    } else {
      setBanner("loading", t("toast.generating"));
    }
    setActionsForState();
  }

  function setActiveTab(diff) {
    document.querySelectorAll(".diff-tab").forEach(el => {
      el.classList.toggle("active", el.dataset.diff === diff);
    });
  }

  async function loadDifficulty(diff) {
    state.difficulty = diff;
    setActiveTab(diff);
    if (!window.Auth || !window.Auth.me()) {
      document.getElementById("weeklyLoggedOut").hidden = false;
      setBanner("loading", "");
      document.getElementById("weeklyStatusText").textContent = "";
      state.grid && state.grid.applyBoard(blankBoard(), { lockNonZero: false });
      stopTimerInterval();
      return;
    }
    document.getElementById("weeklyLoggedOut").hidden = true;
    state.status = "loading";
    renderStatus();

    const { json, status } = await Auth.fetchJSON(`/weekly/${diff}`);
    if (status === 401) {
      document.getElementById("weeklyLoggedOut").hidden = false;
      return;
    }
    if (!json.success) {
      Auth.toast(json.message || t("toast.networkError"), "error");
      return;
    }

    state.puzzleId = json.puzzle_id;
    state.weekId = json.week_id;
    document.getElementById("weeklyWeekLabel").textContent = t("weekly.weekLabel", json.week_id);

    state.grid.applyBoard(json.board, { lockNonZero: true });

    const a = json.attempt || { status: "not_started" };
    state.status = a.status;
    state.disqualified = !!a.disqualified;
    state.startedAt = a.started_at || null;
    state.elapsedMs = a.elapsed_ms || 0;
    state.completedElapsedMs = a.completed_at ? a.elapsed_ms : null;
    state.completedRank = null; // We only learn rank on submit; could re-fetch leaderboard but skip for now.

    if (state.status === "in_progress") {
      if (a.grid_state) {
        const entries = [];
        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            const v = a.grid_state[r][c];
            if (v !== 0 && json.board[r][c] === 0) entries.push([r, c, v]);
          }
        }
        state.grid.applyEntries(entries);
      }
      startTimerInterval();
    } else {
      stopTimerInterval();
    }

    if (state.status === "completed" || state.disqualified) {
      state.grid.setReadOnly(true);
    } else {
      state.grid.setReadOnly(false);
    }

    renderStatus();
  }

  function blankBoard() {
    return Array.from({ length: 9 }, () => Array(9).fill(0));
  }

  async function onStart() {
    if (!Auth.requireLogin()) return;
    const { json } = await Auth.fetchJSON("/weekly/start", {
      method: "POST",
      body: { difficulty: state.difficulty },
    });
    if (!json.success) {
      Auth.toast(json.message || t("toast.networkError"), "error");
      return;
    }
    state.puzzleId = json.puzzle_id;
    state.weekId = json.week_id;
    const a = json.attempt;
    state.status = a.status;
    state.disqualified = !!a.disqualified;
    state.startedAt = a.started_at;
    state.elapsedMs = a.elapsed_ms || 0;
    state.grid.setReadOnly(false);
    if (state.status === "in_progress") startTimerInterval();
    renderStatus();
  }

  function scheduleAutosave() {
    if (state.status !== "in_progress") return;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(autosaveNow, 1000);
  }

  async function autosaveNow() {
    state.saveTimer = null;
    if (state.status !== "in_progress") return;
    const board = state.grid.readBoard();
    await Auth.fetchJSON("/weekly/save-grid", {
      method: "POST",
      body: { difficulty: state.difficulty, grid: board },
    });
  }

  async function onSubmit() {
    if (state.status !== "in_progress") return;
    state.grid.clearMarks();
    const board = state.grid.readBoard();
    const { json } = await Auth.fetchJSON("/weekly/submit", {
      method: "POST",
      body: { difficulty: state.difficulty, board },
    });
    if (!json.success) {
      if (json.complete === false) {
        Auth.toast(t("weekly.submitIncomplete"), "warn");
      } else if (Array.isArray(json.wrong_cells)) {
        state.grid.markCells(json.wrong_cells, "wrong");
        Auth.toast(t("weekly.submitWrong", json.wrong_cells.length), "warn");
      } else {
        Auth.toast(json.message || t("toast.networkError"), "error");
      }
      return;
    }
    state.status = "completed";
    state.disqualified = !!json.disqualified;
    state.completedElapsedMs = json.elapsed_ms;
    state.completedRank = json.rank;
    stopTimerInterval();
    state.grid.setReadOnly(true);
    renderStatus();
    Auth.toast(t("weekly.completed", fmtMmSs(json.elapsed_ms), json.rank || "?"), "success", 5000);
  }

  function wire() {
    state.grid = Grid.create({
      container: document.getElementById("weeklyGrid"),
      onChange: () => {
        if (state.status === "in_progress" && !state.disqualified) scheduleAutosave();
      },
    });

    document.querySelectorAll(".diff-tab").forEach(tab => {
      tab.addEventListener("click", () => loadDifficulty(tab.dataset.diff));
    });

    document.getElementById("weeklyStartBtn").addEventListener("click", onStart);
    document.getElementById("weeklySubmitBtn").addEventListener("click", onSubmit);

    document.addEventListener("auth:changed", () => loadDifficulty(state.difficulty));
  }

  document.addEventListener("DOMContentLoaded", async () => {
    wire();
    // Wait for Auth.refresh() to populate currentUser before first load.
    if (window.Auth && window.Auth.me() === null) {
      await window.Auth.refresh();
    }
    loadDifficulty("easy");
  });
})();
