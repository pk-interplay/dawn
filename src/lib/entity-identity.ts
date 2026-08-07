import type { SupabaseClient } from "@supabase/supabase-js";
import { findEntityIdByEmail, findOrCreateEntity } from "./claims";

/**
 * "Which entity is the signed-in user?" — the question the claims model had no way
 * to answer until migration 0029.
 *
 * Three surfaces need it and all three would otherwise re-derive it differently:
 * onboarding (to attach ingest and profile claims), the chat (to scope "my network"),
 * and the admin users list (to mark which entities are real users).
 *
 * Resolution is by `auth_user_id` first, falling back to the live `email` claim. The
 * fallback is not defensive padding — it is the ADOPTION path. A new user very often
 * already exists in the graph as somebody else's contact, put there by a teammate's
 * Gmail ingest. Resolving them by email means they inherit that entity, with the
 * edges already pointing at it, instead of getting a second one. `src/auth.ts` stamps
 * `auth_user_id` onto whatever this finds at sign-in, so the fallback normally runs
 * exactly once per user.
 */

export interface ViewerIdentity {
  /** The entity this user IS. Edges they ingested have `from_id = entityId`. */
  entityId: string;
  email: string;
  displayName: string | null;
  /** Null until they finish the Confirm step of onboarding. */
  onboardedAt: string | null;
}

export interface SessionLike {
  user?: { id?: string | null; email?: string | null; name?: string | null } | null;
}

/**
 * Resolve the signed-in user's entity, or null if they have none yet.
 *
 * Never creates one — a lookup that quietly inserts is how duplicate identities get
 * made, and the caller usually wants to distinguish "no entity yet" (send them to
 * onboarding) from "here they are". Use `ensureViewerEntity` when creation is the
 * intent.
 */
export async function resolveViewerEntity(
  client: SupabaseClient,
  session: SessionLike,
): Promise<ViewerIdentity | null> {
  const authUserId = session.user?.id;
  const email = session.user?.email?.trim().toLowerCase();
  if (!authUserId && !email) return null;

  if (authUserId) {
    const { data, error } = await client
      .from("entities")
      .select("id, display_name, onboarded_at")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (error) throw new Error(`resolveViewerEntity failed: ${error.message}`);
    if (data) {
      return {
        entityId: data.id as string,
        email: email ?? "",
        displayName: (data.display_name as string | null) ?? null,
        onboardedAt: (data.onboarded_at as string | null) ?? null,
      };
    }
  }

  if (!email) return null;
  const byEmail = await findEntityIdByEmail(client, email);
  if (!byEmail) return null;

  const { data, error } = await client
    .from("entities")
    .select("id, display_name, onboarded_at")
    .eq("id", byEmail)
    .single();
  if (error) throw new Error(`resolveViewerEntity lookup failed: ${error.message}`);

  return {
    entityId: data.id as string,
    email,
    displayName: (data.display_name as string | null) ?? null,
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

/**
 * Same, but creates the entity and claims it for this Google account if it does not
 * exist. Only the onboarding ingest route should need this — every read path wants
 * `resolveViewerEntity` so that "not onboarded yet" stays a distinguishable state
 * rather than being papered over with an empty entity.
 */
export async function ensureViewerEntity(
  client: SupabaseClient,
  session: SessionLike,
): Promise<ViewerIdentity> {
  const existing = await resolveViewerEntity(client, session);
  if (existing) return existing;

  const email = session.user?.email?.trim().toLowerCase();
  const authUserId = session.user?.id;
  if (!email || !authUserId) {
    throw new Error("ensureViewerEntity needs a session with both an id and an email");
  }

  const entityId = await findOrCreateEntity(client, {
    kind: "person",
    matchHint: { email },
  });

  // `is("auth_user_id", null)` so this can never take over an entity already claimed
  // by a different Google account — two people sharing an email claim is a data
  // problem to review, not one to resolve by overwriting.
  const { error } = await client
    .from("entities")
    .update({ auth_user_id: authUserId })
    .eq("id", entityId)
    .is("auth_user_id", null);
  if (error) throw new Error(`ensureViewerEntity claim failed: ${error.message}`);

  return { entityId, email, displayName: session.user?.name ?? null, onboardedAt: null };
}
