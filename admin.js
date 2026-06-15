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
  const PLACEMENT_LABELS = {
    winner: "Winner",
    runner: "Runner-up",
    third: "Third",
    fourth: "Fourth",
    qf: "5-8",
    r16: "9-16",
    r32: "17-32",
    grouped: "Grouped",
  };
  const PLACEMENT_KEYS = ["winner", "runner", "third", "fourth", "qf", "r16", "r32", "grouped"];
  const FORECAST_SIMULATIONS = 8000;
  const HOST_TEAMS = new Set(["CAN", "MEX", "USA"]);
  const TEAM_GROUPS = {
    A: [
      team("MEX", "Mexico", 15),
      team("RSA", "South Africa", 61),
      team("KOR", "Korea Republic", 22),
      team("CZE", "Czechia", 44),
    ],
    B: [
      team("CAN", "Canada", 27),
      team("BIH", "Bosnia and Herzegovina", 71),
      team("QAT", "Qatar", 51),
      team("SUI", "Switzerland", 17),
    ],
    C: [team("BRA", "Brazil", 5), team("MAR", "Morocco", 11), team("HAI", "Haiti", 84), team("SCO", "Scotland", 36)],
    D: [team("USA", "USA", 14), team("PAR", "Paraguay", 39), team("AUS", "Australia", 26), team("TUR", "Turkiye", 25)],
    E: [
      team("CIV", "Cote d'Ivoire", 42),
      team("ECU", "Ecuador", 23),
      team("GER", "Germany", 9),
      team("CUW", "Curacao", 82),
    ],
    F: [team("NED", "Netherlands", 7), team("JPN", "Japan", 18), team("SWE", "Sweden", 43), team("TUN", "Tunisia", 40)],
    G: [team("IRN", "IR Iran", 20), team("NZL", "New Zealand", 86), team("BEL", "Belgium", 8), team("EGY", "Egypt", 34)],
    H: [
      team("KSA", "Saudi Arabia", 60),
      team("URU", "Uruguay", 16),
      team("ESP", "Spain", 1),
      team("CPV", "Cabo Verde", 68),
    ],
    I: [team("FRA", "France", 3), team("SEN", "Senegal", 19), team("IRQ", "Iraq", 58), team("NOR", "Norway", 29)],
    J: [team("ARG", "Argentina", 2), team("ALG", "Algeria", 35), team("AUT", "Austria", 24), team("JOR", "Jordan", 66)],
    K: [team("POR", "Portugal", 6), team("COD", "Congo DR", 56), team("UZB", "Uzbekistan", 50), team("COL", "Colombia", 13)],
    L: [team("GHA", "Ghana", 72), team("PAN", "Panama", 30), team("ENG", "England", 4), team("CRO", "Croatia", 10)],
  };
  const TEAM_META = Object.fromEntries(Object.values(TEAM_GROUPS).flat().map((item) => [item.code, item]));
  const TEAM_BY_NAME = Object.fromEntries(
    Object.values(TEAM_GROUPS)
      .flat()
      .flatMap((item) => [[normalizeTeamName(item.name), item.code], [normalizeTeamName(item.code), item.code]])
  );
  Object.assign(TEAM_BY_NAME, {
    [normalizeTeamName("Côte d'Ivoire")]: "CIV",
    [normalizeTeamName("Ivory Coast")]: "CIV",
    [normalizeTeamName("Czech Republic")]: "CZE",
    [normalizeTeamName("DR Congo")]: "COD",
    [normalizeTeamName("D.R. Congo")]: "COD",
    [normalizeTeamName("Democratic Republic of the Congo")]: "COD",
    [normalizeTeamName("South Korea")]: "KOR",
    [normalizeTeamName("Republic of Korea")]: "KOR",
    [normalizeTeamName("Türkiye")]: "TUR",
    [normalizeTeamName("Turkey")]: "TUR",
    [normalizeTeamName("United States")]: "USA",
    [normalizeTeamName("United States of America")]: "USA",
  });
  const dom = {};
  let supabaseClient = null;
  let fixtures = [];
  let accounts = [];
  let actualResults = [];
  let forecastFormBonus = {};

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
      "bracketForecast",
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
    renderBracketForecast();
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

  function renderBracketForecast() {
    dom.bracketForecast.innerHTML = "";
    const predictedAccounts = accounts.filter((account) => account.tournament_prediction?.final_placements);
    if (!predictedAccounts.length) {
      dom.bracketForecast.innerHTML = `<div class="empty-state">No whole-bracket predictions have been submitted yet.</div>`;
      return;
    }

    const forecast = buildBracketForecast(predictedAccounts);
    if (!forecast.rows.length) {
      dom.bracketForecast.innerHTML = `<div class="empty-state">Forecast could not be calculated from the current fixture data.</div>`;
      return;
    }

    const expectedLeader = forecast.rows[0];
    const topChanceLeader = [...forecast.rows].sort((a, b) => b.topChance - a.topChance || b.expectedScore - a.expectedScore)[0];
    const summary = el("div", "admin-forecast-summary");
    summary.innerHTML = `
      <article>
        <span>Best expected score</span>
        <strong>${escapeHtml(expectedLeader.username)}</strong>
        <small>${formatDecimal(expectedLeader.expectedScore)} projected pts</small>
      </article>
      <article>
        <span>Most likely to finish #1</span>
        <strong>${escapeHtml(topChanceLeader.username)}</strong>
        <small>${formatPercent(topChanceLeader.topChance)} top-bracket chance</small>
      </article>
      <article>
        <span>Model favorite</span>
        <strong>${escapeHtml(forecast.favorites[0]?.name || "-")}</strong>
        <small>${formatPercent(forecast.favorites[0]?.titleChance || 0)} title chance</small>
      </article>
    `;
    dom.bracketForecast.appendChild(summary);

    const table = el("table", "admin-prediction-table admin-forecast-table");
    table.innerHTML = `
      <thead>
        <tr>
          <th>#</th>
          <th>Account</th>
          <th>Champion Pick</th>
          <th>Expected Whole</th>
          <th>Chance #1</th>
          <th>Likely Range</th>
        </tr>
      </thead>
    `;
    const body = el("tbody");
    forecast.rows.forEach((row, index) => {
      const tr = el("tr", index === 0 ? "forecast-leader" : "");
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td>${escapeHtml(row.username)}</td>
        <td>${escapeHtml(row.champion || "-")}</td>
        <td>${formatDecimal(row.expectedScore)}</td>
        <td>${formatPercent(row.topChance)}</td>
        <td>${formatDecimal(row.lowScore)}-${formatDecimal(row.highScore)}</td>
      `;
      body.appendChild(tr);
    });
    table.appendChild(body);
    dom.bracketForecast.appendChild(table);

    const note = el("p", "muted admin-forecast-note");
    note.textContent = `${FORECAST_SIMULATIONS.toLocaleString()} simulations from current fixture scores, estimated team strength, host advantage, and the app's whole-bracket scoring rules. The range shows the middle 80% of simulated scores.`;
    dom.bracketForecast.appendChild(note);
  }

  function buildBracketForecast(predictedAccounts) {
    const rng = createRng(20260615);
    const fixtureResults = currentGroupFixtureResults();
    forecastFormBonus = formBonusByCode(fixtureResults);
    const knownPlacements = knownActualPlacementsByCode();
    const scoresByUser = Object.fromEntries(predictedAccounts.map((account) => [account.id, []]));
    const topCounts = Object.fromEntries(predictedAccounts.map((account) => [account.id, 0]));
    const titleCounts = {};

    for (let index = 0; index < FORECAST_SIMULATIONS; index += 1) {
      const simulatedPlacements = simulateTournament(rng, fixtureResults);
      const actualPlacements = mergeKnownPlacements(simulatedPlacements, knownPlacements);
      const champion = actualPlacements.winner?.[0]?.code;
      if (champion) titleCounts[champion] = (titleCounts[champion] || 0) + 1;

      let bestScore = -Infinity;
      const simulationScores = predictedAccounts.map((account) => {
        const score = calculateWholeBracketScore(account.tournament_prediction.final_placements || {}, actualPlacements);
        scoresByUser[account.id].push(score);
        bestScore = Math.max(bestScore, score);
        return { id: account.id, score };
      });
      const winners = simulationScores.filter((item) => item.score === bestScore);
      winners.forEach((winner) => {
        topCounts[winner.id] += 1 / winners.length;
      });
    }

    const rows = predictedAccounts
      .map((account) => {
        const scores = scoresByUser[account.id].sort((a, b) => a - b);
        return {
          id: account.id,
          username: account.username,
          champion: teamList(account.tournament_prediction.final_placements?.winner).join(", "),
          expectedScore: average(scores),
          lowScore: percentile(scores, 0.1),
          highScore: percentile(scores, 0.9),
          topChance: topCounts[account.id] / FORECAST_SIMULATIONS,
        };
      })
      .sort((a, b) => b.expectedScore - a.expectedScore || b.topChance - a.topChance || a.username.localeCompare(b.username));

    const favorites = Object.entries(titleCounts)
      .map(([code, count]) => ({
        code,
        name: TEAM_META[code]?.name || code,
        titleChance: count / FORECAST_SIMULATIONS,
      }))
      .sort((a, b) => b.titleChance - a.titleChance)
      .slice(0, 5);

    return { rows, favorites };
  }

  function currentGroupFixtureResults() {
    return fixtures
      .filter((fixture) => isGroupRound(fixture.round) && fixture.group_code)
      .map((fixture) => ({
        group: fixture.group_code,
        home: teamCodeForName(fixture.home_team),
        away: teamCodeForName(fixture.away_team),
        homeScore: scoreValue(fixture.home_score),
        awayScore: scoreValue(fixture.away_score),
      }))
      .filter((fixture) => fixture.home && fixture.away);
  }

  function simulateTournament(rng, fixtureResults) {
    const groupState = simulateGroups(rng, fixtureResults);
    const thirdGroups = bestThirdPlaceGroups(groupState);
    const thirdMap = assignThirdPlaces(thirdGroups);
    const placements = emptyPlacements();
    const advanced = new Set();

    Object.entries(groupState).forEach(([group, state]) => {
      advanced.add(state.order[0]);
      advanced.add(state.order[1]);
      if (thirdGroups.includes(group)) advanced.add(state.order[2]);
    });
    Object.keys(TEAM_META).forEach((code) => {
      if (!advanced.has(code)) placements.grouped.push(teamFromCode(code));
    });

    const seed = (type, group) => groupState[group].order[type === "W" ? 0 : 1];
    const third = (slot) => {
      const group = thirdMap[slot];
      return group ? groupState[group].order[2] : null;
    };
    const r32 = [
      [seed("W", "A"), third("1A")],
      [seed("R", "A"), seed("R", "B")],
      [seed("W", "C"), seed("R", "F")],
      [seed("W", "E"), third("1E")],
      [seed("W", "I"), third("1I")],
      [seed("R", "E"), seed("R", "I")],
      [seed("W", "G"), third("1G")],
      [seed("R", "C"), seed("W", "F")],
      [seed("W", "B"), third("1B")],
      [seed("W", "D"), third("1D")],
      [seed("R", "D"), seed("R", "G")],
      [seed("W", "H"), seed("R", "J")],
      [seed("W", "J"), seed("R", "H")],
      [seed("W", "K"), third("1K")],
      [seed("W", "L"), third("1L")],
      [seed("R", "K"), seed("R", "L")],
    ];
    const r16Teams = playKnockoutRound(r32, "r32", placements, rng);
    const qfTeams = playKnockoutRound(pairTeams(r16Teams), "r16", placements, rng);
    const sfTeams = playKnockoutRound(pairTeams(qfTeams), "qf", placements, rng);
    const finalists = [];
    const semiLosers = [];
    pairTeams(sfTeams).forEach(([home, away]) => {
      const winner = knockoutWinner(home, away, rng);
      const loser = winner === home ? away : home;
      finalists.push(winner);
      semiLosers.push(loser);
    });

    const thirdWinner = knockoutWinner(semiLosers[0], semiLosers[1], rng);
    const fourth = thirdWinner === semiLosers[0] ? semiLosers[1] : semiLosers[0];
    const champion = knockoutWinner(finalists[0], finalists[1], rng);
    const runner = champion === finalists[0] ? finalists[1] : finalists[0];
    placements.winner.push(teamFromCode(champion));
    placements.runner.push(teamFromCode(runner));
    placements.third.push(teamFromCode(thirdWinner));
    placements.fourth.push(teamFromCode(fourth));
    return placements;
  }

  function simulateGroups(rng, fixtureResults) {
    const byGroup = groupFixturesForForecast(fixtureResults);
    const state = {};
    Object.entries(TEAM_GROUPS).forEach(([group, teams]) => {
      const stats = Object.fromEntries(
        teams.map((item) => [item.code, { pts: 0, gd: 0, gf: 0, ga: 0, rank: item.rank }])
      );
      (byGroup[group] || []).forEach((fixture) => {
        const score =
          fixture.homeScore !== null && fixture.awayScore !== null
            ? [fixture.homeScore, fixture.awayScore]
            : simulateScore(fixture.home, fixture.away, rng);
        applyGroupResult(stats, fixture.home, fixture.away, score[0], score[1]);
      });
      const order = teams
        .map((item) => item.code)
        .sort(
          (a, b) =>
            stats[b].pts - stats[a].pts ||
            stats[b].gd - stats[a].gd ||
            stats[b].gf - stats[a].gf ||
            stats[a].rank - stats[b].rank ||
            rng() - 0.5
        );
      state[group] = { stats, order };
    });
    return state;
  }

  function groupFixturesForForecast(fixtureResults) {
    const groups = {};
    fixtureResults.forEach((fixture) => {
      if (!groups[fixture.group]) groups[fixture.group] = [];
      groups[fixture.group].push(fixture);
    });
    Object.entries(TEAM_GROUPS).forEach(([group, teams]) => {
      if (groups[group]?.length) return;
      const pairings = [
        [0, 1],
        [2, 3],
        [0, 2],
        [3, 1],
        [3, 0],
        [1, 2],
      ];
      groups[group] = pairings.map(([homeIndex, awayIndex]) => ({
        group,
        home: teams[homeIndex].code,
        away: teams[awayIndex].code,
        homeScore: null,
        awayScore: null,
      }));
    });
    return groups;
  }

  function bestThirdPlaceGroups(groupState) {
    return Object.entries(groupState)
      .map(([group, state]) => {
        const code = state.order[2];
        const stats = state.stats[code];
        return { group, code, stats };
      })
      .sort(
        (a, b) =>
          b.stats.pts - a.stats.pts ||
          b.stats.gd - a.stats.gd ||
          b.stats.gf - a.stats.gf ||
          a.stats.rank - b.stats.rank
      )
      .slice(0, 8)
      .map((item) => item.group);
  }

  function assignThirdPlaces(thirdGroups) {
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
    const available = [...thirdGroups];
    const assigned = {};
    Object.entries(preferences).forEach(([slot, list]) => {
      const group = list.find((candidate) => available.includes(candidate)) || available[0];
      if (!group) return;
      assigned[slot] = group;
      available.splice(available.indexOf(group), 1);
    });
    return assigned;
  }

  function playKnockoutRound(matches, loserPlacement, placements, rng) {
    return matches.map(([home, away]) => {
      const winner = knockoutWinner(home, away, rng);
      const loser = winner === home ? away : home;
      placements[loserPlacement].push(teamFromCode(loser));
      return winner;
    });
  }

  function pairTeams(teams) {
    const pairs = [];
    for (let index = 0; index < teams.length; index += 2) pairs.push([teams[index], teams[index + 1]]);
    return pairs;
  }

  function knockoutWinner(home, away, rng) {
    return rng() < winProbability(home, away) ? home : away;
  }

  function simulateScore(home, away, rng) {
    const difference = modelRating(home) - modelRating(away);
    const baseGoals = 1.23;
    const homeGoals = clamp(baseGoals * Math.exp(difference / 760), 0.18, 3);
    const awayGoals = clamp(baseGoals * Math.exp(-difference / 760), 0.18, 3);
    return [poisson(homeGoals, rng), poisson(awayGoals, rng)];
  }

  function applyGroupResult(stats, home, away, homeScore, awayScore) {
    stats[home].gf += homeScore;
    stats[home].ga += awayScore;
    stats[home].gd += homeScore - awayScore;
    stats[away].gf += awayScore;
    stats[away].ga += homeScore;
    stats[away].gd += awayScore - homeScore;
    if (homeScore > awayScore) stats[home].pts += 3;
    else if (awayScore > homeScore) stats[away].pts += 3;
    else {
      stats[home].pts += 1;
      stats[away].pts += 1;
    }
  }

  function calculateWholeBracketScore(predictedPlacements, actualPlacements) {
    const predictedByCode = placementByTeamCode(predictedPlacements);
    const actualByCode = placementByTeamCode(actualPlacements);
    const exactCounts = { grouped: 0, r32: 0, r16: 0, winner: 0, runner: 0, third: 0, fourth: 0 };
    const actualCounts = { grouped: 0, r32: 0, r16: 0, winner: 0, runner: 0, third: 0, fourth: 0 };
    let countryScore = 0;
    let accuracyScore = 0;

    Object.entries(actualByCode).forEach(([teamCode, actualPlacement]) => {
      if (actualPlacement in actualCounts) actualCounts[actualPlacement] += 1;
      const predictedPlacement = predictedByCode[teamCode];
      if (!predictedPlacement) return;
      if (predictedPlacement === actualPlacement && actualPlacement in exactCounts) exactCounts[actualPlacement] += 1;
      countryScore += bracketPlacementPoints(actualPlacement, predictedPlacement);
      accuracyScore += bracketPlacementAccuracyPoints(actualPlacement, predictedPlacement);
    });

    ["grouped", "r32", "r16"].forEach((placement) => {
      const actualCount = actualCounts[placement];
      if (!actualCount) return;
      const ratio = exactCounts[placement] / actualCount;
      if (ratio >= 0.75) countryScore += 10;
      else if (ratio >= 0.5) countryScore += 4;
    });

    if (
      actualCounts.winner === 1 &&
      actualCounts.runner === 1 &&
      actualCounts.third === 1 &&
      actualCounts.fourth === 1 &&
      exactCounts.winner === 1 &&
      exactCounts.runner === 1 &&
      exactCounts.third === 1 &&
      exactCounts.fourth === 1
    ) {
      countryScore += 15;
    }
    return countryScore + accuracyScore;
  }

  function bracketPlacementPoints(actualPlacement, predictedPlacement) {
    if (actualPlacement === "winner") return predictedPlacement === "winner" ? 30 : predictedPlacement === "runner" ? 16 : 0;
    if (actualPlacement === "runner") return predictedPlacement === "runner" ? 20 : predictedPlacement === "winner" ? 16 : 0;
    if (actualPlacement === "third" || actualPlacement === "fourth") {
      if (predictedPlacement === actualPlacement) return 13;
      return predictedPlacement === "third" || predictedPlacement === "fourth" ? 10 : 0;
    }
    const points = { qf: 7, r16: 4, r32: 3, grouped: 2 };
    return predictedPlacement === actualPlacement ? points[actualPlacement] || 0 : 0;
  }

  function bracketPlacementAccuracyPoints(actualPlacement, predictedPlacement) {
    if (actualPlacement === predictedPlacement) return 1;
    const actualTier = placementTier(actualPlacement);
    const predictedTier = placementTier(predictedPlacement);
    if (actualTier === null || predictedTier === null) return 0;
    const distance = Math.abs(actualTier - predictedTier);
    if (distance <= 1) return 0.5;
    if (distance === 2) return 0.2;
    return 0;
  }

  function placementTier(placement) {
    if (placement === "grouped") return 0;
    if (placement === "r32") return 1;
    if (placement === "r16") return 2;
    if (placement === "qf") return 3;
    if (placement === "third" || placement === "fourth") return 4;
    if (placement === "winner" || placement === "runner") return 5;
    return null;
  }

  function placementByTeamCode(placements) {
    const result = {};
    Object.entries(placements || {}).forEach(([placement, teams]) => {
      (teams || []).forEach((item) => {
        const code = String(item?.code || item?.team_code || "").toUpperCase();
        if (code) result[code] = placement;
      });
    });
    return result;
  }

  function knownActualPlacementsByCode() {
    return Object.fromEntries(
      actualResults
        .map((result) => [String(result.team_code || "").toUpperCase(), normalizePlacementKey(result.placement)])
        .filter(([teamCode, placement]) => teamCode && placement)
    );
  }

  function mergeKnownPlacements(simulatedPlacements, knownPlacements) {
    if (!Object.keys(knownPlacements).length) return simulatedPlacements;
    const merged = emptyPlacements();
    const knownCodes = new Set(Object.keys(knownPlacements));
    Object.entries(simulatedPlacements).forEach(([placement, teams]) => {
      teams.forEach((item) => {
        if (!knownCodes.has(item.code)) merged[placement].push(item);
      });
    });
    Object.entries(knownPlacements).forEach(([teamCode, placement]) => {
      if (merged[placement]) merged[placement].push(teamFromCode(teamCode));
    });
    return merged;
  }

  function modelRating(code) {
    const meta = TEAM_META[code] || { rank: 80 };
    const form = currentFormBonus(code);
    return 2100 - meta.rank * 13.5 + (HOST_TEAMS.has(code) ? 45 : 0) + form;
  }

  function currentFormBonus(code) {
    return forecastFormBonus[code] || 0;
  }

  function formBonusByCode(fixtureResults) {
    return fixtureResults.reduce((bonuses, fixture) => {
      if (fixture.homeScore === null || fixture.awayScore === null) return bonuses;
      bonuses[fixture.home] =
        (bonuses[fixture.home] || 0) +
        (fixture.homeScore - fixture.awayScore) * 12 +
        resultPoints(fixture.homeScore, fixture.awayScore) * 10;
      bonuses[fixture.away] =
        (bonuses[fixture.away] || 0) +
        (fixture.awayScore - fixture.homeScore) * 12 +
        resultPoints(fixture.awayScore, fixture.homeScore) * 10;
      return bonuses;
    }, {});
  }

  function resultPoints(forScore, againstScore) {
    if (forScore > againstScore) return 3;
    if (forScore === againstScore) return 1;
    return 0;
  }

  function winProbability(home, away) {
    return 1 / (1 + 10 ** (-(modelRating(home) - modelRating(away)) / 420));
  }

  function poisson(lambda, rng) {
    const limit = Math.exp(-lambda);
    let count = 0;
    let product = 1;
    do {
      count += 1;
      product *= rng();
    } while (product > limit);
    return count - 1;
  }

  function createRng(seed) {
    let value = seed >>> 0;
    return function rng() {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 4294967296;
    };
  }

  function emptyPlacements() {
    return Object.fromEntries(PLACEMENT_KEYS.map((placement) => [placement, []]));
  }

  function teamFromCode(code) {
    const meta = TEAM_META[code] || { code, name: code, rank: 99 };
    return { code: meta.code, name: meta.name };
  }

  function teamList(teams) {
    return (teams || []).map((item) => item.name || item.code).filter(Boolean);
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
    const wrap = el("div", "admin-placement-grid");
    Object.entries(PLACEMENT_LABELS).forEach(([key, label]) => {
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

  function formatDecimal(value) {
    return Number(value || 0).toFixed(1);
  }

  function formatPercent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
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

  function isGroupRound(round) {
    return String(round || "").startsWith("group");
  }

  function scoreValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function teamCodeForName(name) {
    return TEAM_BY_NAME[normalizeTeamName(name)] || "";
  }

  function normalizeTeamName(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function normalizePlacementKey(value) {
    const key = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
    const aliases = {
      champion: "winner",
      winner: "winner",
      runner_up: "runner",
      runner: "runner",
      second: "runner",
      third: "third",
      third_place: "third",
      fourth: "fourth",
      fourth_place: "fourth",
      quarter_finalist: "qf",
      quarterfinalist: "qf",
      qf: "qf",
      fifth_to_eighth: "qf",
      round_of_16: "r16",
      r16: "r16",
      ninth_to_sixteenth: "r16",
      round_of_32: "r32",
      r32: "r32",
      seventeenth_to_thirty_second: "r32",
      grouped: "grouped",
      group_stage: "grouped",
      eliminated_group: "grouped",
    };
    return aliases[key] || "";
  }

  function average(values) {
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
  }

  function percentile(values, ratio) {
    if (!values.length) return 0;
    const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * ratio)));
    return values[index];
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function team(code, name, rank) {
    return { code, name, rank };
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
