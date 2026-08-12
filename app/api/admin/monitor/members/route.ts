import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — per-member rollup: how many intros Dawn has run for each person, how
// often they say yes, what the agent has learned about them, and when they were
// last touched. Used to spot members the network is ignoring or over-serving.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const [peopleRes, introRes, prefRes, relRes, interactionRes] = await Promise.all([
      db
        .from("people")
        .select("id, name, headline, email, industry, career_stage, location, paused, intro_cadence, created_at")
        .order("name"),
      db.from("introductions").select("id, person_a_id, person_b_id, state, a_response, b_response, updated_at"),
      db.from("person_preferences").select("id, person_id, kind, value, source, confidence, active"),
      db.from("relationships").select("id, person_a_id, person_b_id, status, strength"),
      db.from("interactions").select("person_id, type, occurred_at"),
    ]);

    for (const result of [peopleRes, introRes, prefRes, relRes, interactionRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const introRows = introRes.data ?? [];
    const prefRows = prefRes.data ?? [];
    const relRows = relRes.data ?? [];
    const interactionRows = interactionRes.data ?? [];

    const members = (peopleRes.data ?? []).map((p) => {
      const mine = introRows.filter((i) => i.person_a_id === p.id || i.person_b_id === p.id);

      // Each intro records the two sides separately; pick whichever slot this
      // person occupies to get their own answer.
      const myResponses = mine.map((i) => (i.person_a_id === p.id ? i.a_response : i.b_response));
      const answered = myResponses.filter((r) => r === "yes" || r === "no").length;
      const yeses = myResponses.filter((r) => r === "yes").length;

      const myInteractions = interactionRows.filter((i) => i.person_id === p.id);
      const lastTouch = myInteractions
        .map((i) => String(i.occurred_at))
        .sort()
        .at(-1);

      const myRels = relRows.filter((r) => r.person_a_id === p.id || r.person_b_id === p.id);

      return {
        ...p,
        intros: mine.length,
        introsPending: mine.filter((i) =>
          ["proposed", "a_invited", "b_invited", "a_opted_in", "b_opted_in"].includes(String(i.state)),
        ).length,
        introsCompleted: mine.filter((i) =>
          ["introduced", "scheduled", "completed"].includes(String(i.state)),
        ).length,
        answered,
        yeses,
        optInRate: answered ? yeses / answered : null,
        relationships: myRels.length,
        avgStrength: myRels.length
          ? myRels.reduce((sum, r) => sum + Number(r.strength), 0) / myRels.length
          : null,
        interactions: myInteractions.length,
        lastTouch: lastTouch ?? null,
        preferences: prefRows
          .filter((pref) => pref.person_id === p.id && pref.active)
          .map((pref) => ({
            kind: pref.kind,
            value: pref.value,
            source: pref.source,
            confidence: Number(pref.confidence),
          })),
      };
    });

    return NextResponse.json({ members, count: members.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load members";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
