const INTERNAL_AUTH_DOMAIN = "worldcup-predictor.invalid";

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  if (!isValidUsername(username) || password.length < 6) {
    return response.status(400).json({ error: "Use a valid username and a 6+ character password." });
  }

  try {
    const { user, profile } = await createSupabaseUser(username, password);
    return response.status(200).json({
      user: {
        id: user.id,
        username,
        email: "",
        provider: "supabase",
        profile,
      },
    });
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || "Signup failed" });
  }
};

async function createSupabaseUser(username, password) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceRoleKey) {
    const error = new Error("Supabase service role key is missing on the server.");
    error.status = 500;
    throw error;
  }

  await assertSupabaseUsernameAvailable(supabaseUrl, serviceRoleKey, username);
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: authEmailForUsername(username),
      password,
      email_confirm: true,
      user_metadata: {
        username,
        display_name: username,
        auth_type: "username",
      },
    }),
  });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok) {
    const error = new Error(normalizeSupabaseError(user));
    error.status = userResponse.status === 422 ? 409 : userResponse.status;
    throw error;
  }

  const profile = await upsertSupabaseProfile(supabaseUrl, serviceRoleKey, user.id, username);
  return { user, profile };
}

async function assertSupabaseUsernameAvailable(supabaseUrl, serviceRoleKey, username) {
  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?select=id&username=eq.${encodeURIComponent(username)}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }
  );
  if (!profileResponse.ok) {
    const body = await profileResponse.json().catch(() => ({}));
    const error = new Error(normalizeSupabaseError(body));
    error.status = profileResponse.status;
    throw error;
  }

  const rows = await profileResponse.json().catch(() => []);
  if (rows.length) {
    const error = new Error("That username is already taken.");
    error.status = 409;
    throw error;
  }
}

async function upsertSupabaseProfile(supabaseUrl, serviceRoleKey, userId, username) {
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

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function isValidUsername(username) {
  return /^[a-z0-9_]{3,24}$/.test(username);
}

function authEmailForUsername(username) {
  return `${normalizeUsername(username)}@${INTERNAL_AUTH_DOMAIN}`;
}

function normalizeSupabaseError(body) {
  const message = String(body.msg || body.message || body.error_description || body.error || "Signup failed");
  if (/already|registered|duplicate|unique/i.test(message)) return "That username is already taken.";
  return message;
}
