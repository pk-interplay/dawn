import { NextResponse } from "next/server";
import { db } from "../../lib/db";

// Agent-facing "find people" endpoint.
//
// Unlike /api/people/[id]/matches (which matches an existing person row),
// this takes a free-text ask and finds people who can satisfy it — the
// primitive an agent (or an MCP wrapper over it) calls to discover humans.
//
// The query describes what the caller is *looking for*, so we embed it and
// search against everyone's `embedding_offering` (people who OFFER that).

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

interface FindBody {
  query?: string;
  limit?: number;
  rerank?: boolean;
}

export async function POST(request: Request) {
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

const QUERY_RERANK_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          score: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["id", "name", "score", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
} as const;

async function rerankForQuery(
  query: string,
  candidates: Array<{ id: string; name: string; headline: string | null; offering: string | null; looking_for: string | null; tags: string[]; similarity: number }>,
) {
  const { anthropic, textOf } = await import("../../../src/lib/anthropic");
  const resp = await anthropic.messages.create(
    {
      model: "claude-opus-4-8",
      max_tokens: 4000,
      output_config: { format: { type: "json_schema", schema: QUERY_RERANK_SCHEMA } },
      messages: [
        {
          role: "user",
          content:
            `A caller is looking for people matching this ask: "${query}"\n\n` +
            `Candidates (with preliminary vector-similarity scores): ${JSON.stringify(candidates)}\n\n` +
            `Rank the candidates who genuinely fit the ask, best first. For each, write a 1-3 sentence rationale that is specific about what this person offers that satisfies the ask — not just topical overlap. Assign a 0-1 score for strength of fit. Use the id and name values exactly as given. Omit candidates that don't actually fit.`,
        },
      ],
    },
    { timeout: 30_000 },
  );
  const parsed = JSON.parse(textOf(resp));
  if (!Array.isArray(parsed?.people)) {
    throw new Error("Claude returned malformed JSON — expected a `people` array.");
  }
  return parsed.people as Array<{ id: string; name: string; score: number; rationale: string }>;
}
