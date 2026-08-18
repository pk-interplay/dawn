import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";
import type { Person } from "../../../../../src/lib/types";
import {
  fetchCandidates,
  fetchCalibration,
  fetchPreferences,
  fetchRecentHistory,
} from "../../../../../src/lib/candidates";
import { rerank, validateMatches } from "../../../../../src/lib/rerank";

// The rerank is a streamed Opus call with thinking enabled — it can legitimately
// exceed the platform's ~15s default.
export const maxDuration = 120;

const SHORTLIST_MAX = 5;

async function fetchPerson(id: string): Promise<Person> {
  const { data, error } = await db.from("people").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as Person;
}

async function fetchSaved(id: string) {
  const { data: saved, error } = await db
    .from("matches")
    .select("*")
    .or(`person_a_id.eq.${id},person_b_id.eq.${id}`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const otherIds = (saved ?? []).map((m) => (m.person_a_id === id ? m.person_b_id : m.person_a_id));
  if (otherIds.length === 0) return [];

  const { data: others, error: othersError } = await db
    .from("people")
    .select("id, name, headline")
    .in("id", otherIds);
  if (othersError) throw new Error(othersError.message);

  const byId = new Map((others ?? []).map((p) => [p.id, p]));
  return (saved ?? []).map((m) => ({
    id: m.id,
    other: byId.get(m.person_a_id === id ? m.person_b_id : m.person_a_id) ?? null,
    score: m.score,
    rationale: m.rationale,
    direction: m.direction,
    status: m.status,
    created_at: m.created_at,
  }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Leaks any member's full profile + candidate list by uuid and burns an Opus
  // rerank per call. No member UI calls this — operator/debug surface, admin only.
  // (The `trace` array in responses is acceptable to keep under this gate.)
  const auth = await requireAdmin();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { id } = await params;
  const trace: string[] = [];
  try {
    trace.push(`Loading profile ${id}…`);
    const person = await fetchPerson(id);
    trace.push(`Loaded ${person.name} — offering: "${person.offering}" / looking for: "${person.looking_for}"`);
    const saved = await fetchSaved(id);

    if (!person.embedding_offering || !person.embedding_looking_for) {
      trace.push("No embeddings on this profile — cannot run vector search.");
      return NextResponse.json({
        mode: "no_embeddings",
        note: "This person has no embeddings yet — they were likely added without an OPENAI_API_KEY configured. Add one and re-submit to enable matching.",
        candidates: [],
        saved,
        trace,
      });
    }

    trace.push(
      `Running vector search: match_people_by_offering (their "looking for" vs everyone's "offering") and match_people_by_looking_for (their "offering" vs everyone's "looking for"), blended with tag-embedding similarity when available.`,
    );
    const { candidates, wantsFilledCount, offersWantedCount, mutualCount, excludedRejectedCount } =
      await fetchCandidates(db, person);
    trace.push(
      `Vector search returned ${wantsFilledCount} + ${offersWantedCount} candidates ` +
        `→ merged into ${candidates.length + excludedRejectedCount} unique people (${mutualCount} flagged mutual).` +
        (excludedRejectedCount > 0
          ? ` Excluded ${excludedRejectedCount} previously-rejected candidate(s).`
          : ""),
    );

    if (!process.env.ANTHROPIC_API_KEY) {
      trace.push("No ANTHROPIC_API_KEY configured — skipping AI rerank step.");
      return NextResponse.json({
        mode: "similarity_only",
        note: "No ANTHROPIC_API_KEY configured — showing raw vector-similarity candidates without AI-ranked rationale.",
        candidates: candidates.slice(0, SHORTLIST_MAX),
        saved,
        trace,
      });
    }

    if (candidates.length === 0) {
      trace.push("No candidates found — nothing to rerank.");
      return NextResponse.json({ mode: "ranked", matches: [], saved, trace });
    }

    // Same three sources of learned signal the cron path uses. Without the last
    // two, this view ranked on the profile alone and silently disagreed with the
    // intros Dawn actually sends.
    const [calibration, preferences, history] = await Promise.all([
      fetchCalibration(db, person.id),
      fetchPreferences(db, person.id),
      fetchRecentHistory(db, person.id),
    ]);
    trace.push(
      `Sending ${candidates.length} candidates to Claude to rerank and write rationale` +
        (calibration.length ? ` (with ${calibration.length} past accepted/rejected example(s) for calibration)` : "") +
        (preferences.length ? ` (with ${preferences.length} stated preference(s))` : "") +
        (history.length ? ` (with ${history.length} recent repl(ies))` : "") +
        `…`,
    );
    const ranked = await rerank(person, candidates, calibration, preferences, history, Date.now() + 90_000);
    const { valid, notes } = validateMatches(ranked, candidates);
    trace.push(...notes);
    trace.push(
      `Claude returned ${ranked.length} pick(s) → ${notes.length} correction(s)/drop(s), ${valid.length} valid.`,
    );

    const matches = valid.map((m) => ({
      candidate_id: m.candidate_id,
      score: m.score,
      direction: m.direction,
      rationale: m.rationale,
      candidate: m.candidate,
    }));

    return NextResponse.json({ mode: "ranked", matches, saved, trace });
  } catch (err) {
    trace.push(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute matches", trace },
      { status: 500 },
    );
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Writes `matches` rows and spends an Opus rerank — admin only, like GET.
  const auth = await requireAdmin();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { id } = await params;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is required to generate rationale for saved matches." },
      { status: 400 },
    );
  }

  try {
    const person = await fetchPerson(id);
    if (!person.embedding_offering || !person.embedding_looking_for) {
      return NextResponse.json(
        { error: "This person has no embeddings yet — add an OPENAI_API_KEY and re-submit first." },
        { status: 400 },
      );
    }

    const { candidates } = await fetchCandidates(db, person);
    if (candidates.length === 0) {
      return NextResponse.json({ inserted: 0, corrected: 0, dropped: 0 });
    }

    const [calibration, preferences, history] = await Promise.all([
      fetchCalibration(db, person.id),
      fetchPreferences(db, person.id),
      fetchRecentHistory(db, person.id),
    ]);
    const ranked = await rerank(person, candidates, calibration, preferences, history, Date.now() + 90_000);
    const { valid, notes } = validateMatches(ranked, candidates);
    const corrected = notes.filter((n) => n.startsWith("Corrected")).length;
    const dropped = notes.filter((n) => n.startsWith("Dropped")).length;

    const rows = valid.map((m) => ({
      person_a_id: person.id,
      person_b_id: m.candidate_id,
      score: m.score,
      direction: m.direction,
      rationale: m.rationale,
    }));

    const { data, error } = await db
      .from("matches")
      .upsert(rows, { onConflict: "person_low,person_high" })
      .select();
    if (error) throw new Error(error.message);

    return NextResponse.json({ inserted: data.length, corrected, dropped });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save matches" },
      { status: 500 },
    );
  }
}
