import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "../../src/auth";
import { supabase } from "../../src/lib/supabase";
import { resolveViewerEntity } from "../../src/lib/entity-identity";
import { ProfileDraftSchema } from "../../src/lib/synthesize-profile";
import { OnboardingFlow } from "./OnboardingFlow";

export const metadata: Metadata = {
  title: "Setting up Dawn",
};

/**
 * The gate in front of onboarding.
 *
 * Three short-circuits, all server-side so there is no flash of the wrong screen:
 * no Google session → home (which is the sign-in page), already onboarded →
 * straight to the chat, and a draft already staged → straight to the review screen.
 *
 * "Already onboarded" is `entities.onboarded_at`, not "has a headline claim".
 * A user can regenerate a draft, and a claim can be superseded, so claim presence
 * answers "do we know anything about them" rather than "have they finished" — and
 * conflating the two would put a returning user back through the ingest screen.
 *
 * The staged-draft check exists because the ingest is expensive enough to fail. A user
 * whose synthesis succeeded but who never reached Confirm — closed the tab, lost the
 * connection, or had the function killed just after the draft was written — used to be
 * sent back through a full six-month Gmail read on every single load, which for a large
 * mailbox does not fit in the route's budget and so could never complete. Their draft
 * was sitting in `profile_drafts` the whole time. Read it and show it.
 */
export default async function Onboarding() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  // No access token means the Google grant could not be refreshed. Send them home
  // rather than to /api/auth/signin, which — because pages.signIn is "/" — only
  // redirects to home anyway (a GET there cannot start the POST+CSRF Google flow).
  // Full recovery from a tokenless session still needs a fresh Google grant; that
  // gap is unchanged, this just drops a pointless hop through a looping endpoint.
  if (!session.accessToken) redirect("/");

  const viewer = await resolveViewerEntity(supabase, session);
  if (viewer?.onboardedAt) redirect("/chat");

  const initialDraft = viewer ? await readStagedDraft(viewer.entityId) : null;

  return (
    <OnboardingFlow
      firstName={session.user.name?.trim().split(/\s+/)[0] ?? null}
      initialDraft={initialDraft}
    />
  );
}

/**
 * The draft this user already has staged, or null. Validated with the same schema the
 * Confirm route validates against (`confirm/route.ts`), for the same reason: the column
 * is jsonb, so a schema change or a hand-edited row would otherwise reach the client as
 * a review screen it cannot render. An unreadable draft is treated as no draft — the
 * ingest re-runs and overwrites it, which is the recoverable outcome.
 */
async function readStagedDraft(entityId: string) {
  const { data, error } = await supabase
    .from("profile_drafts")
    .select("draft")
    .eq("entity_id", entityId)
    .maybeSingle();

  // Never block onboarding on this read: the worst case of failing open is the ingest
  // the user would have run anyway.
  if (error) {
    console.error("[onboarding] could not read staged draft:", error.message);
    return null;
  }
  if (!data) return null;

  const parsed = ProfileDraftSchema.safeParse(data.draft);
  if (!parsed.success) {
    console.error("[onboarding] staged draft failed validation:", parsed.error.message);
    return null;
  }
  return parsed.data;
}
