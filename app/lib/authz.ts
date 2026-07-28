// Shared-secret gate for the automation routes (/api/cron/*, /api/agent/inbound).
// pg_cron and the AgentMail webhook Edge Function send it as a Bearer token.
// If CRON_SECRET is unset, the routes are closed (deny by default).
export function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}
