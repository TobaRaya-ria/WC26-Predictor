(function () {
  "use strict";

  const INTERNAL_AUTH_DOMAIN = "worldcup-predictor.invalid";
  const API_BASE = location.origin;
  const PLACEMENT_OPTIONS = [
    ["", "Not set"],
    ["winner", "Winner"],
    ["runner", "Runner-up"],
    ["third", "Third"],
    ["fourth", "Fourth"],
    ["qf", "5-8"],
    ["r16", "9-16"],
    ["r32", "17-32"],
    ["grouped", "Grouped"],
  ];
  const STATUS_OPTIONS = [
    ["scheduled", "Scheduled"],
    ["in_progress", "In progress"],
    ["finished", "Finished"],
    ["postponed", "Postponed"],
    ["cancelled", "Cancelled"],
  ];
  const dom = {};
  let supabaseClient = null;
  let fixtures = [];
  let accounts = [];
  let actualResults = [];

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
      "bracketResults",
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
    actualResults = [];
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
      actualResults = payload.actualResults || [];
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
    renderBracketResults();
    renderAccounts();
    renderMatches();
  }

  function renderBracketResults() {
    dom.bracketResults.innerHTML = "";
    if (!actualResults.length) {
      dom.bracketResults.innerHTML = `<div class="empty-state">Import actual_tournament_results.csv first.</div>`;
      return;
    }

    actualResults.forEach((result) => {
      const row = el("article", "admin-result-row");
      const info = el("div", "admin-result-team");
      info.appendChild(textEl("strong", "", result.team_name || result.team_code));
      info.appendChild(textEl("span", "muted", result.team_code || ""));

      const select = selectEl(PLACEMENT_OPTIONS, result.placement || "");
      const save = textEl("button", "ghost-button small", "Save");
      save.type = "button";
      const note = textEl("span", "admin-inline-status", "");

      save.addEventListener("click", async () => {
        await runAdminSave(save, note, "Saving", "Saved", {
          type: "bracket-result",
          teamCode: result.team_code,
          teamName: result.team_name,
          placement: select.value,
        });
      });

      const controls = el("div", "admin-result-editor");
      controls.appendChild(fieldEl("Placement", select));
      controls.appendChild(save);
      controls.appendChild(note);

      row.appendChild(info);
      row.appendChild(controls);
      dom.bracketResults.appendChild(row);
    });
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
      card.appendChild(renderFixtureEditor(fixture));

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

  function renderFixtureEditor(fixture) {
    const editor = el("div", "admin-fixture-editor");
    const homeScore = inputEl("number", fixture.home_score ?? "");
    const awayScore = inputEl("number", fixture.away_score ?? "");
    homeScore.min = "0";
    homeScore.max = "99";
    homeScore.inputMode = "numeric";
    awayScore.min = "0";
    awayScore.max = "99";
    awayScore.inputMode = "numeric";

    const winner = selectEl(
      [
        ["", "Winner not set"],
        [fixture.home_team, `${fixture.home_team} win`],
        [fixture.away_team, `${fixture.away_team} win`],
        ["draw", "Draw"],
      ],
      normalizedWinnerValue(fixture)
    );
    const status = selectEl(STATUS_OPTIONS, fixture.status || "scheduled");
    const save = textEl("button", "primary-button small", "Save result");
    save.type = "button";
    const note = textEl("span", "admin-inline-status", "");

    [homeScore, awayScore].forEach((input) => {
      input.addEventListener("input", () => {
        const home = homeScore.value === "" ? null : Number(homeScore.value);
        const away = awayScore.value === "" ? null : Number(awayScore.value);
        if (home === null || away === null || !Number.isFinite(home) || !Number.isFinite(away)) return;
        winner.value = home > away ? fixture.home_team : away > home ? fixture.away_team : "draw";
        if (status.value === "scheduled") status.value = "finished";
      });
    });

    save.addEventListener("click", async () => {
      await runAdminSave(save, note, "Saving result", "Result saved", {
        type: "fixture",
        fixtureId: fixture.id,
        homeScore: homeScore.value,
        awayScore: awayScore.value,
        winnerTeam: winner.value,
        status: status.value,
      });
    });

    editor.appendChild(fieldEl("Home score", homeScore));
    editor.appendChild(fieldEl("Away score", awayScore));
    editor.appendChild(fieldEl("Winner", winner));
    editor.appendChild(fieldEl("Status", status));
    editor.appendChild(save);
    editor.appendChild(note);
    return editor;
  }

  async function runAdminSave(button, note, pendingText, successText, payload) {
    try {
      button.disabled = true;
      note.textContent = pendingText;
      note.classList.remove("success", "error");
      await saveAdminUpdate(payload);
      note.textContent = successText;
      note.classList.add("success");
      await loadAdminData();
    } catch (error) {
      note.textContent = error.message || "Save failed";
      note.classList.add("error");
      setStatus(error.message || "Save failed", "error");
    } finally {
      button.disabled = false;
    }
  }

  async function saveAdminUpdate(payload) {
    const { data } = await supabaseClient.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Log in as admin first.");

    const response = await fetch(`${API_BASE}/api/admin-update`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Admin update failed.");
    return body;
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

  function normalizedWinnerValue(fixture) {
    const winner = String(fixture.winner_team || "").trim();
    if (!winner) return "";
    if (winner.toLowerCase() === "draw") return "draw";
    if (winner === fixture.home_team || winner === fixture.away_team) return winner;
    return "";
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

  function inputEl(type, value) {
    const node = el("input", "");
    node.type = type;
    node.value = value;
    return node;
  }

  function selectEl(options, value) {
    const node = el("select", "");
    options.forEach(([optionValue, label]) => {
      const option = el("option", "");
      option.value = optionValue;
      option.textContent = label;
      node.appendChild(option);
    });
    node.value = value;
    return node;
  }

  function fieldEl(label, control) {
    const node = el("label", "admin-field");
    node.appendChild(textEl("span", "", label));
    node.appendChild(control);
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
