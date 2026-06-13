module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = await updateAdminData(request);
    return response.status(200).json(payload);
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || "Admin update failed." });
  }
};

async function updateAdminData(request) {
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

  const body = await readJsonBody(request);
  if (body.type === "fixture") {
    return updateFixture(supabaseUrl, serviceRoleKey, body);
  }
  if (body.type === "bracket-result") {
    return updateBracketResult(supabaseUrl, serviceRoleKey, body);
  }

  const error = new Error("Unknown admin update type.");
  error.status = 400;
  throw error;
}

async function updateFixture(supabaseUrl, serviceRoleKey, body) {
  const fixtureId = String(body.fixtureId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fixtureId)) {
    const error = new Error("Fixture id is invalid.");
    error.status = 400;
    throw error;
  }

  const record = {
    home_score: parseOptionalScore(body.homeScore, "Home score"),
    away_score: parseOptionalScore(body.awayScore, "Away score"),
    winner_team: normalizeOptionalText(body.winnerTeam, 80),
    status: normalizeStatus(body.status),
    updated_at: new Date().toISOString(),
  };

  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `/rest/v1/fixtures?id=eq.${encodeURIComponent(fixtureId)}&select=id,fifa_match_id,round,home_team,away_team,status,home_score,away_score,winner_team,updated_at`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(record),
    }
  );

  if (!rows.length) {
    const error = new Error("Fixture was not found.");
    error.status = 404;
    throw error;
  }

  return { ok: true, fixture: rows[0] };
}

async function updateBracketResult(supabaseUrl, serviceRoleKey, body) {
  const teamCode = String(body.teamCode || "").trim().toUpperCase();
  const teamName = normalizeOptionalText(body.teamName, 100);
  const placement = normalizePlacement(body.placement);

  if (!/^[A-Z0-9]{2,4}$/.test(teamCode)) {
    const error = new Error("Team code is invalid.");
    error.status = 400;
    throw error;
  }
  if (!teamName) {
    const error = new Error("Team name is required.");
    error.status = 400;
    throw error;
  }

  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    "/rest/v1/actual_tournament_results?on_conflict=team_code&select=team_code,team_name,placement,updated_at",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([
        {
          team_code: teamCode,
          team_name: teamName,
          placement,
          updated_at: new Date().toISOString(),
        },
      ]),
    }
  );

  return { ok: true, result: rows[0] || null };
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
  const rows = await supabaseRequest(
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

  const error = new Error("This account is not allowed to use the admin page.");
  error.status = process.env.ADMIN_USERNAMES || process.env.ADMIN_USER_IDS ? 403 : 500;
  if (!process.env.ADMIN_USERNAMES && !process.env.ADMIN_USER_IDS) {
    error.message = "Admin access is not configured. Set ADMIN_USERNAMES in Vercel.";
  }
  throw error;
}

async function supabaseRequest(supabaseUrl, serviceRoleKey, path, options = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  await assertSupabaseOk(response);
  return response.status === 204 ? null : response.json();
}

async function assertSupabaseOk(response, statusOverride) {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  const error = new Error(normalizeSupabaseError(body));
  error.status = statusOverride || response.status;
  throw error;
}

async function readJsonBody(request) {
  if (Buffer.isBuffer(request.body)) return JSON.parse(request.body.toString("utf8") || "{}");
  if (typeof request.body === "string" && request.body.trim()) return JSON.parse(request.body);
  if (request.body && typeof request.body === "object") return request.body;

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function parseOptionalScore(value, label) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 99) {
    const error = new Error(`${label} must be a whole number from 0 to 99.`);
    error.status = 400;
    throw error;
  }
  return number;
}

function normalizeStatus(value) {
  const status = String(value || "scheduled").trim().toLowerCase();
  const allowed = ["scheduled", "in_progress", "finished", "postponed", "cancelled"];
  if (allowed.includes(status)) return status;
  const error = new Error("Fixture status is invalid.");
  error.status = 400;
  throw error;
}

function normalizePlacement(value) {
  const placement = String(value || "").trim().toLowerCase();
  const allowed = ["", "winner", "runner", "third", "fourth", "qf", "r16", "r32", "grouped"];
  if (allowed.includes(placement)) return placement;
  const error = new Error("Bracket placement is invalid.");
  error.status = 400;
  throw error;
}

function normalizeOptionalText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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
