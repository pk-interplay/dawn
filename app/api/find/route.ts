import { NextResponse } from "next/server";
import { db } from "../../lib/db";
import { requireUser } from "../../lib/session-user";
import { rerankForQuery } from "../../../src/lib/query-rerank";

// Agent-facing "find people" endpoint.
//
// Unlike /api/people/[id]/matches (which matches an existing person row),
// this takes a free-text ask and finds people who can satisfy it — the
// primitive an agent (or an MCP wrapper over it) calls to discover humans.
//
// The query describes what the caller is *looking for*, so we embed it and
// search against everyone's `embedding_offering` (people who OFFER that).

// Embed + vector search is fast, but rerank=true adds an Opus call with a 30s
// SDK timeout and retries; the platform default (~15s) killed it mid-flight.
export const maxDuration = 60;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

interface FindBody {
  query?: string;
  limit?: number;
  rerank?: boolean;
}

export async function POST(request: Request) {
  // Every call embeds caller text (OpenAI spend) and can trigger a Claude rerank —
  // signed-in members only. Note: src/agent/findTool.ts's unauthenticated HTTP demo
  // no longer works against this route; the MCP server is unaffected (it queries
  // via the service-role client directly).
  const auth = await requireUser();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: FindBody;
  try {
    body = (await request.json()) as FindBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = body.query?.trim();
  if (!query) {
    return NextResponse.json(
      { error: "Missing `query` — a natural-language description of who you're looking for" },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is required to embed the query for vector search" },
      { status: 400 },
    );
  }

  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const { embed } = await import("../../../src/lib/openai");
    const queryEmbedding = await embed(query);

    const { data, error } = await db.rpc("match_people_by_offering", {
      query_embedding: queryEmbedding,
      exclude_id: NIL_UUID,
      match_count: limit,
      // Disambiguates the overloaded RPC (migrations 0002 vs 0004); null keeps
      // pure offering-similarity without the tag-embedding blend.
      query_tags_embedding: null,
    });
    if (error) throw new Error(error.message);

    const candidates = (data ?? []) as Array<{
      id: string;
      name: string;
      headline: string | null;
      offering: string | null;
      looking_for: string | null;
      tags: string[];
      similarity: number;
    }>;

    // Optional Claude rerank: reorder by fit to the query and attach a rationale.
    if (body.rerank && candidates.length > 0) {
      if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json(
          { error: "ANTHROPIC_API_KEY is required when rerank=true" },
          { status: 400 },
        );
      }
      const ranked = await rerankForQuery(query, candidates);
      return NextResponse.json({ query, mode: "ranked", count: ranked.length, people: ranked });
    }

    return NextResponse.json({
      query,
      mode: "similarity",
      count: candidates.length,
      people: candidates,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to find people" },
      { status: 500 },
    );
  }
}

