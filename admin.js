(function () {
  "use strict";

  const INTERNAL_AUTH_DOMAIN = "worldcup-predictor.invalid";
  const API_BASE = location.origin;
  const dom = {};
  let supabaseClient = null;
  let fixtures = [];
  let accounts = [];

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindEvents();
    await initializeSupabase();
  }

  function cacheDom() {
    [
      "adminStatus",
      "adminLogin",
      "adminDashboard",
      "adminAuthForm",
      "adminUsername",
      "adminPassword",
      "refreshAdmin",
      "signOutAdmin",
      "accountCount",
      "fixtureCount",
      "loadedAt",
      "accountPredictions",
      "matchPredictions",
    ].forEach((id) => {
      dom[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    dom.adminAuthForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await signIn();
    });
    dom.refreshAdmin.addEventListener("click", loadAdminData);
    dom.signOutAdmin.addEventListener("click", signOut);
  }

  async function initializeSupabase() {
    try {
      const supabaseApi = window.supabase || globalThis.supabase;
      if (!supabaseApi?.createClient) throw new Error("Supabase client script did not load.");
      const response = await fetch(`${API_BASE}/api/config`);
      if (!response.ok) throw new Error("/api/config could not be loaded.");
      const config = await response.json();
      if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("Supabase env vars are missing.");
      supabaseClient = supabaseApi.createClient(config.supabaseUrl, config.supabaseAnonKey);

      const { data } = await supabaseClient.auth.getSession();
      if (data.session?.user) {
        await loadAdminData();
      } else {
        setStatus("Log in to view admin data", "neutral");
      }
    } catch (error) {
      setStatus(error.message || "Admin setup failed", "error");
    }
  }

  async function signIn() {
    const username = normalizeUsername(dom.adminUsername.value);
    const password = dom.adminPassword.value;
    if (!isValidUsername(username)) {
      setStatus("Use 3-24 letters, numbers, or underscores", "error");
      return;
    }
    if (password.length < 6) {
      setStatus("Password must be at least 6 characters", "error");
      return;
    }

    setStatus("Checking admin access", "neutral");
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: authEmailForUsername(username),
      password,
    });
    if (error) {
      setStatus(error.message || "Login failed", "error");
      return;
    }
    await loadAdminData();
  }

  async function signOut() {
    await supabaseClient.auth.signOut();
    accounts = [];
    fixtures = [];
    dom.adminDashboard.hidden = true;
    dom.adminLogin.hidden = false;
    dom.signOutAdmin.hidden = true;
    dom.refreshAdmin.disabled = true;
    setStatus("Signed out", "success");
  }

  async function loadAdminData() {
    try {
      setStatus("Loading admin data", "neutral");
      const { data } = await supabaseClient.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Log in as admin first.");

      const response = await fetch(`${API_BASE}/api/admin-predictions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Admin data could not be loaded.");

      fixtures = payload.fixtures || [];
      accounts = payload.accounts || [];
      renderDashboard(payload);
      setStatus(`Loaded ${accounts.length} accounts`, "success");
    } catch (error) {
      dom.adminDashboard.hidden = true;
      dom.adminLogin.hidden = false;
      dom.refreshAdmin.disabled = true;
      dom.signOutAdmin.hidden = true;
      setStatus(error.message || "Admin data could not be loaded.", "error");
    }
  }

  function renderDashboard(payload) {
    dom.adminLogin.hidden = true;
    dom.adminDashboard.hidden = false;
    dom.refreshAdmin.disabled = false;
    dom.signOutAdmin.hidden = false;
    dom.accountCount.textContent = accounts.length;
    dom.fixtureCount.textContent = fixtures.length;
    dom.loadedAt.textContent = formatDate(payload.generatedAt);
    renderAccounts();
    renderMatches();
  }

  function renderAccounts() {
    dom.accountPredictions.innerHTML = "";
    if (!accounts.length) {
      dom.accountPredictions.innerHTML = `<div class="empty-state">No accounts found.</div>`;
      return;
    }

    accounts.forEach((account) => {
      const prediction = account.tournament_prediction;
      const card = el("article", "admin-account-card");
      card.innerHTML = `
        <div class="admin-card-head">
          <div>
            <h3>${escapeHtml(account.username)}</h3>
            <p class="muted">${prediction ? `Submitted ${formatDate(prediction.submitted_at)}` : "No whole-bracket prediction"}</p>
          </div>
          <div class="admin-score">
            <span>Total</span>
            <strong>${formatPoints(account.leaderboard?.total_score)}</strong>
          </div>
        </div>
      `;

      if (prediction) {
        card.appendChild(renderGroupRankings(prediction.group_rankings || {}));
        card.appendChild(renderFinalPlacements(prediction.final_placements || {}));
        card.appendChild(renderKnockoutPicks(prediction.knockout_picks || {}));
      }
      dom.accountPredictions.appendChild(card);
    });
  }

  function renderGroupRankings(groups) {
    const wrap = el("div", "admin-groups");
    Object.entries(groups).forEach(([group, teams]) => {
      const groupBox = el("div", "admin-group");
      groupBox.innerHTML = `<strong>Group ${escapeHtml(group)}</strong>`;
      const list = el("ol");
      (teams || []).forEach((team, index) => {
        const rowClass = index < 2 ? "qualified" : index === 2 ? "third-place" : "";
        const item = el("li", rowClass);
        item.textContent = `${index + 1}. ${team.name || team.code || "TBD"}`;
        list.appendChild(item);
      });
      groupBox.appendChild(list);
      wrap.appendChild(groupBox);
    });
    return sectionBlock("Groups", wrap);
  }

  function renderFinalPlacements(placements) {
    const labels = {
      winner: "Winner",
      runner: "Runner-up",
      third: "Third",
      fourth: "Fourth",
      qf: "5-8",
      r16: "9-16",
      r32: "17-32",
      grouped: "Grouped",
    };
    const wrap = el("div", "admin-placement-grid");
    Object.entries(labels).forEach(([key, label]) => {
      const box = el("div", "admin-placement");
      const teams = (placements[key] || []).map((team) => team.name || team.code).filter(Boolean);
      box.innerHTML = `<strong>${label}</strong><span>${escapeHtml(teams.join(", ") || "-")}</span>`;
      wrap.appendChild(box);
    });
    return sectionBlock("Final Placement", wrap);
  }

  function renderKnockoutPicks(picks) {
    const wrap = el("div", "admin-pick-list");
    const entries = Object.entries(picks || {});
    if (!entries.length) {
      wrap.appendChild(textEl("span", "muted", "No knockout picks"));
    } else {
      entries.forEach(([match, teamCode]) => {
        wrap.appendChild(textEl("span", "admin-pick", `${match}: ${teamCode}`));
      });
    }
    return sectionBlock("Knockout Picks", wrap);
  }

  function renderMatches() {
    dom.matchPredictions.innerHTML = "";
    if (!fixtures.length) {
      dom.matchPredictions.innerHTML = `<div class="empty-state">No fixtures found.</div>`;
      return;
    }

    const accountById = Object.fromEntries(accounts.map((account) => [account.id, account]));
    fixtures.forEach((fixture) => {
      const predictionByUser = {};
      accounts.forEach((account) => {
        (account.match_predictions || []).forEach((prediction) => {
          if (prediction.fixture_id === fixture.id) predictionByUser[account.id] = prediction;
        });
      });

      const card = el("article", "admin-match-card");
      card.innerHTML = `
        <div class="admin-match-head">
          <div>
            <h3>${escapeHtml(fixture.home_team)} vs ${escapeHtml(fixture.away_team)}</h3>
            <p class="muted">${escapeHtml(fixture.fifa_match_id || "")} · ${escapeHtml(fixture.round || "")} · ${formatDate(fixture.kickoff_at)}</p>
          </div>
          <strong>${escapeHtml(actualScoreText(fixture))}</strong>
        </div>
      `;

      const table = el("table", "admin-prediction-table");
      table.innerHTML = `
        <thead>
          <tr>
            <th>Account</th>
            <th>Prediction</th>
            <th>Submitted</th>
          </tr>
        </thead>
      `;
      const body = el("tbody");
      accounts.forEach((account) => {
        const prediction = predictionByUser[account.id];
        const row = el("tr");
        row.innerHTML = `
          <td>${escapeHtml(accountById[account.id]?.username || account.username)}</td>
          <td>${escapeHtml(matchPredictionText(fixture, prediction))}</td>
          <td>${escapeHtml(prediction?.submitted_at ? formatDate(prediction.submitted_at) : "-")}</td>
        `;
        body.appendChild(row);
      });
      table.appendChild(body);
      card.appendChild(table);
      dom.matchPredictions.appendChild(card);
    });
  }

  function sectionBlock(title, content) {
    const block = el("section", "admin-card-section");
    block.appendChild(textEl("h4", "", title));
    block.appendChild(content);
    return block;
  }

  function actualScoreText(fixture) {
    if (fixture.home_score === null || fixture.home_score === undefined || fixture.away_score === null || fixture.away_score === undefined) {
      return "Result pending";
    }
    return `Actual ${fixture.home_score}-${fixture.away_score}`;
  }

  function matchPredictionText(fixture, prediction) {
    if (!prediction) return "No prediction";
    const outcome =
      prediction.predicted_outcome === "home"
        ? `${fixture.home_team} win`
        : prediction.predicted_outcome === "away"
        ? `${fixture.away_team} win`
        : "Draw";
    const hasScore = prediction.predicted_home_score !== null && prediction.predicted_away_score !== null;
    return hasScore ? `${prediction.predicted_home_score}-${prediction.predicted_away_score}, ${outcome}` : outcome;
  }

  function setStatus(message, tone) {
    dom.adminStatus.textContent = message;
    dom.adminStatus.classList.remove("success", "error");
    if (tone === "success" || tone === "error") dom.adminStatus.classList.add(tone);
  }

  function formatPoints(value) {
    return `${Number(value || 0).toFixed(1)} pts`;
  }

  function formatDate(value) {
    if (!value) return "-";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function normalizeUsername(username) {
    return String(username || "").trim().toLowerCase();
  }

  function isValidUsername(username) {
    return /^[a-z0-9_]{3,24}$/.test(username);
  }

  function authEmailForUsername(username) {
    return `${normalizeUsername(username)}@${INTERNAL_AUTH_DOMAIN}`;
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function textEl(tag, className, text) {
    const node = el(tag, className);
    node.textContent = text;
    return node;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
