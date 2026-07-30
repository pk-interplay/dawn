import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import type { Person } from "../../../../src/lib/types";
import {
  fetchCandidates,
  fetchCalibration,
  fetchPreferences,
  fetchRecentHistory,
} from "../../../../src/lib/candidates";
import { rerank, validateMatches } from "../../../../src/lib/rerank";
import { startIntroduction } from "../../../../src/lib/intro-flow";

export const runtime = "nodejs";
// Matching + reranking is slow; give the batch room. Vercel/host caps still apply.
export const maxDuration = 300;

const DEFAULT_BATCH = 3; // people to actually open an intro for per run (keep runs light)
const SCAN_LIMIT = 200; // how many members to consider per run
// Windows in days; fractional on purpose. `burst` is the pilot tier — a member on it
// can receive an introduction every six hours, which with the three-hourly schedule
// of 0019 works out to at most four opt-in asks a day. It exists because 'daily' was
// the ceiling, and a three-day pilot on 'daily' delivers three emails in total: not
// enough to tell whether a stream of introductions feels valuable or feels like spam.
// `hourly` is the operator-testing tier (see CADENCES in lib/onboarding): with a
// runner firing every hour it allows ~24 opt-in asks a day, which is only tolerable
// when the recipient is the person running the test. Subtract a minute of slack so a
// runner that fires at 10:00:59 after a 09:00:12 intro isn't judged to be inside the
// window by 47 seconds and silently skipped for the whole hour.
const CADENCE_DAYS: Record<string, number> = {
  hourly: 1 / 24 - 1 / 1440,
  burst: 0.25,
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

type RunResult = Record<string, unknown>;

async function run(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is required." }, { status: 400 });
  }

  const url = new URL(req.url);
  const onlyPersonId = url.searchParams.get("person_id"); // target a specific member (testing)
  const limit = Number(url.searchParams.get("limit")) || DEFAULT_BATCH;
  // Default to the REAL cohort. Without this the scheduled run would also process
  // the 20 seeded personas, whose @example.com addresses get redirected by
  // MAIL_REDIRECT_TO — i.e. the cron would quietly bury the operator's own inbox in
  // intros for people who don't exist. Pass ?synthetic=true to exercise the sandbox.
  const synthetic = url.searchParams.get("synthetic") === "true";

  const results: RunResult[] = [];
  let processed = 0;

  try {
    const { data: peopleData, error } = onlyPersonId
      ? await db.from("people").select("*").eq("id", onlyPersonId)
      : await db
          .from("people")
          .select("*")
          .eq("paused", false)
          .eq("is_synthetic", synthetic)
          // Demo personas (0018) are matchable but never SUBJECTS of matching: Dawn
          // does not open introductions on behalf of a fictional person. They share
          // the real cohort with actual members, so without this the pool
          // self-matches — persona↔persona intros whose every email lands in the
          // operator's own inbox, burying the replies that are the point of the test.
          .eq("is_demo_persona", false)
          .limit(SCAN_LIMIT);
    if (error) throw new Error(error.message);
    const people = (peopleData ?? []) as Person[];

    for (const person of people) {
      if (processed >= limit) break;

      if (!person.email) {
        results.push({ person: person.name, skipped: "no email" });
        continue;
      }
      if (!person.embedding_offering || !person.embedding_looking_for) {
        results.push({ person: person.name, skipped: "no embeddings" });
        continue;
      }

      // Frequency governance: at most one intro per member per cadence window.
      // (The match-frequency Edge Function exposes the same idea via the
      // person_intro_stats SQL function; here we count directly for a cast-safe
      // query.) Skipped when targeting a specific person for testing.
      const days = CADENCE_DAYS[person.intro_cadence] ?? 7;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { count: introsRecent } = await db
        .from("intros")
        .select("*", { count: "exact", head: true })
        .eq("requester_ref", person.id)
        .gte("created_at", since);
      if (!onlyPersonId && (introsRecent ?? 0) > 0) {
        results.push({ person: person.name, skipped: `over cadence (${introsRecent} in ${days}d)` });
        continue;
      }

      const { candidates } = await fetchCandidates(db, person);
      if (candidates.length === 0) {
        results.push({ person: person.name, skipped: "no candidates" });
        continue;
      }

      // Three independent sources of learned signal, all keyed on this person:
      // past accept/reject outcomes, durable preferences, and what they last said.
      const [calibration, preferences, history] = await Promise.all([
        fetchCalibration(db, person.id),
        fetchPreferences(db, person.id),
        fetchRecentHistory(db, person.id),
      ]);
      const ranked = await rerank(person, candidates, calibration, preferences, history);
      const { valid } = validateMatches(ranked, candidates);
      if (valid.length === 0) {
        results.push({ person: person.name, skipped: "no valid matches" });
        continue;
      }

      // Pick the best candidate we haven't already opened an introduction with.
      let chosen: (typeof valid)[number] | null = null;
      for (const m of valid) {
        const { count } = await db
          .from("introductions")
          .select("*", { count: "exact", head: true })
          .or(
            `and(person_a_id.eq.${person.id},person_b_id.eq.${m.candidate_id}),` +
              `and(person_a_id.eq.${m.candidate_id},person_b_id.eq.${person.id})`,
          );
        if ((count ?? 0) === 0) {
          chosen = m;
          break;
        }
      }
      if (!chosen) {
        results.push({ person: person.name, skipped: "top matches already introduced" });
        continue;
      }

      // Persist the chosen match (get its id for the introduction).
      const { data: matchRow } = await db
        .from("matches")
        .upsert(
          {
            person_a_id: person.id,
            person_b_id: chosen.candidate_id,
            score: chosen.score,
            direction: chosen.direction,
            rationale: chosen.rationale,
          },
          { onConflict: "person_low,person_high" },
        )
        .select()
        .single();

      const { data: suggested } = await db
        .from("people")
        .select("*")
        .eq("id", chosen.candidate_id)
        .single();

      const intro = await startIntroduction(db, {
        helped: person,
        suggested: suggested as Person,
        matchId: matchRow?.id ?? null,
        direction: chosen.direction,
        rationale: chosen.rationale,
      });

      results.push({
        person: person.name,
        suggested: (suggested as Person | null)?.name ?? null,
        score: chosen.score,
        ...intro,
      });
      processed++;
    }

    return NextResponse.json({ ok: true, processed, considered: people.length, results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "run-matches failed", processed, results },
      { status: 500 },
    );
  }
}

// pg_cron uses POST (net.http_post); GET is allowed for easy curl testing.
export const POST = run;
export const GET = run;
