import { auth } from "../../src/auth";

/**
 * Identify the signed-in user behind a request.
 *
 * Was: read a Supabase session token from an `Authorization: Bearer` header and
 * validate it with `auth.getUser(token)`. Now: read the NextAuth session, since
 * Google is the only way in.
 *
 * The `UserCheck` shape is kept identical so call sites need no change, but
 * `user.id` now means something different — it is the Google `sub`
 * (`entities.auth_user_id`), not a Supabase `auth.users` uuid. Anything that
 * joined on the old value against `people.user_id` is reading a dead link.
 *
 * No bearer header is involved any more: NextAuth's session cookie is sent
 * automatically on same-origin requests, which is why `adminFetch` stopped
 * attaching one. `req` is retained in the signature — unused — so the ~dozen
 * `requireUser(req)` call sites did not all have to change in the same commit as
 * the auth swap. Drop the parameter when touching those routes for other reasons.
 */

export type SessionUser = { id: string; email: string | null };
export type UserCheck =
  | { ok: true; user: SessionUser }
  | { ok: false; status: number; error: string };

export async function requireUser(_req?: Request): Promise<UserCheck> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, status: 401, error: "Not signed in" };
  }
  return { ok: true, user: { id: session.user.id, email: session.user.email ?? null } };
}
