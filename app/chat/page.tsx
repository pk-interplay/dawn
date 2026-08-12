import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { UIMessage } from "ai";

import { auth } from "../../src/auth";
import { supabase } from "../../src/lib/supabase";
import { resolveViewerEntity } from "../../src/lib/entity-identity";
import { isAdmin } from "../lib/admin-auth";
import {
  listThreads,
  loadThreadMessages,
  threadExists,
  isThreadId,
} from "../../src/lib/chat-threads";
import { DawnShell } from "../components/DawnSidebar";
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
export default async function Chat({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; q?: string }>;
}) {
  const session = await auth();
  // pages.signIn is "/", so a GET to /api/auth/signin just bounces back to the
  // landing page anyway — redirect straight there, where the real sign-in lives.
  if (!session?.user?.id) redirect("/");

  // Service-role client, matching /onboarding. Resolving identity through the
  // publishable-key `db` gated the answer behind RLS on `entities`, so onboarding
  // (service role) saw the user as onboarded and bounced them here while chat saw
  // nothing and bounced them back — an infinite /chat ⇄ /onboarding loop.
  const viewer = await resolveViewerEntity(supabase, session);
  // No entity at all, or never confirmed a profile — either way onboarding is the next
  // step, and it short-circuits to here if it turns out they are already done.
  if (!viewer || !viewer.onboardedAt) redirect("/onboarding");

  const { count } = await supabase
    .from("edges")
    .select("id", { count: "exact", head: true })
    .eq("kind", "knows")
    .eq("from_id", viewer.entityId);

  // Every conversation is addressable, including one with no rows yet — the thread is
  // written when its first turn lands, but the id is real from the start. So a request
  // without a usable `?t=` is redirected to a freshly minted one rather than rendering
  // at a URL you could never return to, and "new chat" becomes an ordinary navigation.
  const params = await searchParams;
  if (!isThreadId(params.t)) redirect(freshThreadUrl(params.q));
  const threadId = params.t;

  // Hydrating history here rather than fetching client-side means switching threads is
  // an ordinary navigation, and it is on screen in the first paint instead of after a
  // spinner. Null means "not there, or not theirs" — the first is the ordinary case of a
  // brand-new id and keeps it; the second would only be caught at write time, so it
  // trades the id for a free one instead of streaming into a refusal.
  const threads = await listThreads(supabase, viewer.entityId);
  const stored = await loadThreadMessages(supabase, viewer.entityId, threadId);
  if (!stored && (await threadExists(supabase, threadId))) redirect(freshThreadUrl(params.q));

  return (
    <DawnShell signedIn isAdmin={await isAdmin()}>
      <ChatSurface
        // Remount on thread switch. `?t=` changes are a soft navigation, so without a
        // key the surface would keep the previous thread's useChat state alive.
        key={threadId}
        firstName={session.user.name?.trim().split(/\s+/)[0] ?? null}
        networkSize={count ?? 0}
        threads={threads}
        threadId={threadId}
        // `parts` comes back from jsonb as unknown[]; it was a UIMessage's parts when it
        // went in and nothing else writes these rows. Asserting here keeps the storage
        // helpers free of an AI SDK type dependency.
        initialMessages={(stored ?? []) as UIMessage[]}
      />
    </DawnShell>
  );
}

/** `?q=` is the landing page's starter question; it has to survive the redirect. */
function freshThreadUrl(q: string | undefined): string {
  const params = new URLSearchParams({ t: crypto.randomUUID() });
  if (q) params.set("q", q);
  return `/chat?${params}`;
}
