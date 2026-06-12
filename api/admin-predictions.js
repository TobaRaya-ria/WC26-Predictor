const INTERNAL_AUTH_DOMAIN = "worldcup-predictor.invalid";

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = await loadAdminPredictions(request);
    return response.status(200).json(payload);
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || "Admin data could not be loaded." });
  }
};

async function loadAdminPredictions(request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceRoleKey) {
    const error = new Error("Supabase service role key is missing on the server.");
    error.status = 500;
    throw error;
  }

  const authUser = await verifySupabaseUser(supabaseUrl, serviceRoleKey, request);
  const adminProfile = await loadProfile(supabaseUrl, serviceRoleKey, authUser.id);
  assertAdmin(adminProfile);

  const [profiles, tournamentPredictions, matchPredictions, fixtures, leaderboard] = await Promise.all([
    supabaseGet(supabaseUrl, serviceRoleKey, "/rest/v1/profiles?select=id,username,display_name,created_at&order=username.asc"),
    supabaseGet(
      supabaseUrl,
      serviceRoleKey,
      "/rest/v1/tournament_predictions?select=user_id,group_rankings,third_place_qualifiers,knockout_picks,final_placements,locked_at,submitted_at,updated_at"
    ),
    supabaseGet(
      supabaseUrl,
      serviceRoleKey,
      "/rest/v1/match_predictions?select=user_id,fixture_id,predicted_home_score,predicted_away_score,predicted_outcome,locked_at,submitted_at,updated_at"
    ),
    supabaseGet(
      supabaseUrl,
      serviceRoleKey,
      "/rest/v1/fixtures?select=id,fifa_match_id,round,group_code,home_team,away_team,kickoff_at,venue,status,home_score,away_score,winner_team&order=kickoff_at.asc"
    ),
    supabaseGet(supabaseUrl, serviceRoleKey, "/rest/v1/leaderboard?select=user_id,total_score,bracket_score,match_score,rank"),
  ]);

  const tournamentByUser = Object.fromEntries(tournamentPredictions.map((prediction) => [prediction.user_id, prediction]));
  const leaderboardByUser = Object.fromEntries(leaderboard.map((row) => [row.user_id, row]));
  const matchPredictionsByUser = {};
  matchPredictions.forEach((prediction) => {
    if (!matchPredictionsByUser[prediction.user_id]) matchPredictionsByUser[prediction.user_id] = [];
    matchPredictionsByUser[prediction.user_id].push(prediction);
  });

  return {
    admin: {
      id: adminProfile.id,
      username: adminProfile.username,
    },
    generatedAt: new Date().toISOString(),
    accounts: profiles.map((profile) => ({
      ...profile,
      tournament_prediction: tournamentByUser[profile.id] || null,
      match_predictions: matchPredictionsByUser[profile.id] || [],
      leaderboard: leaderboardByUser[profile.id] || null,
    })),
    fixtures,
  };
}

async function verifySupabaseUser(supabaseUrl, serviceRoleKey, request) {
  const token = getBearerToken(request);
  if (!token) {
    const error = new Error("Log in as admin first.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${token}`,
    },
  });
  await assertSupabaseOk(response, 401);
  return response.json();
}

async function loadProfile(supabaseUrl, serviceRoleKey, userId) {
  const rows = await supabaseGet(
    supabaseUrl,
    serviceRoleKey,
    `/rest/v1/profiles?select=id,username,email&id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  if (!rows.length) {
    const error = new Error("Admin profile was not found.");
    error.status = 403;
    throw error;
  }
  return rows[0];
}

function assertAdmin(profile) {
  const adminUserIds = envList("ADMIN_USER_IDS");
  const adminUsernames = envList("ADMIN_USERNAMES").map((username) => normalizeUsername(username));
  const username = normalizeUsername(profile.username);
  if (adminUserIds.includes(profile.id) || adminUsernames.includes(username)) return;

  const error = new Error("This account is not allowed to view the admin page.");
  error.status = process.env.ADMIN_USERNAMES || process.env.ADMIN_USER_IDS ? 403 : 500;
  if (!process.env.ADMIN_USERNAMES && !process.env.ADMIN_USER_IDS) {
    error.message = "Admin access is not configured. Set ADMIN_USERNAMES in Vercel.";
  }
  throw error;
}

async function supabaseGet(supabaseUrl, serviceRoleKey, path) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  await assertSupabaseOk(response);
  return response.json();
}

async function assertSupabaseOk(response, statusOverride) {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  const error = new Error(normalizeSupabaseError(body));
  error.status = statusOverride || response.status;
  throw error;
}

function getBearerToken(request) {
  const header = request.headers.authorization || request.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function envList(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeSupabaseError(body) {
  return String(body.msg || body.message || body.error_description || body.error || "Supabase request failed.");
}
