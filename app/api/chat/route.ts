import { createAgentUIStreamResponse } from "ai";
import { NextResponse } from "next/server";

import { auth } from "../../../src/auth";
import { db } from "../../lib/db";
import { resolveViewerEntity } from "../../../src/lib/entity-identity";
import { createDawnAgent } from "../../../src/lib/dawn-agent";
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

  const agent = await createDawnAgent({
    client: db,
    viewerEntityId: viewer.entityId,
    viewerEmail: viewer.email,
    scope,
  });

  return createAgentUIStreamResponse({
    agent,
    uiMessages: body?.messages ?? [],
  });
}
