// Profile view. Depends on auth.js + i18n.js.

(function () {
  function fmtMmSs(ms) {
    if (ms == null) return "—";
    const secs = Math.floor(ms / 1000);
    return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  }

  function fmtDate(epoch) {
    if (!epoch) return "";
    return new Date(epoch * 1000).toLocaleDateString();
  }

  async function load() {
    const section = document.querySelector(".profile-page");
    const username = section ? section.dataset.username : "";
    if (!username) return;

    const { status, json } = await Auth.fetchJSON(`/api/profile/${encodeURIComponent(username)}`);
    if (status === 404 || !json.success) {
      document.getElementById("profileUsername").textContent = "Not found";
      document.getElementById("profileMember").textContent = "";
      document.getElementById("profileCount").textContent = "";
      return;
    }

    document.getElementById("profileUsername").textContent = json.username;
    document.getElementById("profileMember").textContent =
      t("profile.memberSince", fmtDate(json.created_at));
    document.getElementById("profileCount").textContent =
      t("profile.totalCompleted", json.total_completed || 0);

    const best = json.best_per_difficulty || {};
    document.getElementById("bestEasy").textContent   = fmtMmSs(best.easy);
    document.getElementById("bestMedium").textContent = fmtMmSs(best.medium);
    document.getElementById("bestHard").textContent   = fmtMmSs(best.hard);

    const list = document.getElementById("profileRecent");
    const empty = document.getElementById("profileEmpty");
    list.innerHTML = "";
    if (!json.recent || json.recent.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    json.recent.forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="recent-week">${r.week_id}</span>
        <span class="recent-diff">${t("diff." + r.difficulty)}</span>
        <span class="recent-time">${fmtMmSs(r.elapsed_ms)}</span>
        <span class="recent-rank">#${r.rank}</span>
      `;
      list.appendChild(li);
    });
  }

  document.addEventListener("DOMContentLoaded", load);
})();
