// Leaderboard view. Depends on auth.js + i18n.js.

(function () {
  let currentDiff = "easy";

  function fmtMmSs(ms) {
    const secs = Math.floor((ms || 0) / 1000);
    return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  }

  function fmtDate(epoch) {
    if (!epoch) return "";
    const d = new Date(epoch * 1000);
    return d.toLocaleString();
  }

  function setActiveTab(diff) {
    document.querySelectorAll(".diff-tab").forEach(el => {
      el.classList.toggle("active", el.dataset.diff === diff);
    });
  }

  function makeRow(entry) {
    const tr = document.createElement("tr");
    if (entry.is_self) tr.classList.add("lb-self");
    tr.innerHTML = `
      <td class="lb-rank">${entry.rank}</td>
      <td class="lb-name"></td>
      <td class="lb-time">${fmtMmSs(entry.elapsed_ms)}</td>
      <td class="lb-finished">${fmtDate(entry.completed_at)}</td>
    `;
    const nameCell = tr.querySelector(".lb-name");
    if (entry.deleted) {
      nameCell.textContent = "[deleted user]";
      nameCell.classList.add("lb-deleted");
    } else {
      const a = document.createElement("a");
      a.href = `/profile/${encodeURIComponent(entry.username)}`;
      a.textContent = entry.username;
      nameCell.appendChild(a);
      if (entry.is_self) {
        const tag = document.createElement("span");
        tag.className = "lb-self-tag";
        tag.textContent = ` (${t("leaderboard.you")})`;
        nameCell.appendChild(tag);
      }
    }
    return tr;
  }

  async function loadDifficulty(diff) {
    currentDiff = diff;
    setActiveTab(diff);
    const body = document.getElementById("lbBody");
    const empty = document.getElementById("lbEmpty");
    const stat = document.getElementById("lbStat");
    const selfFoot = document.getElementById("lbSelfFoot");
    const selfRow = document.getElementById("lbSelfRow");
    body.innerHTML = "";
    selfRow.innerHTML = "";
    selfFoot.hidden = true;
    stat.textContent = "";
    empty.hidden = true;

    const { json } = await Auth.fetchJSON(`/weekly/leaderboard/${diff}`);
    if (!json.success) {
      stat.textContent = json.message || t("toast.networkError");
      return;
    }
    document.getElementById("lbWeekLabel").textContent = t("weekly.weekLabel", json.week_id);
    stat.textContent = t("leaderboard.players", json.total_completed || 0);

    if (!json.entries || json.entries.length === 0) {
      empty.hidden = false;
      return;
    }
    json.entries.forEach(e => body.appendChild(makeRow(e)));

    if (json.self_outside_top) {
      selfFoot.hidden = false;
      const tr = makeRow(json.self_outside_top);
      selfRow.replaceWith(tr);
      tr.id = "lbSelfRow";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.querySelectorAll(".diff-tab").forEach(tab => {
      tab.addEventListener("click", () => loadDifficulty(tab.dataset.diff));
    });
    document.addEventListener("auth:changed", () => loadDifficulty(currentDiff));
    if (window.Auth && window.Auth.me() === null) await window.Auth.refresh();
    loadDifficulty("easy");
  });
})();
