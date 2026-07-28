import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";

// A member's real relationship graph: who they're connected to, how close
// (proximity `strength`), the relationship status, and when they last
// interacted. This is the "past connections" surface for /me — distinct from
// the raw counts in /stats.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const { data: rels, error } = await db
      .from("relationships")
      .select("*")
      .or(`person_a_id.eq.${id},person_b_id.eq.${id}`)
      .order("strength", { ascending: false });
    if (error) throw new Error(error.message);

    const rows = rels ?? [];
    const otherIds = rows.map((r) => (r.person_a_id === id ? r.person_b_id : r.person_a_id));

    const nameById = new Map<string, { id: string; name: string; headline: string | null }>();
    if (otherIds.length) {
      const { data: others, error: othersErr } = await db
        .from("people")
        .select("id, name, headline")
        .in("id", otherIds);
      if (othersErr) throw new Error(othersErr.message);
      for (const o of others ?? []) nameById.set(o.id, o);
    }

    const connections = rows.map((r) => {
      const otherId = r.person_a_id === id ? r.person_b_id : r.person_a_id;
      return {
        id: r.id,
        other: nameById.get(otherId) ?? null,
        status: r.status as string,
        strength: Number(r.strength),
        source: r.source as string,
        first_connected_at: r.first_connected_at as string,
        last_interaction_at: r.last_interaction_at as string,
      };
    });

    return NextResponse.json({ connections });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load connections" },
      { status: 500 },
    );
  }
}
