(function () {
  "use strict";

  const DEFAULT_TOURNAMENT_LOCK_AT = "2026-06-28T23:59:59Z";
  const SAVE_KEY = "wc26-predictor-v2";
  const API_ENABLED = location.protocol === "http:" || location.protocol === "https:";
  const API_BASE = API_ENABLED ? location.origin : "";
  const LOCAL_API_ENABLED = API_ENABLED && ["127.0.0.1", "localhost"].includes(location.hostname);
  const INTERNAL_AUTH_DOMAIN = "worldcup-predictor.invalid";

  const initialGroups = {
    A: [
      team("MEX", "Mexico"),
      team("RSA", "South Africa"),
      team("KOR", "Korea Republic"),
      team("CZE", "Czechia"),
    ],
    B: [
      team("CAN", "Canada"),
      team("BIH", "Bosnia and Herzegovina"),
      team("QAT", "Qatar"),
      team("SUI", "Switzerland"),
    ],
    C: [team("BRA", "Brazil"), team("MAR", "Morocco"), team("HAI", "Haiti"), team("SCO", "Scotland")],
    D: [team("USA", "USA"), team("PAR", "Paraguay"), team("AUS", "Australia"), team("TUR", "Turkiye")],
    E: [
      team("CIV", "Cote d'Ivoire"),
      team("ECU", "Ecuador"),
      team("GER", "Germany"),
      team("CUW", "Curacao"),
    ],
    F: [team("NED", "Netherlands"), team("JPN", "Japan"), team("SWE", "Sweden"), team("TUN", "Tunisia")],
    G: [team("IRN", "IR Iran"), team("NZL", "New Zealand"), team("BEL", "Belgium"), team("EGY", "Egypt")],
    H: [
      team("KSA", "Saudi Arabia"),
      team("URU", "Uruguay"),
      team("ESP", "Spain"),
      team("CPV", "Cabo Verde"),
    ],
    I: [team("FRA", "France"), team("SEN", "Senegal"), team("IRQ", "Iraq"), team("NOR", "Norway")],
    J: [team("ARG", "Argentina"), team("ALG", "Algeria"), team("AUT", "Austria"), team("JOR", "Jordan")],
    K: [team("POR", "Portugal"), team("COD", "Congo DR"), team("UZB", "Uzbekistan"), team("COL", "Colombia")],
    L: [team("GHA", "Ghana"), team("PAN", "Panama"), team("ENG", "England"), team("CRO", "Croatia")],
  };

  const venues = [
    "Mexico City Stadium",
    "Estadio Guadalajara",
    "Toronto Stadium",
    "Los Angeles Stadium",
    "Boston Stadium",
    "BC Place Vancouver",
    "New York New Jersey Stadium",
    "San Francisco Bay Area Stadium",
    "Philadelphia Stadium",
    "Houston Stadium",
    "Dallas Stadium",
    "Estadio Monterrey",
    "Miami Stadium",
    "Atlanta Stadium",
    "Seattle Stadium",
    "Kansas City Stadium",
  ];

  const seededFixtures = buildSeededFixtures();

  const matchPoints = {
    "group-1": 1,
    "group-2": 1.2,
    "group-3": 1.3,
    "round-32": 1.5,
    "round-16": 2.5,
    quarter: 5,
    semi: 7,
    third: 8,
    final: 12,
  };

  const state = loadState();
  const dom = {};
  let authMode = "login";
  let supabaseClient = null;
  let supabaseReady = false;
  let supabaseInitPromise = null;
  let supabaseInitError = "";
  let tournamentLockAt = new Date(DEFAULT_TOURNAMENT_LOCK_AT);
  let liveFixtures = [];
  let fixtureIdByMatchId = {};
  let remoteLeaderboard = [];

  document.addEventListener("DOMContentLoaded", () => {
    init();
  });

  async function init() {
    cacheDom();
    bindEvents();
    refreshAll();
    supabaseInitPromise = initializeSupabase();
    await supabaseInitPromise;
    refreshAll();
    setInterval(renderMatches, 60000);
  }

  function cacheDom() {
    [
      "groupsGrid",
      "thirdPlaceGrid",
      "thirdCounter",
      "knockoutGrid",
      "placementGrid",
      "bracketSubmitStatus",
      "finalizeBracket",
      "projectedScore",
      "lockNote",
      "saveStatus",
      "authButton",
      "authDialog",
      "authForm",
      "authTitle",
      "authEyebrow",
      "authSubmit",
      "loginMode",
      "signupMode",
      "closeAuth",
      "googleMock",
      "usernameInput",
      "passwordInput",
      "resetGroups",
      "clearKnockout",
      "refreshMatches",
      "matchSummary",
      "matchesList",
      "profilePanel",
      "leaderboard",
      "exportCsv",
      "rulesGrid",
    ].forEach((id) => {
      dom[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });

    dom.resetGroups.addEventListener("click", () => {
      state.groups = cloneGroups(initialGroups);
      state.thirdQualifiers = defaultThirdQualifiers();
      state.knockoutPicks = {};
      persist();
      refreshAll();
    });

    dom.clearKnockout.addEventListener("click", () => {
      state.knockoutPicks = {};
      persist();
      refreshAll();
    });

    dom.finalizeBracket.addEventListener("click", finalizeBracketPrediction);

    dom.refreshMatches.addEventListener("click", () => {
      renderMatches();
      flashSave("Match list refreshed");
    });

    dom.authButton.addEventListener("click", () => {
      setAuthMode(state.user ? "login" : "login");
      dom.authDialog.showModal();
    });

    dom.closeAuth.addEventListener("click", () => dom.authDialog.close());

    dom.loginMode.addEventListener("click", () => setAuthMode("login"));
    dom.signupMode.addEventListener("click", () => setAuthMode("signup"));
    dom.exportCsv.addEventListener("click", exportSpreadsheet);

    dom.authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await authenticate(authMode);
    });

    dom.googleMock.addEventListener("click", async () => {
      await signInWithGoogle();
    });
  }

  async function initializeSupabase() {
    supabaseInitError = "";
    const supabaseApi = window.supabase || globalThis.supabase;
    if (!API_ENABLED) {
      supabaseInitError = "Open the site through http, not as a file.";
      flashSave("Local file mode");
      return;
    }
    if (!supabaseApi?.createClient) {
      supabaseInitError = "Supabase client script did not load.";
      flashSave(LOCAL_API_ENABLED ? "Local CSV mode" : supabaseInitError);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/config`);
      if (!response.ok) throw new Error(`/api/config returned ${response.status}`);
      const config = await response.json();
      if (!config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error("Supabase env vars are missing from /api/config.");
      }
      tournamentLockAt = parseLockDate(config.tournamentLockAt);

      supabaseClient = supabaseApi.createClient(config.supabaseUrl, config.supabaseAnonKey);
      supabaseReady = true;
      await hydrateSupabaseSession();
      await loadFixturesFromSupabase();
      await loadLeaderboardFromSupabase();
      flashSave("Supabase connected");
    } catch (error) {
      supabaseReady = false;
      supabaseInitError = error.message || "Supabase setup failed.";
      flashSave(LOCAL_API_ENABLED ? "Local CSV mode" : error.message);
    }
  }

  async function hydrateSupabaseSession() {
    if (!supabaseReady) return;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session?.user) return;
    await setUserFromSupabase(data.session.user);
    await loadRemotePredictions(data.session.user.id);
  }

  function setAuthMode(mode) {
    authMode = mode;
    const isLogin = mode === "login";
    dom.authTitle.textContent = isLogin ? "Log in" : "Create Predictor Profile";
    dom.authEyebrow.textContent = isLogin ? "Welcome back" : "Save your entry";
    dom.authSubmit.textContent = isLogin ? "Log in" : "Sign up";
    dom.usernameInput.required = true;
    dom.loginMode.classList.toggle("active", isLogin);
    dom.signupMode.classList.toggle("active", !isLogin);
  }

  async function authenticate(mode, override) {
    const payload = override || {
      username: dom.usernameInput.value.trim(),
      password: dom.passwordInput.value,
      provider: "username",
    };
    const username = normalizeUsername(payload.username);
    if (!isValidUsername(username)) {
      flashSave("Use 3-24 letters, numbers, or underscores");
      return;
    }
    if (!payload.password) {
      flashSave("Password required");
      return;
    }
    payload.username = username;

    try {
      if (!supabaseReady && supabaseInitPromise) {
        await supabaseInitPromise;
      }
      if (supabaseReady) {
        state.user = await authenticateWithSupabase(mode, payload);
      } else if (LOCAL_API_ENABLED) {
        const response = await apiPost(`/api/${mode}`, payload);
        const previousUserKey = userSaveKey(state.user);
        state.user = response.user;
        if (userSaveKey(state.user) !== previousUserKey) {
          restoreLocalPredictionsForUser(state.user);
        }
      } else {
        throw new Error(supabaseInitError || "Supabase is not configured for this deployment.");
      }
      await persist();
      dom.authDialog.close();
      refreshAll();
    } catch (error) {
      flashSave(error.message || "Login failed");
    }
  }

  async function authenticateWithSupabase(mode, payload) {
    const username = normalizeUsername(payload.username);
    const email = authEmailForUsername(username);
    const password = payload.password;
    if (mode === "signup") {
      const createdUser = await createConfirmedSupabaseUser(username, password);
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.user) throw new Error("Signup failed. Please try again.");
      const profile =
        createdUser?.profile || (await getProfile(data.user.id)) || {
          id: data.user.id,
          username,
          display_name: username,
          email: "",
          avatar_url: "",
        };
      const nextUser = userFromProfile(data.user, profile);
      state.user = nextUser;
      await loadRemotePredictions(data.user.id);
      return nextUser;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await setUserFromSupabase(data.user);
    await loadRemotePredictions(data.user.id);
    return state.user;
  }

  async function createConfirmedSupabaseUser(username, password) {
    const response = await fetch(`${API_BASE}/api/supabase-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Signup failed");
    }
    return data.user;
  }

  async function signInWithGoogle() {
    if (!supabaseReady) {
      flashSave("Supabase is not configured");
      return;
    }
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin },
    });
    if (error) flashSave(error.message);
  }

  async function apiPost(path, payload) {
    const headers = { "Content-Type": "application/json" };
    if (supabaseReady && supabaseClient) {
      const { data } = await supabaseClient.auth.getSession();
      const accessToken = data.session?.access_token;
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function setUserFromSupabase(authUser) {
    const profile = await ensureProfile(authUser, authUser.user_metadata?.username || usernameFromAuthEmail(authUser.email));
    state.user = userFromProfile(authUser, profile);
  }

  async function ensureProfile(authUser, preferredUsername) {
    const fallbackUsername =
      normalizeUsername(preferredUsername) || normalizeUsername(usernameFromAuthEmail(authUser.email)) || `predictor_${authUser.id.slice(0, 8)}`;
    const publicEmail = isInternalAuthEmail(authUser.email) ? null : authUser.email;
    const existing = await getProfile(authUser.id);
    if (existing) return existing;

    if (isInternalAuthEmail(authUser.email)) {
      return repairSupabaseProfile(authUser.id, fallbackUsername);
    }

    return createOwnProfile({
      id: authUser.id,
      username: fallbackUsername,
      display_name: fallbackUsername,
      email: publicEmail,
      avatar_url: authUser.user_metadata?.avatar_url || "",
    });
  }

  async function getProfile(userId) {
    const { data: existing, error: selectError } = await supabaseClient
      .from("profiles")
      .select("id, username, display_name, email, avatar_url")
      .eq("id", userId)
      .maybeSingle();
    if (selectError) throw selectError;
    return existing;
  }

  async function createOwnProfile(profile) {
    const { data, error } = await supabaseClient.from("profiles").upsert(profile, { onConflict: "id" }).select().single();
    if (error) {
      const { data: retry } = await supabaseClient
        .from("profiles")
        .select("id, username, display_name, email, avatar_url")
        .eq("id", profile.id)
        .maybeSingle();
      if (retry) return retry;
      throw error;
    }
    return data;
  }

  async function repairSupabaseProfile(userId, username) {
    const response = await fetch(`${API_BASE}/api/supabase-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, username }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Profile could not be created.");
    }
    return data.profile;
  }

  function userFromProfile(authUser, profile) {
    return {
      id: authUser.id,
      username: profile.username,
      email: profile.email || "",
      provider: "supabase",
    };
  }

  async function loadRemotePredictions(userId) {
    resetPredictions();

    const { data: tournamentPrediction } = await supabaseClient
      .from("tournament_predictions")
      .select("group_rankings, third_place_qualifiers, knockout_picks, locked_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (tournamentPrediction) {
      state.groups = tournamentPrediction.group_rankings || cloneGroups(initialGroups);
      state.thirdQualifiers = normalizeThirdQualifiers(tournamentPrediction.third_place_qualifiers || defaultThirdQualifiers());
      state.knockoutPicks = tournamentPrediction.knockout_picks || {};
      state.bracketFinalizedAt = tournamentPrediction.locked_at || "";
    }

    const { data: matchPredictions, error: matchSelectError } = await supabaseClient
      .from("match_predictions")
      .select("fixture_id, predicted_home_score, predicted_away_score, predicted_outcome, locked_at")
      .eq("user_id", userId);
    if (matchSelectError) throw matchSelectError;

    if (!tournamentPrediction && !matchPredictions?.length) {
      restoreLocalPredictionsForUser(state.user);
      return;
    }

    if (matchPredictions?.length) {
      const fixtureIds = [...new Set(matchPredictions.map((prediction) => prediction.fixture_id).filter(Boolean))];
      const fixtureMap = {};
      if (fixtureIds.length) {
        const { data: fixtures, error: fixtureSelectError } = await supabaseClient
          .from("fixtures")
          .select("id, fifa_match_id")
          .in("id", fixtureIds);
        if (fixtureSelectError) throw fixtureSelectError;
        fixtures?.forEach((fixture) => {
          fixtureMap[fixture.id] = fixture.fifa_match_id;
        });
      }

      matchPredictions.forEach((prediction) => {
        const matchId = fixtureMap[prediction.fixture_id];
        if (!matchId) return;
        state.matchPredictions[matchId] = {
          home: String(prediction.predicted_home_score),
          away: String(prediction.predicted_away_score),
          outcome: titleCase(prediction.predicted_outcome),
          finalizedAt: prediction.locked_at || "",
        };
      });
    }
    persistLocalState();
  }

  async function loadFixturesFromSupabase() {
    const { data, error } = await supabaseClient
      .from("fixtures")
      .select("id, fifa_match_id, round, group_code, home_team, away_team, kickoff_at, venue, status, home_score, away_score, winner_team")
      .order("kickoff_at", { ascending: true });
    if (error) throw error;
    if (!data?.length) return;
    liveFixtures = data.map(toAppFixture);
    fixtureIdByMatchId = Object.fromEntries(liveFixtures.map((fixture) => [fixture.id, fixture.fixtureId]));
  }

  async function loadLeaderboardFromSupabase() {
    if (!supabaseReady) return;
    const { data } = await supabaseClient
      .from("leaderboard")
      .select("user_id, username, total_score, bracket_score, match_score, rank")
      .order("rank", { ascending: true })
      .limit(25);
    remoteLeaderboard = data || [];
  }

  function switchTab(tab) {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === tab);
    });
  }

  function refreshAll() {
    renderHeader();
    renderBracketSubmit();
    renderGroups();
    renderThirds();
    renderKnockout();
    renderPlacements();
    renderMatches();
    renderStanding();
    renderRules();
  }

  function renderHeader() {
    const locked = isTournamentStarted();
    dom.lockNote.textContent = locked
      ? "Whole bracket is locked because the World Cup has started."
      : "Points stay 0 until official results are loaded.";
    dom.authButton.textContent = state.user ? state.user.username : "Log in / Sign up";
    dom.projectedScore.textContent = `${calculateBracketScore().toFixed(1)} pts`;
  }

  function renderBracketSubmit() {
    const complete = isBracketComplete();
    const finalized = Boolean(state.bracketFinalizedAt);
    dom.bracketSubmitStatus.textContent = finalized
      ? `Submitted ${formatDate(state.bracketFinalizedAt)}`
      : complete
      ? "Ready to submit. Draft already autosaves."
      : "Draft autosaves while you complete every knockout pick.";
    dom.finalizeBracket.textContent = finalized ? "Bracket submitted" : "Submit bracket";
    dom.finalizeBracket.disabled = finalized || !complete || !state.user || isTournamentStarted();
    dom.resetGroups.disabled = finalized || isTournamentStarted();
    dom.clearKnockout.disabled = finalized || isTournamentStarted();
  }

  function renderGroups() {
    dom.groupsGrid.innerHTML = "";
    Object.entries(state.groups).forEach(([group, teams]) => {
      const card = el("article", "group-card");
      card.innerHTML = `<div class="group-title"><span>Group ${group}</span><small>Drag 1-4</small></div>`;
      const list = el("ol", "team-list");
      teams.forEach((item, index) => {
        const li = el("li", "team-item");
        li.draggable = !isBracketLocked();
        li.dataset.group = group;
        li.dataset.index = index;
        li.innerHTML = `
          <span class="rank-badge">${index + 1}</span>
          <span>${escapeHtml(item.name)}</span>
          <span class="team-code">${item.code}</span>
        `;
        li.addEventListener("dragstart", onDragStart);
        li.addEventListener("dragover", onDragOver);
        li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
        li.addEventListener("drop", onDrop);
        list.appendChild(li);
      });
      card.appendChild(list);
      dom.groupsGrid.appendChild(card);
    });
  }

  function renderThirds() {
    const thirds = Object.entries(state.groups).map(([group, teams]) => ({ group, team: teams[2] }));
    state.thirdQualifiers = normalizeThirdQualifiers(state.thirdQualifiers);
    dom.thirdCounter.textContent = `${state.thirdQualifiers.length} / 8 selected`;
    dom.thirdPlaceGrid.innerHTML = "";
    thirds.forEach(({ group, team: item }) => {
      const selected = state.thirdQualifiers.includes(group);
      const disabled = !selected && state.thirdQualifiers.length >= 8;
      const button = el("button", `third-button${selected ? " selected" : ""}`);
      button.disabled = disabled || isBracketLocked();
      button.innerHTML = `
        <span><strong>Group ${group}</strong><br>${escapeHtml(item.name)}</span>
        <span class="team-code">${selected ? "QUAL" : "OUT"}</span>
      `;
      button.addEventListener("click", () => {
        if (selected) {
          state.thirdQualifiers = state.thirdQualifiers.filter((g) => g !== group);
        } else if (state.thirdQualifiers.length < 8) {
          state.thirdQualifiers.push(group);
        }
        state.knockoutPicks = {};
        persist();
        refreshAll();
      });
      dom.thirdPlaceGrid.appendChild(button);
    });
  }

  function renderKnockout() {
    const rounds = buildKnockoutRounds();
    dom.knockoutGrid.innerHTML = "";
    rounds.forEach((round) => {
      const column = el("div", "round-column");
      column.appendChild(textEl("div", "round-title", round.name));
      round.matches.forEach((match) => {
        const box = el("div", "ko-match");
        box.innerHTML = `<span class="ko-label">${match.id}</span>`;
        match.teams.forEach((item) => {
          const isActive = Boolean(item && state.knockoutPicks[match.id] === item.code);
          const button = el("button", `team-pick${isActive ? " active" : ""}`);
          button.disabled = !item || isBracketLocked();
          button.textContent = item ? item.name : "TBD";
          button.addEventListener("click", () => {
            state.knockoutPicks[match.id] = item.code;
            clearDownstream(match.id);
            persist();
            refreshAll();
          });
          box.appendChild(button);
        });
        column.appendChild(box);
      });
      dom.knockoutGrid.appendChild(column);
    });
  }

  function renderPlacements() {
    const placements = calculatePlacements();
    const order = [
      ["winner", "1 Winner"],
      ["runner", "2 Runner-up"],
      ["third", "3 Third place"],
      ["fourth", "4 Fourth place"],
      ["qf", "5-8"],
      ["r16", "9-16"],
      ["r32", "17-32"],
      ["grouped", "Grouped"],
    ];
    dom.placementGrid.innerHTML = "";
    order.forEach(([key, title]) => {
      const card = el("article", "placement-card");
      const teams = placements[key] || [];
      card.innerHTML = `<strong>${title}</strong>`;
      const list = el("div", "team-chip-list");
      if (teams.length) {
        teams.forEach((item) => list.appendChild(textEl("span", "team-chip", item.name)));
      } else {
        list.appendChild(textEl("span", "muted", "Waiting for picks"));
      }
      card.appendChild(list);
      dom.placementGrid.appendChild(card);
    });
  }

  function renderMatches() {
    const now = Date.now();
    const fixtures = getLiveFixtures().sort((a, b) => a.kickoff - b.kickoff);
    const done = fixtures.filter((match) => match.kickoff < now);
    const upcoming = fixtures.filter((match) => match.kickoff >= now);
    const nearestIds = new Set(upcoming.slice(0, 3).map((match) => match.id));
    const currentRound = detectCurrentRound(fixtures, now);
    const ordered = [...done.reverse(), ...upcoming];

    dom.matchSummary.innerHTML = "";
    upcoming.slice(0, 3).forEach((match) => {
      const card = el("article", "match-card nearest");
      card.innerHTML = `
        <div>
          <div class="match-teams">${escapeHtml(match.home)} vs ${escapeHtml(match.away)}</div>
          <div class="match-meta">${formatDate(match.kickoff)} · ${escapeHtml(match.venue)}</div>
        </div>
      `;
      dom.matchSummary.appendChild(card);
    });

    dom.matchesList.innerHTML = "";
    ordered.forEach((match) => {
      const isNearest = nearestIds.has(match.id);
      const canPredict = match.kickoff > now && match.round === currentRound;
      const shouldFade = !isNearest && (!canPredict || match.kickoff < now);
      const card = el("article", `match-card${isNearest ? " nearest" : ""}${shouldFade ? " faded" : ""}`);
      const prediction = state.matchPredictions[match.id] || {};
      const finalized = Boolean(prediction.finalizedAt);
      const canEdit = canPredict && !finalized;
      const isPast = match.kickoff < now;
      const resultText = match.result ? `Result ${match.result.home}-${match.result.away}` : isPast ? "Awaiting official result" : "Result pending";
      const status = finalized ? "Submitted" : match.result ? scorePredictionLabel(match, prediction) : canPredict ? "Open" : "Locked";
      const predictionText = matchPredictionText(match, prediction);
      card.innerHTML = `
        <div>
          <div class="match-teams">${escapeHtml(match.home)} vs ${escapeHtml(match.away)}</div>
          <div class="match-meta">${formatDate(match.kickoff)} · ${escapeHtml(match.venue)} · ${escapeHtml(match.label)} · ${resultText} · ${status}</div>
          <div class="match-prediction">${escapeHtml(predictionText)}</div>
        </div>
      `;
      const box = el("div", "prediction-box");
      const home = scoreInput(prediction.home, canEdit);
      const away = scoreInput(prediction.away, canEdit);
      const select = el("select");
      select.disabled = !canEdit;
      const outcomes = match.round.startsWith("group") ? ["Home", "Draw", "Away"] : ["Home", "Away"];
      outcomes.forEach((outcome) => {
        const option = el("option");
        option.value = outcome;
        option.textContent = outcome === "Home" ? `${match.home} win` : outcome === "Away" ? `${match.away} win` : "Draw";
        option.selected = prediction.outcome === outcome;
        select.appendChild(option);
      });
      [home, away].forEach((control) => {
        control.addEventListener("input", () => {
          const inferredOutcome = inferOutcomeFromScore(home.value, away.value, outcomes);
          if (inferredOutcome) select.value = inferredOutcome;
        });
      });
      [home, away, select].forEach((control) => {
        control.addEventListener("change", () => {
          const inferredOutcome = control === select ? "" : inferOutcomeFromScore(home.value, away.value, outcomes);
          if (inferredOutcome) select.value = inferredOutcome;
          state.matchPredictions[match.id] = {
            home: home.value,
            away: away.value,
            outcome: select.value,
            finalizedAt: prediction.finalizedAt || "",
          };
          persist();
          renderStanding();
          const nextPrediction = { home: home.value, away: away.value, outcome: select.value };
          submit.disabled = !canPredict || !state.user || !isMatchPredictionComplete(nextPrediction);
          help.textContent = matchSubmitHelp(match, nextPrediction, canPredict, finalized);
        });
      });
      const submit = el("button", "primary-button small match-submit");
      const help = textEl("small", "match-help", matchSubmitHelp(match, prediction, canPredict, finalized));
      submit.type = "button";
      submit.textContent = finalized ? "Submitted" : "Submit";
      submit.disabled = finalized || !canPredict || !state.user || !isMatchPredictionComplete({ home: home.value, away: away.value, outcome: select.value });
      submit.addEventListener("click", () => finalizeMatchPrediction(match.id, home.value, away.value, select.value));
      box.append(home, away, select, submit, help);
      card.appendChild(box);
      dom.matchesList.appendChild(card);
    });
  }

  function inferOutcomeFromScore(homeScore, awayScore, outcomes) {
    if (homeScore === "" || awayScore === "") return "";
    const homeValue = Number(homeScore);
    const awayValue = Number(awayScore);
    if (!Number.isFinite(homeValue) || !Number.isFinite(awayValue)) return "";
    if (homeValue > awayValue) return "Home";
    if (awayValue > homeValue) return "Away";
    return outcomes.includes("Draw") ? "Draw" : "";
  }

  function matchPredictionText(match, prediction) {
    if (!isMatchPredictionComplete(prediction)) return "Your prediction: none";
    const outcome =
      prediction.outcome === "Home"
        ? `${match.home} win`
        : prediction.outcome === "Away"
        ? `${match.away} win`
        : "Draw";
    return `Your prediction: ${prediction.home}-${prediction.away}, ${outcome}`;
  }

  function matchSubmitHelp(match, prediction, canPredict, finalized) {
    if (finalized) return "Saved";
    if (!canPredict) return match.kickoff <= Date.now() ? "Kickoff passed" : "Locked until this round opens";
    if (!state.user) return "Log in to submit";
    if (!isMatchPredictionComplete(prediction)) return "Enter score first";
    return "Ready";
  }

  async function finalizeBracketPrediction() {
    if (!state.user) {
      flashSave("Log in before submitting");
      return;
    }
    if (state.bracketFinalizedAt) {
      flashSave("Bracket already submitted");
      return;
    }
    if (isTournamentStarted()) {
      flashSave("Bracket submission is closed");
      return;
    }
    if (!isBracketComplete()) {
      flashSave("Finish every knockout pick first");
      return;
    }
    const previousFinalizedAt = state.bracketFinalizedAt;
    state.bracketFinalizedAt = new Date().toISOString();
    const saved = await persist();
    if (!saved) {
      state.bracketFinalizedAt = previousFinalizedAt;
      persistLocalState();
      refreshAll();
      return;
    }
    refreshAll();
    flashSave("Bracket submitted");
  }

  async function finalizeMatchPrediction(matchId, home, away, outcome) {
    if (!state.user) {
      flashSave("Log in before submitting");
      return;
    }
    const match = getLiveFixtures().find((item) => item.id === matchId);
    if (!match || match.kickoff <= Date.now()) {
      flashSave("Match submission is closed");
      return;
    }
    if (!isMatchPredictionComplete({ home, away, outcome })) {
      flashSave("Enter score and result first");
      return;
    }
    const previousPrediction = state.matchPredictions[matchId] || {};
    state.matchPredictions[matchId] = {
      home,
      away,
      outcome,
      finalizedAt: new Date().toISOString(),
    };
    const saved = await persist();
    if (!saved) {
      state.matchPredictions[matchId] = previousPrediction;
      persistLocalState();
      renderMatches();
      renderStanding();
      return;
    }
    renderMatches();
    renderStanding();
    flashSave("Match submitted");
  }

  function renderStanding() {
    const matchScore = calculateMatchScore();
    const bracketScore = calculateBracketScore();
    const total = bracketScore + matchScore;
    const hasPredictions = hasAnyPrediction();
    const hasResults = hasAnyResults();

    if (!state.user) {
      dom.profilePanel.innerHTML = `<div class="empty-state">Log in or sign up before your predictions are saved to the spreadsheet.</div>`;
    } else {
      dom.profilePanel.innerHTML = `
        <p><strong>${escapeHtml(state.user.username)}</strong></p>
        ${state.user.email ? `<p class="muted">${escapeHtml(state.user.email)}</p>` : ""}
        <p>Bracket: <strong>${bracketScore.toFixed(1)} pts</strong></p>
        <p>Matches: <strong>${matchScore.toFixed(1)} pts</strong></p>
        <p>Total: <strong>${total.toFixed(1)} pts</strong></p>
        <p class="muted">${hasResults ? "Results loaded, points are active." : "Points stay empty until official results are loaded."}</p>
      `;
    }

    dom.leaderboard.innerHTML = "";
    if (!state.user || !hasPredictions || !hasResults) {
      dom.leaderboard.innerHTML = `<div class="empty-state">No standings yet. Users appear here after they log in, make predictions, and official results are available.</div>`;
      return;
    }

    const rows = remoteLeaderboard.length
      ? remoteLeaderboard.map((row) => ({
          username: row.username,
          points: Number(row.total_score || 0),
          rank: row.rank,
          current: row.user_id === state.user?.id,
        }))
      : [{ username: state.user.username, points: total, current: true }];
    rows.forEach((row, index) => {
      const item = el("div", `leaderboard-row${row.current ? " current" : ""}`);
      item.innerHTML = `
        <strong>#${row.rank || index + 1}</strong>
        <span>${escapeHtml(row.username)}</span>
        <strong>${row.points.toFixed(1)}</strong>
      `;
      dom.leaderboard.appendChild(item);
    });
  }

  function renderRules() {
    const rules = [
      "Grouped: 1 point per correct nation",
      "17-32: 1.5 points",
      "9-16: 2 points",
      "5-8: 3.5 points",
      "3-4 range: 5 points, exact 3rd or 4th: 6.5",
      "Grand final participant: 8 points",
      "Runner-up: 10 points",
      "Winner: 15 points",
      "50% in grouped / 17-32 / 9-16: +2, 75%: +5",
      "All 3rd, 4th, finalists, runner-up, winner right: +7.5",
      "Match exact score doubles the round points",
      "Match points rise from 1 in group MD1 to 12 in the final",
    ];
    dom.rulesGrid.innerHTML = "";
    rules.forEach((rule) => {
      dom.rulesGrid.appendChild(textEl("div", "rule-card", rule));
    });
  }

  function onDragStart(event) {
    event.dataTransfer.setData(
      "application/json",
      JSON.stringify({ group: event.currentTarget.dataset.group, index: Number(event.currentTarget.dataset.index) })
    );
  }

  function onDragOver(event) {
    event.preventDefault();
    event.currentTarget.classList.add("drag-over");
  }

  function onDrop(event) {
    event.preventDefault();
    const target = event.currentTarget;
    target.classList.remove("drag-over");
    const source = JSON.parse(event.dataTransfer.getData("application/json"));
    const group = target.dataset.group;
    const targetIndex = Number(target.dataset.index);
    if (source.group !== group || source.index === targetIndex) return;
    const teams = state.groups[group];
    const [moved] = teams.splice(source.index, 1);
    teams.splice(targetIndex, 0, moved);
    state.knockoutPicks = {};
    persist();
    refreshAll();
  }

  function buildKnockoutRounds() {
    const thirdMap = assignThirdPlaces();
    const seed = (type, group) => {
      const index = type === "W" ? 0 : type === "R" ? 1 : 2;
      return state.groups[group]?.[index] || null;
    };
    const third = (slot) => {
      const group = thirdMap[slot];
      return group ? seed("T", group) : null;
    };
    const r32 = [
      ko("R32-1", seed("W", "A"), third("1A")),
      ko("R32-2", seed("R", "A"), seed("R", "B")),
      ko("R32-3", seed("W", "C"), seed("R", "F")),
      ko("R32-4", seed("W", "E"), third("1E")),
      ko("R32-5", seed("W", "I"), third("1I")),
      ko("R32-6", seed("R", "E"), seed("R", "I")),
      ko("R32-7", seed("W", "G"), third("1G")),
      ko("R32-8", seed("R", "C"), seed("W", "F")),
      ko("R32-9", seed("W", "B"), third("1B")),
      ko("R32-10", seed("W", "D"), third("1D")),
      ko("R32-11", seed("R", "D"), seed("R", "G")),
      ko("R32-12", seed("W", "H"), seed("R", "J")),
      ko("R32-13", seed("W", "J"), seed("R", "H")),
      ko("R32-14", seed("W", "K"), third("1K")),
      ko("R32-15", seed("W", "L"), third("1L")),
      ko("R32-16", seed("R", "K"), seed("R", "L")),
    ];
    const r16 = pairRound("R16", r32);
    const qf = pairRound("QF", r16);
    const sf = pairRound("SF", qf);
    const final = [ko("FINAL", winner(sf[0]), winner(sf[1]))];
    const thirdMatch = [ko("THIRD", loser(sf[0]), loser(sf[1]))];
    return [
      { name: "Round of 32", matches: r32 },
      { name: "Round of 16", matches: r16 },
      { name: "Quarter-finals", matches: qf },
      { name: "Semi-finals", matches: sf },
      { name: "Final", matches: final },
      { name: "Third place", matches: thirdMatch },
    ];
  }

  function pairRound(prefix, previous) {
    const matches = [];
    for (let i = 0; i < previous.length; i += 2) {
      matches.push(ko(`${prefix}-${i / 2 + 1}`, winner(previous[i]), winner(previous[i + 1])));
    }
    return matches;
  }

  function winner(match) {
    if (!match) return null;
    const code = state.knockoutPicks[match.id];
    return match.teams.find((item) => item?.code === code) || null;
  }

  function loser(match) {
    if (!match) return null;
    const code = state.knockoutPicks[match.id];
    if (!code) return null;
    return match.teams.find((item) => item?.code !== code) || null;
  }

  function clearDownstream(matchId) {
    const prefixes = ["R32", "R16", "QF", "SF", "FINAL", "THIRD"];
    const currentIndex = prefixes.findIndex((prefix) => matchId.startsWith(prefix));
    Object.keys(state.knockoutPicks).forEach((id) => {
      const index = prefixes.findIndex((prefix) => id.startsWith(prefix));
      if (index > currentIndex) delete state.knockoutPicks[id];
    });
  }

  function assignThirdPlaces() {
    const preferences = {
      "1A": ["C", "E", "F", "H", "I", "D", "J", "L"],
      "1B": ["E", "F", "G", "H", "J", "C", "I", "K"],
      "1D": ["B", "C", "E", "G", "I", "J", "A", "L"],
      "1E": ["A", "B", "C", "D", "F", "G", "H", "K"],
      "1G": ["A", "B", "E", "H", "I", "J", "C", "L"],
      "1I": ["C", "D", "E", "G", "H", "J", "B", "K"],
      "1K": ["D", "E", "I", "J", "L", "A", "F", "G"],
      "1L": ["A", "C", "D", "F", "I", "K", "L", "B"],
    };
    const available = [...state.thirdQualifiers];
    const assigned = {};
    Object.entries(preferences).forEach(([slot, list]) => {
      const group = list.find((candidate) => available.includes(candidate)) || available[0];
      if (group) {
        assigned[slot] = group;
        available.splice(available.indexOf(group), 1);
      }
    });
    return assigned;
  }

  function calculatePlacements() {
    const rounds = buildKnockoutRounds();
    const r32 = rounds[0].matches;
    const r16 = rounds[1].matches;
    const qf = rounds[2].matches;
    const sf = rounds[3].matches;
    const final = rounds[4].matches[0];
    const third = rounds[5].matches[0];
    const advancedCodes = new Set([
      ...Object.entries(state.groups).flatMap(([group, teams]) => [
        teams[0].code,
        teams[1].code,
        ...(state.thirdQualifiers.includes(group) ? [teams[2].code] : []),
      ]),
    ]);
    const allTeams = Object.values(state.groups).flat();
    return {
      winner: compact([winner(final)]),
      runner: compact([loser(final)]),
      third: compact([winner(third)]),
      fourth: compact([loser(third)]),
      qf: qf.map(loser).filter(Boolean),
      r16: r16.map(loser).filter(Boolean),
      r32: r32.map(loser).filter(Boolean),
      grouped: allTeams.filter((item) => !advancedCodes.has(item.code)),
    };
  }

  function calculateBracketScore() {
    return hasAnyResults() ? 0 : 0;
  }

  function calculateMatchScore() {
    return getLiveFixtures().reduce((total, match) => {
      const prediction = state.matchPredictions[match.id];
      if (!prediction || !match.result) return total;
      const base = matchPoints[match.round] || 0;
      const actualOutcome = match.result.home === match.result.away ? "Draw" : match.result.home > match.result.away ? "Home" : "Away";
      if (prediction.outcome !== actualOutcome) return total;
      const exact = Number(prediction.home) === match.result.home && Number(prediction.away) === match.result.away;
      return total + (exact ? base * 2 : base);
    }, 0);
  }

  function scorePredictionLabel(match, prediction) {
    if (!prediction.outcome) return "No prediction";
    const actualOutcome = match.result.home === match.result.away ? "Draw" : match.result.home > match.result.away ? "Home" : "Away";
    const exact = Number(prediction.home) === match.result.home && Number(prediction.away) === match.result.away;
    if (prediction.outcome !== actualOutcome) return "Wrong";
    return exact ? "Exact score" : "Correct result";
  }

  function detectCurrentRound(fixtures, now) {
    const upcoming = fixtures.find((match) => match.kickoff >= now);
    return upcoming ? upcoming.round : "final";
  }

  function getLiveFixtures() {
    return (liveFixtures.length ? liveFixtures : seededFixtures).map((match) => ({ ...match }));
  }

  async function persist() {
    persistLocalState();
    if (supabaseReady && state.user?.id) {
      try {
        await apiPost("/api/supabase-save", serializeSubmission());
        await loadLeaderboardFromSupabase();
      } catch (error) {
        flashSave(error.message || "Supabase save failed");
        return false;
      }
    } else if (LOCAL_API_ENABLED && state.user) {
      try {
        await apiPost("/api/save", serializeSubmission());
      } catch (error) {
        flashSave("Saved locally; spreadsheet offline");
        return false;
      }
    }
    flashSave("Saved");
    return true;
  }

  function persistLocalState() {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    const key = userSaveKey(state.user);
    if (key) {
      localStorage.setItem(key, JSON.stringify(state));
    }
  }

  async function saveToSupabase() {
    await saveTournamentPrediction();
    await saveMatchPredictions();
    await saveScoreSnapshot();
    await loadLeaderboardFromSupabase();
  }

  async function saveTournamentPrediction() {
    const payload = {
      user_id: state.user.id,
      group_rankings: state.groups,
      third_place_qualifiers: state.thirdQualifiers,
      knockout_picks: state.knockoutPicks,
      final_placements: calculatePlacements(),
      locked_at: state.bracketFinalizedAt || null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing, error: selectError } = await supabaseClient
      .from("tournament_predictions")
      .select("id")
      .eq("user_id", state.user.id)
      .maybeSingle();
    if (selectError) throw selectError;

    const result = existing
      ? await supabaseClient.from("tournament_predictions").update(payload).eq("id", existing.id)
      : await supabaseClient.from("tournament_predictions").insert({ ...payload, submitted_at: new Date().toISOString() });
    if (result.error) throw result.error;
  }

  async function saveMatchPredictions() {
    const entries = [];
    Object.entries(state.matchPredictions).forEach(([matchId, prediction]) => {
      if (prediction.home === "" || prediction.away === "") return;
      const fixtureId = fixtureIdByMatchId[matchId];
      if (!fixtureId) {
        if (prediction.finalizedAt) {
          throw new Error("Match schedule is not synced to Supabase yet.");
        }
        return;
      }
      entries.push({
        user_id: state.user.id,
        fixture_id: fixtureId,
        predicted_home_score: Number(prediction.home),
        predicted_away_score: Number(prediction.away),
        predicted_outcome: String(prediction.outcome || "").toLowerCase(),
        locked_at: prediction.finalizedAt || null,
        updated_at: new Date().toISOString(),
      });
    });

    if (!entries.length) return;
    const { error } = await supabaseClient.from("match_predictions").upsert(entries, {
      onConflict: "user_id,fixture_id",
    });
    if (error) throw error;
  }

  async function saveScoreSnapshot() {
    const bracketScore = calculateBracketScore();
    const matchScore = calculateMatchScore();
    const payload = {
      user_id: state.user.id,
      bracket_score: bracketScore,
      match_score: matchScore,
      total_score: bracketScore + matchScore,
      exact_scores_count: 0,
      correct_results_count: 0,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabaseClient.from("scores").upsert(payload, {
      onConflict: "user_id",
    });
    if (error) throw error;
  }

  function hasAnyPrediction() {
    return Boolean(
      Object.keys(state.knockoutPicks).length ||
        Object.keys(state.matchPredictions).length ||
        JSON.stringify(state.groups) !== JSON.stringify(initialGroups) ||
        JSON.stringify(state.thirdQualifiers) !== JSON.stringify(defaultThirdQualifiers())
    );
  }

  function hasAnyResults() {
    return getLiveFixtures().some((match) => Boolean(match.result));
  }

  function serializeSubmission() {
    const bracketScore = calculateBracketScore();
    const matchScore = calculateMatchScore();
    return {
      user: state.user,
      groups: state.groups,
      thirdQualifiers: state.thirdQualifiers,
      knockoutPicks: state.knockoutPicks,
      matchPredictions: state.matchPredictions,
      finalPlacements: calculatePlacements(),
      bracketFinalizedAt: state.bracketFinalizedAt || "",
      bracketScore,
      matchScore,
      totalScore: bracketScore + matchScore,
      hasPredictions: hasAnyPrediction(),
      hasResults: hasAnyResults(),
    };
  }

  function exportSpreadsheet() {
    if (LOCAL_API_ENABLED && !supabaseReady) {
      window.location.href = `${API_BASE}/api/export`;
      return;
    }
    const csv = buildLocalCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = "world-cup-predictor-data.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function buildLocalCsv() {
    const submission = serializeSubmission();
    const row = [
      new Date().toISOString(),
      submission.user?.username || "",
      submission.user?.email || "",
      submission.hasPredictions,
      submission.hasResults,
      submission.bracketScore,
      submission.matchScore,
      submission.totalScore,
      JSON.stringify(submission.groups),
      JSON.stringify(submission.thirdQualifiers),
      JSON.stringify(submission.knockoutPicks),
      JSON.stringify(submission.matchPredictions),
    ];
    return [
      [
        "saved_at",
        "username",
        "email",
        "has_predictions",
        "has_results",
        "bracket_score",
        "match_score",
        "total_score",
        "groups_json",
        "third_qualifiers_json",
        "knockout_picks_json",
        "match_predictions_json",
      ].join(","),
      row.map(csvEscape).join(","),
    ].join("\n");
  }

  function loadState() {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          groups: parsed.groups || cloneGroups(initialGroups),
          thirdQualifiers: normalizeThirdQualifiers(parsed.thirdQualifiers || defaultThirdQualifiers()),
          knockoutPicks: parsed.knockoutPicks || {},
          matchPredictions: parsed.matchPredictions || {},
          bracketFinalizedAt: parsed.bracketFinalizedAt || "",
          user: parsed.user || null,
        };
      } catch (error) {
        console.warn("Could not parse saved predictor state", error);
      }
    }
    return {
      groups: cloneGroups(initialGroups),
      thirdQualifiers: defaultThirdQualifiers(),
      knockoutPicks: {},
      matchPredictions: {},
      bracketFinalizedAt: "",
      user: null,
    };
  }

  function flashSave(message) {
    dom.saveStatus.textContent = message;
    window.clearTimeout(flashSave.timer);
    flashSave.timer = window.setTimeout(() => {
      dom.saveStatus.textContent = "Local save ready";
    }, 1400);
  }

  function isBracketLocked() {
    return Boolean(state.bracketFinalizedAt) || isTournamentStarted();
  }

  function isTournamentStarted() {
    return Date.now() >= tournamentLockAt.getTime();
  }

  function parseLockDate(value) {
    const date = new Date(value || DEFAULT_TOURNAMENT_LOCK_AT);
    if (Number.isNaN(date.getTime())) return new Date(DEFAULT_TOURNAMENT_LOCK_AT);
    return date;
  }

  function isBracketComplete() {
    if (state.thirdQualifiers.length !== 8) return false;
    return buildKnockoutRounds().every((round) =>
      round.matches.every((match) => match.teams.every(Boolean) && Boolean(state.knockoutPicks[match.id]))
    );
  }

  function isMatchPredictionComplete(prediction) {
    return prediction.home !== "" && prediction.away !== "" && Boolean(prediction.outcome);
  }

  function defaultThirdQualifiers() {
    return Object.keys(initialGroups).slice(0, 8);
  }

  function normalizeThirdQualifiers(groups) {
    const validGroups = Object.keys(initialGroups);
    const unique = [...new Set(Array.isArray(groups) ? groups : [])].filter((group) => validGroups.includes(group));
    return unique.slice(0, 8);
  }

  function cloneGroups(groups) {
    return JSON.parse(JSON.stringify(groups));
  }

  function resetPredictions() {
    state.groups = cloneGroups(initialGroups);
    state.thirdQualifiers = defaultThirdQualifiers();
    state.knockoutPicks = {};
    state.matchPredictions = {};
    state.bracketFinalizedAt = "";
  }

  function restoreLocalPredictionsForUser(user) {
    resetPredictions();
    const saved = localStorage.getItem(userSaveKey(user));
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      state.groups = parsed.groups || cloneGroups(initialGroups);
      state.thirdQualifiers = normalizeThirdQualifiers(parsed.thirdQualifiers || defaultThirdQualifiers());
      state.knockoutPicks = parsed.knockoutPicks || {};
      state.matchPredictions = parsed.matchPredictions || {};
      state.bracketFinalizedAt = parsed.bracketFinalizedAt || "";
    } catch (error) {
      console.warn("Could not parse saved user predictions", error);
    }
  }

  function userSaveKey(user) {
    if (!user) return "";
    return `${SAVE_KEY}:user:${user.id || user.username || ""}`;
  }

  function team(code, name) {
    return { code, name };
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

  function usernameFromAuthEmail(email) {
    const value = String(email || "").trim().toLowerCase();
    return isInternalAuthEmail(value) ? value.split("@")[0] : "";
  }

  function isInternalAuthEmail(email) {
    return String(email || "").trim().toLowerCase().endsWith(`@${INTERNAL_AUTH_DOMAIN}`);
  }

  function buildSeededFixtures() {
    const groupFixtures = buildGroupFixtures();
    const knockoutFixtures = buildKnockoutFixtures(groupFixtures.length + 1);
    return [...groupFixtures, ...knockoutFixtures];
  }

  function buildGroupFixtures() {
    const pairings = {
      "group-1": [
        [0, 1],
        [2, 3],
      ],
      "group-2": [
        [0, 2],
        [3, 1],
      ],
      "group-3": [
        [3, 0],
        [1, 2],
      ],
    };
    const dates = {
      "group-1": {
        A: "2026-06-11",
        B: "2026-06-12",
        C: "2026-06-13",
        D: "2026-06-13",
        E: "2026-06-14",
        F: "2026-06-14",
        G: "2026-06-15",
        H: "2026-06-15",
        I: "2026-06-16",
        J: "2026-06-16",
        K: "2026-06-17",
        L: "2026-06-17",
      },
      "group-2": {
        A: "2026-06-18",
        B: "2026-06-18",
        C: "2026-06-19",
        D: "2026-06-19",
        E: "2026-06-20",
        F: "2026-06-20",
        G: "2026-06-21",
        H: "2026-06-21",
        I: "2026-06-22",
        J: "2026-06-22",
        K: "2026-06-23",
        L: "2026-06-23",
      },
      "group-3": {
        A: "2026-06-24",
        B: "2026-06-24",
        C: "2026-06-24",
        D: "2026-06-25",
        E: "2026-06-25",
        F: "2026-06-25",
        G: "2026-06-26",
        H: "2026-06-26",
        I: "2026-06-26",
        J: "2026-06-27",
        K: "2026-06-27",
        L: "2026-06-27",
      },
    };
    const fixtures = [];
    let id = 1;
    Object.keys(pairings).forEach((round) => {
      Object.entries(initialGroups).forEach(([group, teams]) => {
        pairings[round].forEach(([homeIndex, awayIndex], pairIndex) => {
          const isOpener = id === 1;
          const iso = `${dates[round][group]}T${isOpener ? "12:00:00-06:00" : pairIndex === 0 ? "13:00:00-04:00" : "18:00:00-04:00"}`;
          fixtures.push(
            fx(
              `M${id}`,
              iso,
              round,
              `Group ${group}`,
              venues[(id - 1) % venues.length],
              teams[homeIndex].name,
              teams[awayIndex].name
            )
          );
          id += 1;
        });
      });
    });
    return fixtures;
  }

  function buildKnockoutFixtures(startId) {
    const rounds = [
      ["round-32", "Round of 32", "2026-06-28", 16],
      ["round-16", "Round of 16", "2026-07-04", 8],
      ["quarter", "Quarter-final", "2026-07-09", 4],
      ["semi", "Semi-final", "2026-07-14", 2],
    ];
    const fixtures = [];
    let id = startId;
    rounds.forEach(([round, label, startDate, count]) => {
      for (let index = 0; index < count; index += 1) {
        const date = addDays(startDate, Math.floor(index / 4));
        fixtures.push(
          fx(
            `M${id}`,
            `${date}T${index % 2 === 0 ? "15:00:00-04:00" : "20:00:00-04:00"}`,
            round,
            label,
            venues[(id - 1) % venues.length],
            "TBD",
            "TBD"
          )
        );
        id += 1;
      }
    });
    fixtures.push(
      fx(`M${id}`, "2026-07-18T17:00:00-04:00", "third", "Third-place", "Miami Stadium", "Semi-final loser", "Semi-final loser")
    );
    fixtures.push(
      fx(`M${id + 1}`, "2026-07-19T15:00:00-04:00", "final", "Grand final", "New York New Jersey Stadium", "Finalist", "Finalist")
    );
    return fixtures;
  }

  function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function fx(id, iso, round, label, venue, home, away) {
    return { id, kickoff: new Date(iso).getTime(), round, label, venue, home, away, result: null };
  }

  function toAppFixture(row) {
    const round = normalizeRound(row.round);
    const hasScore = row.home_score !== null && row.home_score !== "" && row.away_score !== null && row.away_score !== "";
    return {
      id: row.fifa_match_id,
      fixtureId: row.id,
      kickoff: new Date(row.kickoff_at).getTime(),
      round,
      label: labelForRound(round, row.group_code),
      venue: row.venue || "TBD",
      home: row.home_team,
      away: row.away_team,
      result: hasScore
        ? {
            home: Number(row.home_score),
            away: Number(row.away_score),
            winner: row.winner_team || "",
          }
        : null,
    };
  }

  function normalizeRound(round) {
    const mapping = {
      group_1: "group-1",
      group_2: "group-2",
      group_3: "group-3",
      round_32: "round-32",
      round_16: "round-16",
      quarter_final: "quarter",
      semi_final: "semi",
      third_place: "third",
      final: "final",
    };
    return mapping[round] || round;
  }

  function labelForRound(round, groupCode) {
    if (round.startsWith("group")) return `Group ${groupCode || ""}`.trim();
    const labels = {
      "round-32": "Round of 32",
      "round-16": "Round of 16",
      quarter: "Quarter-final",
      semi: "Semi-final",
      third: "Third-place",
      final: "Grand final",
    };
    return labels[round] || round;
  }

  function ko(id, home, away) {
    return { id, teams: [home, away] };
  }

  function scoreInput(value, enabled) {
    const input = el("input");
    input.type = "number";
    input.min = "0";
    input.max = "30";
    input.placeholder = "0";
    input.value = value || "";
    input.disabled = !enabled;
    return input;
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
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

  function compact(items) {
    return items.filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function titleCase(value) {
    if (!value) return "";
    return String(value).charAt(0).toUpperCase() + String(value).slice(1).toLowerCase();
  }
})();
