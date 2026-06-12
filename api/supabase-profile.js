module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
  const userId = String(body.userId || "").trim();
  const username = normalizeUsername(body.username);
  if (!isUuid(userId) || !isValidUsername(username)) {
    return response.status(400).json({ error: "Valid user id and username are required." });
  }

  try {
    const profile = await repairSupabaseProfile(userId, username, request);
    return response.status(200).json({ profile });
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || "Profile could not be created." });
  }
};

async function repairSupabaseProfile(userId, username, request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceRoleKey) {
    const error = new Error("Supabase service role key is missing on the server.");
    error.status = 500;
    throw error;
  }

  const authUser = await verifySupabaseUser(supabaseUrl, serviceRoleKey, request);
  if (authUser.id !== userId) {
    const error = new Error("You can only repair your own profile.");
    error.status = 403;
    throw error;
  }

  const profileResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      id: userId,
      username,
      display_name: username,
      email: null,
      avatar_url: "",
    }),
  });
  if (!profileResponse.ok) {
    const body = await profileResponse.json().catch(() => ({}));
    const error = new Error(normalizeSupabaseError(body));
    error.status = profileResponse.status;
    throw error;
  }
  const rows = await profileResponse.json().catch(() => []);
  return rows[0] || {
    id: userId,
    username,
    display_name: username,
    email: null,
    avatar_url: "",
  };
}

async function verifySupabaseUser(supabaseUrl, serviceRoleKey, request) {
  const token = getBearerToken(request);
  if (!token) {
    const error = new Error("Log in before repairing a profile.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(normalizeSupabaseError(body));
    error.status = 401;
    throw error;
  }
  return response.json();
}

function getBearerToken(request) {
  const header = request.headers.authorization || request.headers.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function isValidUsername(username) {
  return /^[a-z0-9_]{3,24}$/.test(username);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeSupabaseError(body) {
  const message = String(body.msg || body.message || body.error_description || body.error || "Profile could not be created.");
  if (/duplicate|unique/i.test(message)) return "That username is already taken.";
  return message;
}
