import { NextResponse } from "next/server";
import pLimit from "p-limit";

import { requireAdmin } from "../../../../lib/admin-auth";
import { supabase } from "../../../../../src/lib/supabase";
import { summarizeEntity } from "../../../../../src/lib/summarize-entity";
import type { SummarizeResponse } from "../../../../admin/graph/types";

/**
 * Summarize + embed a bounded set of entities, so they can be placed on the map.
 *
 * **Hard-capped at 25, and there is deliberately no "summarize all".** An unbounded
 * button over a few hundred unplaced entities is a few hundred Haiku calls plus a few
 * hundred embedding calls behind a function timeout that will kill it halfway — with no
 * record of which ones succeeded. That is a money-and-data bug, not a UX nit. Per-id
 * results come back so a partial run is legible.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BATCH = 25;
const CONCURRENCY = 4;

export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // Fail with the name of the missing key rather than a provider error deep in a batch.
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const ids: unknown = body?.entityIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "entityIds must be a non-empty array" }, { status: 400 });
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `At most ${MAX_BATCH} entities per request (got ${ids.length})` },
      { status: 400 },
    );
  }

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(
    (ids as string[]).map((id) =>
      limit(async () => {
        try {
          await summarizeEntity(supabase, id);
          return { id, ok: true };
        } catch (err) {
          // One failure must not lose the successes — same posture as writeClaims.
          return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  );

  const response: SummarizeResponse = { results };
  return NextResponse.json(response);
}
