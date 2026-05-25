// Auth + nav glue. Loaded by every page (via _base.html).
// Exposes window.Auth = { me, refresh, openModal, closeModal, requireLogin, toast }.

(function () {
  const Auth = window.Auth = {};
  let currentUser = null;

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
  Auth.toast = toast;

  async function fetchJSON(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    let json;
    try { json = await res.json(); }
    catch (e) { json = { success: false, message: "Bad response" }; }
    return { status: res.status, json };
  }
  Auth.fetchJSON = fetchJSON;

  Auth.me = function () { return currentUser; };

  Auth.refresh = async function () {
    const { json } = await fetchJSON("/auth/me");
    currentUser = json.user || null;
    renderNav();
    return currentUser;
  };

  Auth.requireLogin = function () {
    if (currentUser) return true;
    openModal("login");
    return false;
  };

  // ---------- Nav rendering ----------
  function renderNav() {
    const loginBtn = document.getElementById("loginBtn");
    const userMenu = document.getElementById("userMenu");
    if (!loginBtn || !userMenu) return;
    if (currentUser) {
      loginBtn.hidden = true;
      userMenu.hidden = false;
      const name = document.getElementById("userMenuName");
      const profile = document.getElementById("userMenuProfile");
      name.textContent = currentUser.username;
      const profileHref = `/profile/${encodeURIComponent(currentUser.username)}`;
      name.href = profileHref;
      profile.href = profileHref;
    } else {
      loginBtn.hidden = false;
      userMenu.hidden = true;
    }
    highlightActiveNav();
  }

  function highlightActiveNav() {
    const path = window.location.pathname;
    document.querySelectorAll(".topnav-tabs [data-nav]").forEach(a => {
      const seg = a.getAttribute("data-nav");
      const isActive =
        (seg === "play" && path.startsWith("/play")) ||
        (seg === "solver" && path.startsWith("/solver")) ||
        (seg === "weekly" && path.startsWith("/weekly")) ||
        (seg === "leaderboard" && path.startsWith("/leaderboard"));
      a.classList.toggle("active", isActive);
    });
  }

  // ---------- Modal ----------
  function openModal(panel) {
    const modal = document.getElementById("authModal");
    if (!modal) return;
    modal.hidden = false;
    showPanel(panel || "login");
    setTimeout(() => {
      const first = modal.querySelector(".auth-panel:not([hidden]) input");
      if (first) first.focus();
    }, 50);
  }
  Auth.openModal = openModal;

  function closeModal() {
    const modal = document.getElementById("authModal");
    if (!modal) return;
    modal.hidden = true;
    clearErrors();
  }
  Auth.closeModal = closeModal;

  function showPanel(name) {
    const map = {
      login: "authPanelLogin",
      register: "authPanelRegister",
      forgot: "authPanelForgot",
      changePw: "authPanelChangePw",
      delete: "authPanelDelete",
    };
    Object.values(map).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    const target = document.getElementById(map[name] || map.login);
    if (target) target.hidden = false;
    clearErrors();
  }

  function clearErrors() {
    ["loginError", "registerError", "forgotError", "forgotInfo", "changePwError", "deleteError"]
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.hidden = true; el.textContent = ""; }
      });
  }

  function showError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  // ---------- Forms ----------
  function wireForms() {
    const login = document.getElementById("loginForm");
    if (login) login.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(login);
      const { json } = await fetchJSON("/auth/login", {
        method: "POST",
        body: {
          username: data.get("username"),
          password: data.get("password"),
        },
      });
      if (!json.success) {
        showError("loginError", json.message || t("toast.networkError"));
        return;
      }
      currentUser = json.user;
      renderNav();
      closeModal();
      toast(t("toast.loggedIn"), "success");
      document.dispatchEvent(new CustomEvent("auth:changed", { detail: { user: currentUser } }));
    });

    const register = document.getElementById("registerForm");
    if (register) register.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(register);
      if (data.get("password") !== data.get("confirm")) {
        showError("registerError", t("auth.confirmMismatch"));
        return;
      }
      const { json } = await fetchJSON("/auth/register", {
        method: "POST",
        body: {
          username: data.get("username"),
          email: data.get("email"),
          password: data.get("password"),
        },
      });
      if (!json.success) {
        showError("registerError", json.message || t("toast.networkError"));
        return;
      }
      currentUser = json.user;
      renderNav();
      closeModal();
      toast(t("toast.loggedIn"), "success");
      document.dispatchEvent(new CustomEvent("auth:changed", { detail: { user: currentUser } }));
    });

    const forgot = document.getElementById("forgotForm");
    if (forgot) forgot.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(forgot);
      const { json } = await fetchJSON("/auth/forgot-password", {
        method: "POST",
        body: { email: data.get("email") },
      });
      const info = document.getElementById("forgotInfo");
      info.textContent = json.message || t("auth.forgotSent");
      info.hidden = false;
    });

    const change = document.getElementById("changePwForm");
    if (change) change.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(change);
      const { json } = await fetchJSON("/auth/change-password", {
        method: "POST",
        body: { old: data.get("old"), new: data.get("new") },
      });
      if (!json.success) {
        showError("changePwError", json.message || t("toast.networkError"));
        return;
      }
      closeModal();
      toast(t("auth.changePwOk"), "success");
      change.reset();
    });

    const del = document.getElementById("deleteForm");
    if (del) del.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(del);
      const { json } = await fetchJSON("/auth/delete-account", {
        method: "POST",
        body: { password: data.get("password") },
      });
      if (!json.success) {
        showError("deleteError", json.message || t("toast.networkError"));
        return;
      }
      currentUser = null;
      renderNav();
      closeModal();
      toast(t("toast.accountDeleted"), "info");
      document.dispatchEvent(new CustomEvent("auth:changed", { detail: { user: null } }));
      setTimeout(() => { window.location.href = "/"; }, 800);
    });
  }

  // ---------- Wiring ----------
  function wireNav() {
    const loginBtn = document.getElementById("loginBtn");
    if (loginBtn) loginBtn.addEventListener("click", () => openModal("login"));

    const toggle = document.getElementById("userMenuToggle");
    const dropdown = document.getElementById("userMenuDropdown");
    if (toggle && dropdown) {
      toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        dropdown.hidden = !dropdown.hidden;
      });
      document.addEventListener("click", (ev) => {
        if (!dropdown.hidden && !dropdown.contains(ev.target) && ev.target !== toggle) {
          dropdown.hidden = true;
        }
      });
    }

    const changePw = document.getElementById("userMenuChangePw");
    if (changePw) changePw.addEventListener("click", () => {
      if (dropdown) dropdown.hidden = true;
      openModal("changePw");
    });

    const deleteBtn = document.getElementById("userMenuDelete");
    if (deleteBtn) deleteBtn.addEventListener("click", () => {
      if (dropdown) dropdown.hidden = true;
      openModal("delete");
    });

    const logout = document.getElementById("userMenuLogout");
    if (logout) logout.addEventListener("click", async () => {
      if (dropdown) dropdown.hidden = true;
      await fetchJSON("/auth/logout", { method: "POST" });
      currentUser = null;
      renderNav();
      toast(t("toast.loggedOut"), "info");
      document.dispatchEvent(new CustomEvent("auth:changed", { detail: { user: null } }));
    });

    document.querySelectorAll("[data-auth-switch]").forEach(link => {
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        showPanel(link.getAttribute("data-auth-switch"));
      });
    });

    document.querySelectorAll("[data-close-modal]").forEach(el => {
      el.addEventListener("click", closeModal);
    });

    document.addEventListener("keydown", (ev) => {
      const modal = document.getElementById("authModal");
      if (ev.key === "Escape" && modal && !modal.hidden) closeModal();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireNav();
    wireForms();
    Auth.refresh();
  });
})();
