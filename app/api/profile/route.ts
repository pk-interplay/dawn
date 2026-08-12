import { NextResponse } from "next/server";

import { auth } from "../../../src/auth";
import { supabase } from "../../../src/lib/supabase";
import { resolveViewerEntity, type ViewerIdentity } from "../../../src/lib/entity-identity";
import {
  applyProfilePatch,
  loadEditableProfile,
  ProfilePatchSchema,
  refreshProfileEmbedding,
} from "../../../src/lib/profile-edit";

/**
 * Your own profile, read and write.
 *
 * Service-role, like the other writing routes (onboarding, ingest) and unlike chat's
 * read-only `db`. The subject is never taken from the request: it is always the entity
 * the session resolves to, so there is no shape of body that edits somebody else.
 *
 * PATCH rather than PUT because the body genuinely is a patch — the form sends every
 * field, the agent sends one, and an absent key means "leave it alone" in both cases
 * (see profile-edit.ts).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A save re-summarises and re-embeds inline: one Haiku call plus one embedding.
export const maxDuration = 60;

type Resolved =
  | { viewer: ViewerIdentity; error: null }
  | { viewer: null; error: NextResponse };

/** Signed in AND has an entity, or the response explaining which one is missing. */
async function resolveViewer(): Promise<Resolved> {
  const session = await auth();
  if (!session?.user?.id) {
    return { viewer: null, error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  const viewer = await resolveViewerEntity(supabase, session);
  if (!viewer) {
    // Signed in but no graph: the UI turns this into a link to onboarding, same as chat.
    return {
      viewer: null,
      error: NextResponse.json(
        { error: "Dawn hasn't synced your network yet.", needsOnboarding: true },
        { status: 409 },
      ),
    };
  }
  return { viewer, error: null };
}

export async function GET() {
  const { viewer, error } = await resolveViewer();
  if (error) return error;

  const profile = await loadEditableProfile(supabase, viewer.entityId);
  return NextResponse.json({ profile });
}

export async function PATCH(req: Request) {
  const { viewer, error } = await resolveViewer();
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = ProfilePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That profile update isn't valid.", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await applyProfilePatch(supabase, {
    entityId: viewer.entityId,
    patch: parsed.data,
    source: "profile-form",
  });

  // Only when something moved — re-embedding an unchanged profile is a wasted model
  // call on every stray save.
  const embedded = result.written || result.retired
    ? await refreshProfileEmbedding(supabase, viewer.entityId)
    : true;

  const profile = await loadEditableProfile(supabase, viewer.entityId);
  return NextResponse.json({ profile, ...result, embedded });
}
