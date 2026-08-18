import { createAgentUIStreamResponse } from "ai";
import { NextResponse } from "next/server";

import { auth } from "../../../src/auth";
import { db } from "../../lib/db";
import { supabase } from "../../../src/lib/supabase";
import { resolveViewerEntity } from "../../../src/lib/entity-identity";
import { createDawnAgent } from "../../../src/lib/dawn-agent";
import {
  ensureThreadOwned,
  isThreadId,
  saveMessage,
  setThreadTitleIfUnset,
  textOf,
  touchThread,
  type StoredMessage,
} from "../../../src/lib/chat-threads";
import type { DawnScope } from "../../../src/lib/network-tools";

/**
 * The chat endpoint.
 *
 * `db` and `supabase` are both service-role clients now. The reads-on-anon-key split
 * this route used to keep died with migration 0041: RLS is enabled with zero policies
 * everywhere and the anon role's grants are revoked, so the publishable key can read
 * nothing. Authorization lives here in the handler — session, then thread ownership,
 * before anything streams — as it does everywhere else in this app.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A single turn chains embed() (200-500ms) + several Supabase round trips per tool call
// + a multi-step Sonnet loop. nexus used 30s for the same shape with ~2s of DB in front
// of it; dawn-v0 adds an embedding hop and exact-cosine SQL.
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  // Default to the NARROW scope on anything unrecognised. A parsing slip should never
  // widen what the model can see.
  const scope: DawnScope = body?.scope === "all" ? "all" : "mine";

  const threadId = body?.threadId;
  if (!isThreadId(threadId)) {
    return NextResponse.json({ error: "Missing or malformed threadId" }, { status: 400 });
  }

  const viewer = await resolveViewerEntity(db, session);
  if (!viewer) {
    // Distinguished from 401 on purpose: they are signed in, they just have no graph
    // yet. The UI turns this into a link to onboarding rather than an empty chat that
    // answers "no one matches that" to everything.
    return NextResponse.json(
      { error: "Dawn hasn't synced your network yet.", needsOnboarding: true },
      { status: 409 },
    );
  }

  // Before a single token streams: either this thread is theirs, or it is new and now
  // is. Anything else is somebody else's conversation and must not be appended to.
  if (!(await ensureThreadOwned(supabase, viewer.entityId, threadId))) {
    return NextResponse.json({ error: "No such conversation" }, { status: 404 });
  }

  // What the MODEL sees is capped to the last 30 turns. The client sends the
  // whole thread, and every turn re-sends everything it's given — tool results
  // included — so an unwindowed thread gets monotonically more expensive forever
  // (Sonnet's context fits it; the bill is the problem). Thirty turns is far
  // more than any introduction-finding conversation actually refers back to.
  const MAX_MODEL_MESSAGES = 30;
  const allMessages: StoredMessage[] = body?.messages ?? [];
  const uiMessages = allMessages.slice(-MAX_MODEL_MESSAGES);

  // Persist the user's turn up front rather than in onEnd. If the model call fails or
  // the user navigates away mid-stream, the question they asked is still there when
  // they come back — losing the answer is recoverable, losing the question is not.
  const lastUser = [...uiMessages].reverse().find((message) => message.role === "user");
  if (lastUser) {
    await saveMessage(supabase, threadId, lastUser);
    // Title from the thread's FIRST message — allMessages, not the model window.
    await setThreadTitleIfUnset(supabase, threadId, textOf(allMessages[0]));
  }

  const agent = await createDawnAgent({
    client: db,
    // Reads stay on the publishable key so RLS is live on every graph query; the
    // profile tools need a writer, and it is scoped to this one entity's own claims.
    writeClient: supabase,
    viewerEntityId: viewer.entityId,
    viewerEmail: viewer.email,
    scope,
  });

  return createAgentUIStreamResponse({
    agent,
    uiMessages,
    // Persistence mode: with the originals in hand the SDK gives the response message a
    // stable id, which is what makes `saveMessage` idempotent on retry.
    originalMessages: uiMessages as never,
    // Abort inside our own budget (maxDuration 60 − 5s headroom) so onEnd still
    // fires and the assistant turn persists as far as it got — a platform kill
    // skips onEnd and loses the answer entirely.
    abortSignal: AbortSignal.timeout(55_000),
    onEnd: async ({ responseMessage }) => {
      // A failed write must not take down a response the user has already read, so this
      // logs rather than throws; the thread simply misses that turn.
      try {
        await saveMessage(supabase, threadId, responseMessage as StoredMessage);
        await touchThread(supabase, threadId);
      } catch (error) {
        console.error("[chat] failed to persist assistant turn", error);
      }
    },
  });
}
