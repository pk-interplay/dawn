import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

export type SessionUser = { id: string; email: string | null };
export type UserCheck =
  | { ok: true; user: SessionUser }
  | { ok: false; status: number; error: string };

/**
 * Identify the member behind a request from their Supabase session token.
 *
 * Same posture as requireAdmin() in ./admin-auth.ts — getUser(token) validates the
 * JWT against the auth server rather than trusting its claims — but with no
 * allowlist: any confirmed account is a member. This is what lets the server, not
 * localStorage, answer "which people row is this?", so the logged-in state survives
 * a new browser or a cleared cache.
 */
export async function requireUser(req: Request): Promise<UserCheck> {
  if (!url || !key) {
    return { ok: false, status: 503, error: "Supabase env vars are not configured" };
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { ok: false, status: 401, error: "Missing bearer token" };

  const { data, error } = await createClient(url, key).auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }
  return { ok: true, user: { id: data.user.id, email: data.user.email ?? null } };
}
