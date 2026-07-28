import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { requireAdmin } from "../../../lib/admin-auth";
import type { MatchDirection, Person } from "../../../../src/lib/types";
import { startIntroduction } from "../../../../src/lib/intro-flow";

export const runtime = "nodejs";
export const maxDuration = 120;

// Introductions in these states are done — a new one may be started for the pair.
const TERMINAL_STATES = ["declined", "expired", "scheduled", "completed"];

// GET ?person_id=<uuid> — list a person's introductions (with the other party's
// name/headline) so the admin Network tab can show status without the terminal.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const personId = new URL(req.url).searchParams.get("person_id");
  if (!personId) return NextResponse.json({ error: "person_id is required" }, { status: 400 });

  try {
    const { data: rows, error } = await db
      .from("introductions")
      .select("id, person_a_id, person_b_id, state, created_at, updated_at")
      .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const list = rows ?? [];
    const otherIds = list.map((r) => (r.person_a_id === personId ? r.person_b_id : r.person_a_id));
    const byId = new Map<string, { id: string; name: string; headline: string | null }>();
    if (otherIds.length) {
      const { data: others } = await db.from("people").select("id, name, headline").in("id", otherIds);
      for (const o of others ?? []) byId.set(o.id, o);
    }

    const introductions = list.map((r) => ({
      id: r.id,
      other: byId.get(r.person_a_id === personId ? r.person_b_id : r.person_a_id) ?? null,
      state: r.state as string,
      created_at: r.created_at as string,
    }));

    return NextResponse.json({ introductions });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load introductions" },
      { status: 500 },
    );
  }
}

interface TriggerBody {
  person_id?: string;
  candidate_id?: string;
  rationale?: string;
  direction?: string;
  score?: number;
}

// POST — start the real intro flow (opt-in email + state machine) for a specific
// (person, candidate) pair chosen in the admin UI. Reuses startIntroduction.
//
// This handler SENDS REAL EMAIL to real members and bypasses the cadence cap in
// /api/cron/run-matches, so it is gated on the same admin allowlist as the
// monitor routes. It was previously unauthenticated.
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const { person_id, candidate_id, rationale, direction, score } =
      (await req.json()) as TriggerBody;

    if (!person_id || !candidate_id) {
      return NextResponse.json({ error: "person_id and candidate_id are required" }, { status: 400 });
    }
    if (person_id === candidate_id) {
      return NextResponse.json({ error: "Can't introduce a person to themselves." }, { status: 400 });
    }

    // Guard against duplicate active introductions for the pair.
    const { data: existing } = await db
      .from("introductions")
      .select("id, state")
      .or(
        `and(person_a_id.eq.${person_id},person_b_id.eq.${candidate_id}),` +
          `and(person_a_id.eq.${candidate_id},person_b_id.eq.${person_id})`,
      )
      .order("created_at", { ascending: false });
    const active = (existing ?? []).find((i) => !TERMINAL_STATES.includes(i.state));
    if (active) {
      return NextResponse.json({
        ok: true,
        alreadyActive: true,
        introductionId: active.id,
        state: active.state,
        note: `An introduction is already in progress (state: ${active.state}).`,
      });
    }

    const { data: peopleRows, error: pErr } = await db
      .from("people")
      .select("*")
      .in("id", [person_id, candidate_id]);
    if (pErr) throw new Error(pErr.message);
    const byId = new Map((peopleRows ?? []).map((p) => [p.id, p as Person]));
    const helped = byId.get(person_id);
    const suggested = byId.get(candidate_id);
    if (!helped || !suggested) {
      return NextResponse.json({ error: "Person or candidate not found." }, { status: 404 });
    }
    if (!helped.email) {
      return NextResponse.json(
        { error: `${helped.name} has no email on file — can't send an intro.` },
        { status: 400 },
      );
    }

    const dir = (direction as MatchDirection) ?? "mutual";
    const why =
      typeof rationale === "string" && rationale.trim()
        ? rationale
        : `Dawn thinks ${helped.name} and ${suggested.name} should meet.`;

    // Ensure a match row exists (for match_id + so it shows in the graph).
    const { data: matchRow } = await db
      .from("matches")
      .upsert(
        {
          person_a_id: person_id,
          person_b_id: candidate_id,
          score: typeof score === "number" ? score : null,
          direction: dir,
          rationale: why,
        },
        { onConflict: "person_low,person_high" },
      )
      .select()
      .single();

    const result = await startIntroduction(db, {
      helped,
      suggested,
      matchId: matchRow?.id ?? null,
      direction: dir,
      rationale: why,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to trigger introduction" },
      { status: 500 },
    );
  }
}
