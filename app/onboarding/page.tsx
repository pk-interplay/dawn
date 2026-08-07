import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "../../src/auth";
import { supabase } from "../../src/lib/supabase";
import { resolveViewerEntity } from "../../src/lib/entity-identity";
import { OnboardingFlow } from "./OnboardingFlow";

export const metadata: Metadata = {
  title: "Setting up Dawn",
};

/**
 * The gate in front of onboarding.
 *
 * Two short-circuits, both server-side so there is no flash of the wrong screen:
 * no Google session → home (which is the sign-in page), and already onboarded →
 * straight to the chat.
 *
 * "Already onboarded" is `entities.onboarded_at`, not "has a headline claim".
 * A user can regenerate a draft, and a claim can be superseded, so claim presence
 * answers "do we know anything about them" rather than "have they finished" — and
 * conflating the two would put a returning user back through the ingest screen.
 */
export default async function Onboarding() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  // No access token means the Google grant could not be refreshed. Sending them back
  // to sign in is the only thing that fixes it, and Gmail ingest is the entire point
  // of this screen — there is nothing to show without it.
  if (!session.accessToken) redirect("/api/auth/signin?callbackUrl=%2Fonboarding");

  const viewer = await resolveViewerEntity(supabase, session);
  if (viewer?.onboardedAt) redirect("/chat");

  return <OnboardingFlow firstName={session.user.name?.trim().split(/\s+/)[0] ?? null} />;
}
