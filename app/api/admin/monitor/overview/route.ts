import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The double opt-in state machine is a single `state` column, so "how far did
// this intro get" has to be reconstructed from an ordering. declined/expired are
// terminal without a recorded high-water mark, so they're reported as outcomes
// alongside the funnel rather than inside it.
const STATE_RANK: Record<string, number> = {
  proposed: 0,
  a_invited: 1,
  b_invited: 1,
  a_opted_in: 2,
  b_opted_in: 2,
  both_opted_in: 3,
  // `introduced` is the funnel's real end: the warm intro has been sent and Dawn is
  // out. It shares rank 4 with the legacy `scheduling` step it replaced, so intros
  // opened either side of the handoff change still land in one comparable funnel
  // rather than splitting the chart in two.
  introduced: 4,
  scheduling: 4,
  scheduled: 5,
  completed: 6,
};

const FUNNEL_STAGES = [
  { label: "Proposed", rank: 0 },
  { label: "Invited", rank: 1 },
  { label: "One opted in", rank: 2 },
  { label: "Both opted in", rank: 3 },
  { label: "Introduced", rank: 4 },
  // Only ever non-zero for pre-handoff rows; kept so their history stays visible.
  { label: "Scheduled", rank: 5 },
  { label: "Completed", rank: 6 },
];

const ACTIVITY_DAYS = 30;

function tally<T extends string>(rows: Array<Record<string, unknown>>, column: string) {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[column] ?? "unknown") as T;
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function isoDay(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const since = new Date(Date.now() - ACTIVITY_DAYS * 86_400_000).toISOString();

    // Row counts here are in the tens, so pulling the columns and aggregating in
    // JS avoids adding RPCs for group-bys. Revisit if any table passes ~5k rows.
    // `inbound_events`, `messages`, and `conversations` used to be read here. The
    // email layer that wrote them is gone, so they would report frozen totals
    // forever — worse than absent, because a stale number reads as a live one.
    const [people, introductions, matches, relationships, interactions] = await Promise.all([
      db.from("people").select("id, paused, intro_cadence, email, industry, created_at"),
      db.from("introductions").select("id, state, a_response, b_response, created_at, updated_at"),
      db.from("matches").select("id, score, direction, status, created_at"),
      db.from("relationships").select("id, status, strength, last_interaction_at"),
      db.from("interactions").select("id, type, occurred_at").gte("occurred_at", since),
    ]);

    for (const result of [people, introductions, matches, relationships, interactions]) {
      if (result.error) throw new Error(result.error.message);
    }

    const peopleRows = people.data ?? [];
    const introRows = introductions.data ?? [];
    const matchRows = matches.data ?? [];
    const relationshipRows = relationships.data ?? [];
    const interactionRows = interactions.data ?? [];

    // Funnel: for each stage, how many introductions reached at least that far.
    const ranked = introRows
      .map((r) => STATE_RANK[String(r.state)])
      .filter((r): r is number => r !== undefined);
    const funnel = FUNNEL_STAGES.map((stage) => ({
      label: stage.label,
      count: ranked.filter((r) => r >= stage.rank).length,
    }));

    const declined = introRows.filter((r) => r.state === "declined").length;
    const expired = introRows.filter((r) => r.state === "expired").length;

    // Opt-in rate is measured per invitation actually answered, not per intro,
    // so pending invites don't drag it down.
    const responses = introRows.flatMap((r) => [r.a_response, r.b_response]);
    const answered = responses.filter((r) => r === "yes" || r === "no").length;
    const yeses = responses.filter((r) => r === "yes").length;

    // Daily activity series, zero-filled so the chart has no gaps.
    const byDay = new Map<string, Record<string, number>>();
    for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
      byDay.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), {});
    }
    for (const row of interactionRows) {
      const day = isoDay(String(row.occurred_at));
      const bucket = byDay.get(day);
      if (!bucket) continue;
      const type = String(row.type);
      bucket[type] = (bucket[type] ?? 0) + 1;
    }
    const activity = [...byDay.entries()].map(([date, counts]) => ({
      date,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    }));

    const scores = matchRows
      .map((m) => (m.score === null ? null : Number(m.score)))
      .filter((s): s is number => s !== null && !Number.isNaN(s));
    const strengths = relationshipRows.map((r) => Number(r.strength)).filter((s) => !Number.isNaN(s));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      windowDays: ACTIVITY_DAYS,
      people: {
        total: peopleRows.length,
        paused: peopleRows.filter((p) => p.paused).length,
        active: peopleRows.filter((p) => !p.paused).length,
        withEmail: peopleRows.filter((p) => p.email).length,
        byCadence: tally(peopleRows, "intro_cadence"),
        byIndustry: tally(peopleRows, "industry"),
      },
      introductions: {
        total: introRows.length,
        byState: tally(introRows, "state"),
        funnel,
        declined,
        expired,
        answered,
        yeses,
        optInRate: answered ? yeses / answered : null,
      },
      matches: {
        total: matchRows.length,
        avgScore: avg(scores),
        byDirection: tally(matchRows, "direction"),
        byStatus: tally(matchRows, "status"),
      },
      relationships: {
        total: relationshipRows.length,
        byStatus: tally(relationshipRows, "status"),
        avgStrength: avg(strengths),
      },
      activity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load overview";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
