import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import type { Person } from "../../../../src/lib/types";
import { readNetworkSettings } from "../../../../src/lib/network-settings";
import { runMatchmaker, type EligibleMember } from "../../../../src/lib/matchmaker-agent";

export const runtime = "nodejs";
// An agent loop over several members — many tool calls, each with a model round trip.
// Slower and more variable than the fixed pipeline this replaced, so the ceiling
// matters more than it used to. Vercel/host caps still apply, and MAX_STEPS in
// matchmaker-agent.ts is the other end of the same bound.
export const maxDuration = 300;

const DEFAULT_BATCH = 3; // introductions this run may open (keep runs light)
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

/**
 * How many opt-in asks this person has received inside their own cadence window.
 *
 * Counts intros in BOTH directions — ones opened on their behalf (`requester_ref`)
 * and ones where they were the person suggested (`introduced_to_id`). The gate used
 * to count only the first, which made the cadence cap one-sided: it governed how
 * often someone was the *subject* of matching, and said nothing about how often they
 * were suggested *to*. That was survivable while only person A was ever emailed, but
 * under double opt-in person B receives a real email — so a well-connected member
 * could be asked any number of times in a week while their own `intro_cadence` said
 * "monthly", and nothing in the system was counting.
 *
 * The window is the person's own cadence scaled by the network intensity dial, so
 * both sides of a pair are judged by their own tolerance rather than the initiator's.
 */
async function asksInWindow(
  personId: string,
  cadence: string,
  intensity: number,
): Promise<{ count: number; days: number }> {
  const days = (CADENCE_DAYS[cadence] ?? 7) / intensity;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { count } = await db
    .from("intros")
    .select("*", { count: "exact", head: true })
    .or(`requester_ref.eq.${personId},introduced_to_id.eq.${personId}`)
    .gte("created_at", since);
  return { count: count ?? 0, days };
}

async function run(req: Request) {
  const startedAt = Date.now();
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

  // Network-wide experiment controls (migration 0032). The master switch stops the
  // scheduled batch entirely; a targeted ?person_id= test run is the one deliberate
  // override, matching the cadence bypass below. `intensity` scales every member's
  // cadence window: dividing by it makes intros more frequent as it rises.
  const settings = await readNetworkSettings(db);
  if (!settings.enabled && !onlyPersonId) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      considered: 0,
      results: [],
      networkEnabled: false,
      intensity: settings.intensity,
      note: "Network is switched off; no introductions opened.",
    });
  }

  const results: RunResult[] = [];

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

    // ---- Build the eligible set ------------------------------------------
    //
    // Everything in this loop is a HARD invariant, and it stays here rather than being
    // exposed to the agent. The matchmaker decides who is worth introducing; it does
    // not decide who is allowed to be introduced, and it has no tool that could widen
    // this list. A model that can talk its way past a rate limit does not have a rate
    // limit.
    const eligible: EligibleMember[] = [];
    for (const person of people) {
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
      // The member's base window, scaled by the network intensity dial: a higher
      // intensity shortens the window (more frequent intros), a lower one lengthens
      // it. At intensity 1.0 this is exactly the member's own cadence.
      const { count: introsRecent, days } = await asksInWindow(
        person.id,
        person.intro_cadence,
        settings.intensity,
      );
      if (!onlyPersonId && introsRecent > 0) {
        results.push({
          person: person.name,
          skipped: `over cadence (${introsRecent} in ${days.toFixed(2)}d @ ${settings.intensity}×)`,
        });
        continue;
      }

      eligible.push({ person, cadence: person.intro_cadence });
    }

    // ---- The pair gate, as a closure the agent must pass through ----------
    //
    // Was inline in the old shortlist walk. It is a function now because the agent
    // proposes a pair rather than accepting a pre-picked winner, so the check has to
    // run at proposal time — and running it here rather than inside the agent module
    // keeps `?person_id=` and the intensity dial in one place.
    //
    // A candidate over their OWN cadence costs the member that candidate, not their
    // whole run: the agent gets a reason back and can pick someone else. That is the
    // same trade the old shortlist walk made, and it is why this is not a filter
    // applied to the candidate list before the model sees it — filtering there would
    // silently shrink the shortlist without saying why.
    const isEligiblePair = async (aId: string, bId: string) => {
      const { count } = await db
        .from("introductions")
        .select("*", { count: "exact", head: true })
        .or(`and(person_a_id.eq.${aId},person_b_id.eq.${bId}),and(person_a_id.eq.${bId},person_b_id.eq.${aId})`);
      if ((count ?? 0) > 0) {
        return { ok: false, reason: "These two have already been introduced." };
      }

      // The suggested person receives a real email under double opt-in, so they get the
      // same cadence protection as the member being helped. Bypassed by ?person_id= for
      // the same reason A's gate is: targeted test runs.
      if (!onlyPersonId) {
        const { data: candidateRow } = await db
          .from("people")
          .select("intro_cadence, paused, is_synthetic")
          .eq("id", bId)
          .maybeSingle();
        if (!candidateRow) return { ok: false, reason: "No such person." };
        if (candidateRow.paused) return { ok: false, reason: "That person has paused introductions." };
        if (candidateRow.is_synthetic !== synthetic) {
          return { ok: false, reason: "That person is in a different cohort." };
        }
        const theirs = await asksInWindow(bId, candidateRow.intro_cadence ?? "weekly", settings.intensity);
        if (theirs.count > 0) {
          return {
            ok: false,
            reason: `They are over their own cadence (${theirs.count} in ${theirs.days.toFixed(2)}d).`,
          };
        }
      }
      return { ok: true };
    };

    // ---- Hand the eligible set to the matchmaker --------------------------
    const runId = `run-${new Date().toISOString()}`;
    const outcome = await runMatchmaker({
      client: db,
      eligible,
      limit,
      runId,
      isEligiblePair,
      // maxDuration minus 30s of headroom (the onboarding route's pattern): the
      // agent loop aborts in time to report a partial outcome instead of being
      // platform-killed mid-step with nothing returned.
      deadline: startedAt + 270_000,
    });

    return NextResponse.json({
      ok: true,
      runId,
      processed: outcome.introductionsOpened,
      considered: people.length,
      eligible: eligible.length,
      networkEnabled: settings.enabled,
      intensity: settings.intensity,
      // What the agent did, and what it said about why. The summary is the part worth
      // reading when a run opens nothing — "nothing was worth opening" and "the run
      // fell over" look identical in a count.
      summary: outcome.summary,
      notesWritten: outcome.notesWritten,
      results: [...results, ...outcome.proposals],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "run-matches failed", results },
      { status: 500 },
    );
  }
}

// pg_cron uses POST (net.http_post); GET is allowed for easy curl testing.
export const POST = run;
export const GET = run;
