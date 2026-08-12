import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "../../src/auth";
import { supabase } from "../../src/lib/supabase";
import { resolveViewerEntity } from "../../src/lib/entity-identity";
import { loadEditableProfile } from "../../src/lib/profile-edit";
import { isAdmin } from "../lib/admin-auth";
import { DawnShell } from "../components/DawnSidebar";
import { ProfileEditor } from "./ProfileEditor";

export const metadata: Metadata = {
  title: "Your profile",
};

/**
 * What the network sees, and the one place to change it by hand.
 *
 * Server-loaded rather than fetched by the editor on mount: this page is mostly text
 * you already own, and a spinner in front of your own headline is the wrong first
 * impression. The GET on /api/profile exists for the client to re-read after a save.
 *
 * Same gates as /chat — no session goes home (which IS the sign-in page), no confirmed
 * profile goes to onboarding, since editing a profile you have not yet created would
 * write claims that bypass the confirm step entirely.
 */
export default async function Profile() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const viewer = await resolveViewerEntity(supabase, session);
  if (!viewer || !viewer.onboardedAt) redirect("/onboarding");

  const profile = await loadEditableProfile(supabase, viewer.entityId);

  return (
    <DawnShell signedIn isAdmin={await isAdmin()}>
      <ProfileEditor initial={profile} />
    </DawnShell>
  );
}
