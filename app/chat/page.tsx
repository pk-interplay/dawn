import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "../../src/auth";
import { db } from "../lib/db";
import { resolveViewerEntity } from "../../src/lib/entity-identity";
import { DawnRail } from "../components/DawnRail";
import { ChatSurface } from "./ChatSurface";

export const metadata: Metadata = {
  title: "Chat with Dawn",
};

/**
 * The destination the landing page's one CTA has always pointed at in spirit.
 *
 * Counts the viewer's edges before rendering, because the difference between "you have
 * no network yet" and "Dawn found nothing" is the difference between an app that tells
 * you what to do and one that looks broken. With zero edges every suggestion chip would
 * come back empty, so the empty state becomes a link to onboarding instead.
 */
export default async function Chat() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin?callbackUrl=%2Fchat");

  const viewer = await resolveViewerEntity(db, session);
  // No entity at all, or never confirmed a profile — either way onboarding is the next
  // step, and it short-circuits to here if it turns out they are already done.
  if (!viewer || !viewer.onboardedAt) redirect("/onboarding");

  const { count } = await db
    .from("edges")
    .select("id", { count: "exact", head: true })
    .eq("kind", "knows")
    .eq("from_id", viewer.entityId);

  return (
    <>
      <ChatSurface
        firstName={session.user.name?.trim().split(/\s+/)[0] ?? null}
        networkSize={count ?? 0}
      />
      <DawnRail signedIn />
    </>
  );
}
