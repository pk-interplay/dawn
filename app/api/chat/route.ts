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
 * Uses `db` (the publishable/anon key) rather than the service-role client, unlike the
 * ingest and onboarding routes. Three reasons: chat only reads; keeping service-role for
 * the routes that WRITE preserves a distinction that would otherwise erode; and both SQL
 * functions the tools call are `stable` and not `security definer`, so the workspace RLS
 * policies from 0026 stay live on every read. Authorization itself is here in the
 * handler, as it is everywhere else in this app.
 *
 * The one exception is thread persistence (0034), which writes and therefore uses the
 * service-role client — with the entity check done here, before anything streams.
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

  const uiMessages: StoredMessage[] = body?.messages ?? [];

  // Persist the user's turn up front rather than in onEnd. If the model call fails or
  // the user navigates away mid-stream, the question they asked is still there when
  // they come back — losing the answer is recoverable, losing the question is not.
  const lastUser = [...uiMessages].reverse().find((message) => message.role === "user");
  if (lastUser) {
    await saveMessage(supabase, threadId, lastUser);
    await setThreadTitleIfUnset(supabase, threadId, textOf(uiMessages[0]));
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
