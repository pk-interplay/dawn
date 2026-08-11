import { NextResponse } from "next/server";

import { auth } from "../../../../src/auth";
import { db } from "../../../lib/db";
import { supabase } from "../../../../src/lib/supabase";
import { resolveViewerEntity } from "../../../../src/lib/entity-identity";
import { deleteThread, isThreadId, listThreads } from "../../../../src/lib/chat-threads";

/**
 * The thread menu's data. GET lists, DELETE removes one.
 *
 * The chat page server-renders its own list from the same helpers, so GET exists for the
 * menu to refresh after a delete without a full navigation. Identity resolves through
 * the anon `db` client (a read, like /api/chat), while the thread rows themselves go
 * through service role because RLS denies everything on those tables by design.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function viewer() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return resolveViewerEntity(db, session);
}

export async function GET() {
  const identity = await viewer();
  if (!identity) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  return NextResponse.json({ threads: await listThreads(supabase, identity.entityId) });
}

export async function DELETE(req: Request) {
  const identity = await viewer();
  if (!identity) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!isThreadId(id)) {
    return NextResponse.json({ error: "Missing or malformed id" }, { status: 400 });
  }

  // Scoped to the viewer's entity, so deleting someone else's thread is a no-op rather
  // than an error — same reason loads collapse "gone" and "not yours".
  await deleteThread(supabase, identity.entityId, id);
  return NextResponse.json({ ok: true });
}
