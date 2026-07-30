/**
 * Dawn people-graph MCP server (stdio).
 *
 * Exposes the dawn-v0 people graph to any MCP client — in particular the
 * Hermes gateway agent "Dawn" — as LLM tool calls. The agent calls these tools
 * when a conversation references finding, introducing, or onboarding people.
 *
 * Transport: stdio. The client (Hermes) launches this process on demand.
 *
 * It imports dawn-v0's own src/lib code directly and talks to Supabase itself,
 * so the Next.js web app does NOT need to be running.
 *
 * IMPORTANT: several lib modules (supabase.ts / openai.ts / anthropic.ts) read
 * env vars and construct clients at *module load* time. We therefore load the
 * dawn-v0 .env by absolute path FIRST, then dynamically import those modules,
 * so this works no matter what cwd the MCP client spawns us from.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// MCP speaks JSON-RPC over stdout — NOTHING else may be written there.
// dotenv v17 prints a promo/tip banner to stdout by default; silence it here
// and for the lib modules' own `import "dotenv/config"` side effects below.
process.env.DOTENV_CONFIG_QUIET = "true";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/mcp/server.ts -> dawn-v0/.env.local, then dawn-v0/.env. `.env.local` first:
// it's where this project's config lives, and dotenv keeps the first value it sees.
loadEnv({
  path: [resolve(HERE, "../../.env.local"), resolve(HERE, "../../.env")],
  quiet: true,
});

// Dynamic imports AFTER env is loaded (these modules build clients on load).
const { supabase } = await import("../lib/supabase.js");
const { embed } = await import("../lib/openai.js");
const { anthropic, textOf } = await import("../lib/anthropic.js");
const { fetchCandidates, fetchCalibration, fetchPreferences, fetchRecentHistory } =
  await import("../lib/candidates.js");
const { rerank, validateMatches } = await import("../lib/rerank.js");
import type { Person } from "../lib/types.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const SHORTLIST_MAX = 5;
const DAILY_INTRO_LIMIT = 1; // one introduction per requester per day

// ---- MCP result helpers -----------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Postgres "relation does not exist" — the intros migration hasn't been applied. */
function isMissingIntrosTable(err: { message?: string; code?: string }): boolean {
  return err?.code === "42P01" || /relation .*intros.* does not exist/i.test(err?.message ?? "");
}

function startOfLocalDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---- query rerank (mirrors app/api/find/route.ts) ---------------------------

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
  candidates: Array<Record<string, unknown>>,
): Promise<Array<{ id: string; name: string; score: number; rationale: string }>> {
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
    } as Parameters<typeof anthropic.messages.create>[0],
    { timeout: 30_000 },
  );
  const parsed = JSON.parse(textOf(resp as never));
  if (!Array.isArray(parsed?.people)) throw new Error("Claude returned malformed JSON — expected a `people` array.");
  return parsed.people;
}

// ---- server & tools ---------------------------------------------------------

const server = new McpServer({ name: "dawn-graph", version: "0.1.0" });

server.tool(
  "find_people",
  "Search the Dawn people graph for real people who can help with a specific ask. " +
    "Use this whenever the user wants to be connected to, introduced to, or find someone — " +
    "an advisor, a hire, a design partner, an investor, or an expert on a topic. " +
    "Pass a natural-language description of WHO to find and WHAT help is needed, written from " +
    "the searcher's point of view (what they want). Good query: 'an experienced fintech founder " +
    "who can advise on payments compliance'. Set rerank=true for a curated shortlist with a written " +
    "rationale per person (slower); leave it off for a fast, broader similarity list. " +
    "Returns matching people with id, name, headline, what they offer, and what they're looking for.",
  {
    query: z.string().describe("Natural-language description of who to find and what help is needed, from the searcher's perspective."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max people to return (1-25). Default 10."),
    rerank: z.boolean().optional().describe("If true, Claude reranks by true fit and attaches a rationale per person, dropping poor fits."),
  },
  async ({ query, limit, rerank }) => {
    try {
      const q = query?.trim();
      if (!q) return fail("Missing `query`.");
      const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const queryEmbedding = await embed(q);
      const { data, error } = await supabase.rpc("match_people_by_offering", {
        query_embedding: queryEmbedding,
        exclude_id: NIL_UUID,
        match_count: lim,
        query_tags_embedding: null,
      });
      if (error) throw new Error(error.message);
      const candidates = (data ?? []) as Array<Record<string, unknown>>;
      if (rerank && candidates.length > 0) {
        const ranked = await rerankForQuery(q, candidates);
        return ok({ query: q, mode: "ranked", count: ranked.length, people: ranked });
      }
      return ok({ query: q, mode: "similarity", count: candidates.length, people: candidates });
    } catch (err) {
      return fail(err instanceof Error ? err.message : "find_people failed");
    }
  },
);

server.tool(
  "add_person",
  "Add a new person to the Dawn people graph so they can be matched and introduced. " +
    "Use this when someone new is onboarding — capture who they are, what they can offer others, " +
    "and what they're looking for. Requires name, offering, and looking_for; the rest is optional but " +
    "improves match quality. Embeddings are generated automatically. Returns the created person, including its id.",
  {
    name: z.string().describe("Person's full name."),
    offering: z.string().describe("What they can give others: expertise, intros, capital, time, etc."),
    looking_for: z.string().describe("Their stated ask / intent — what they want help with."),
    headline: z.string().optional().describe("One-line role/positioning, e.g. 'Seed-stage climate tech founder'."),
    bio: z.string().optional().describe("2-4 sentence background."),
    tags: z.array(z.string()).optional().describe("Skills/interests/industry keywords."),
    industry: z.string().optional(),
    career_stage: z.string().optional(),
    location: z.string().optional(),
    meeting_format: z.string().optional().describe("'async' | 'call' | 'in_person'"),
    ask_must_haves: z.array(z.string()).optional(),
    ask_nice_to_haves: z.array(z.string()).optional(),
  },
  async (p) => {
    try {
      if (!p.name?.trim() || !p.offering?.trim() || !p.looking_for?.trim())
        return fail("name, offering, and looking_for are required.");

      const record: Record<string, unknown> = {
        name: p.name,
        headline: p.headline || null,
        bio: p.bio || null,
        offering: p.offering,
        looking_for: p.looking_for,
        tags: p.tags ?? [],
        industry: p.industry || null,
        career_stage: p.career_stage || null,
        location: p.location || null,
        meeting_format: p.meeting_format || null,
        ask_must_haves: p.ask_must_haves ?? [],
        ask_nice_to_haves: p.ask_nice_to_haves ?? [],
      };

      let embedded = false;
      if (process.env.OPENAI_API_KEY) {
        const [eOffer, eLooking, eTags] = await Promise.all([
          embed(`${p.headline ?? ""}. Offers: ${p.offering}. Relevant background: ${p.bio ?? ""}`),
          embed(`Looking for: ${p.looking_for}. Context: ${p.bio ?? ""}`),
          embed(`${p.industry ?? ""}. ${p.career_stage ?? ""}. Tags: ${(p.tags ?? []).join(", ")}. Location: ${p.location ?? ""}.`),
        ]);
        record.embedding_offering = eOffer;
        record.embedding_looking_for = eLooking;
        record.embedding_tags = eTags;
        embedded = true;
      }

      const { data, error } = await supabase.from("people").insert(record).select().single();
      if (error) throw new Error(error.message);
      return ok({ person: data, embedded });
    } catch (err) {
      return fail(err instanceof Error ? err.message : "add_person failed");
    }
  },
);

server.tool(
  "get_matches",
  "Get suggested introductions for a person who is already in the graph, by their id. " +
    "Runs bidirectional vector search (their needs vs others' offerings and vice versa) and, when possible, " +
    "an AI rerank with a rationale per match. Also returns any previously saved matches. " +
    "Use when you know the person's id (e.g. from add_person or find_people) and want their tailored shortlist.",
  {
    person_id: z.string().describe("The people.id (uuid) to compute matches for."),
  },
  async ({ person_id }) => {
    try {
      const { data: person, error: pErr } = await supabase.from("people").select("*").eq("id", person_id).single();
      if (pErr) throw new Error(pErr.message);
      const typed = person as Person;

      // Previously saved matches, with the other person's name/headline.
      const { data: saved } = await supabase
        .from("matches")
        .select("*")
        .or(`person_a_id.eq.${person_id},person_b_id.eq.${person_id}`)
        .order("created_at", { ascending: false });
      const savedRows = saved ?? [];
      const otherIds = savedRows.map((m) => (m.person_a_id === person_id ? m.person_b_id : m.person_a_id));
      const nameById = new Map<string, { id: string; name: string; headline: string | null }>();
      if (otherIds.length) {
        const { data: others } = await supabase.from("people").select("id, name, headline").in("id", otherIds);
        for (const o of others ?? []) nameById.set(o.id, o);
      }
      const savedOut = savedRows.map((m) => ({
        id: m.id,
        other: nameById.get(m.person_a_id === person_id ? m.person_b_id : m.person_a_id) ?? null,
        score: m.score,
        rationale: m.rationale,
        direction: m.direction,
        status: m.status,
        created_at: m.created_at,
      }));

      if (!typed.embedding_offering || !typed.embedding_looking_for) {
        return ok({
          mode: "no_embeddings",
          note: "This person has no embeddings yet — they were likely added without an OPENAI_API_KEY. Re-add with embeddings to enable matching.",
          matches: [],
          saved: savedOut,
        });
      }

      const { candidates } = await fetchCandidates(supabase, typed);
      if (candidates.length === 0) return ok({ mode: "ranked", matches: [], saved: savedOut });

      if (!process.env.ANTHROPIC_API_KEY) {
        return ok({
          mode: "similarity_only",
          note: "No ANTHROPIC_API_KEY — returning raw vector-similarity candidates without AI rationale.",
          matches: candidates.slice(0, SHORTLIST_MAX),
          saved: savedOut,
        });
      }

      const [calibration, preferences, history] = await Promise.all([
        fetchCalibration(supabase, typed.id),
        fetchPreferences(supabase, typed.id),
        fetchRecentHistory(supabase, typed.id),
      ]);
      const ranked = await rerank(typed, candidates, calibration, preferences, history);
      const { valid } = validateMatches(ranked, candidates);
      const matches = valid.map((m) => ({
        candidate_id: m.candidate_id,
        score: m.score,
        direction: m.direction,
        rationale: m.rationale,
        candidate: m.candidate,
      }));
      return ok({ mode: "ranked", matches, saved: savedOut });
    } catch (err) {
      return fail(err instanceof Error ? err.message : "get_matches failed");
    }
  },
);

server.tool(
  "record_intro",
  "Record that you have made an introduction for someone, and enforce the daily limit. " +
    "Call this ONLY when you are actually making an introduction (connecting the requester to a specific person). " +
    "This enforces at most ONE introduction per requester per day: if the requester has already been introduced " +
    "to someone today, it returns { limit_reached: true } and records nothing — in that case, do NOT make another " +
    "introduction; instead let them know warmly and offer other help. " +
    "`requester_ref` must be a STABLE identifier for the person you're helping (e.g. their messaging handle/user id), " +
    "used consistently so the daily count is accurate.",
  {
    requester_ref: z.string().describe("Stable identifier for the person you are helping (e.g. Telegram user id/handle, or a people.id). The daily limit is enforced per this value."),
    introduced_to_id: z.string().describe("people.id (uuid) of the person they are being introduced to."),
    rationale: z.string().optional().describe("Short note on why this introduction was made."),
    channel: z.string().optional().describe("Where the intro happened, e.g. 'telegram'."),
  },
  async ({ requester_ref, introduced_to_id, rationale, channel }) => {
    try {
      const ref = requester_ref?.trim();
      if (!ref) return fail("requester_ref is required (a stable id for the person you're helping).");
      if (!introduced_to_id?.trim()) return fail("introduced_to_id is required.");

      const since = startOfLocalDay();
      const { data: today, error: cErr } = await supabase
        .from("intros")
        .select("id, introduced_to_id, created_at, rationale")
        .eq("requester_ref", ref)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false });
      if (cErr) {
        if (isMissingIntrosTable(cErr))
          return fail("The `intros` table does not exist yet — apply supabase/migrations/0005_intros.sql, then retry.");
        throw new Error(cErr.message);
      }

      if ((today ?? []).length >= DAILY_INTRO_LIMIT) {
        return ok({
          ok: false,
          limit_reached: true,
          message: `Daily introduction limit reached (${DAILY_INTRO_LIMIT}/day) for this person. Do not make another introduction today.`,
          intros_today: today,
        });
      }

      const { data, error } = await supabase
        .from("intros")
        .insert({ requester_ref: ref, introduced_to_id, rationale: rationale ?? null, channel: channel ?? null })
        .select()
        .single();
      if (error) {
        if (isMissingIntrosTable(error))
          return fail("The `intros` table does not exist yet — apply supabase/migrations/0005_intros.sql, then retry.");
        throw new Error(error.message);
      }

      return ok({
        ok: true,
        intro: data,
        message: "Introduction recorded. This used today's one allowed introduction for this person.",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : "record_intro failed");
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
