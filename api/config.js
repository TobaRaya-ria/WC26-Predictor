module.exports = function handler(request, response) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.status(200).json({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
    tournamentLockAt: process.env.NEXT_PUBLIC_TOURNAMENT_LOCK_AT || "2026-12-31T23:59:59Z",
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
};
