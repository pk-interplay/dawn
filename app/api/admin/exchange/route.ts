import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { requireAdmin } from "../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 60;

// GET ?limit=<n> — the picker for the exchange demo: every introduction that
// has an email trail, with just enough to choose one (who, state, how much was
// said, when it last moved). Bodies are deliberately left to /[id], so opening
// this page never loads every email in the pilot.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit")) || DEFAULT_LIMIT, 200);

  try {
    const { data: intros, error } = await db
      .from("introductions")
      .select("id, person_a_id, person_b_id, state, a_response, b_response, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const rows = intros ?? [];
    if (!rows.length) return NextResponse.json({ exchanges: [], count: 0 });

    const personIds = [...new Set(rows.flatMap((r) => [r.person_a_id, r.person_b_id]))];
    const introIds = rows.map((r) => r.id);

    const [peopleRes, convoRes] = await Promise.all([
      db.from("people").select("id, name, headline, email").in("id", personIds),
      db.from("conversations").select("id, introduction_id").in("introduction_id", introIds),
    ]);
    for (const result of [peopleRes, convoRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const introByConvo = new Map(
      (convoRes.data ?? []).map((c) => [String(c.id), String(c.introduction_id)]),
    );

    // One pass over the messages of every listed introduction. Counting inbound
    // separately is what lets the UI surface exchanges someone actually replied
    // to — a one-email intro plays back as a single frame and demos nothing.
    const tally = new Map<string, { messages: number; inbound: number; lastAt: string | null }>();
    const convoIds = [...introByConvo.keys()];
    if (convoIds.length) {
      const { data: msgs, error: msgError } = await db
        .from("messages")
        .select("conversation_id, direction, created_at")
        .in("conversation_id", convoIds);
      if (msgError) throw new Error(msgError.message);

      for (const m of msgs ?? []) {
        const introId = introByConvo.get(String(m.conversation_id));
        if (!introId) continue;
        const entry = tally.get(introId) ?? { messages: 0, inbound: 0, lastAt: null };
        entry.messages += 1;
        if (m.direction === "inbound") entry.inbound += 1;
        if (!entry.lastAt || m.created_at > entry.lastAt) entry.lastAt = m.created_at;
        tally.set(introId, entry);
      }
    }

    const peopleById = new Map((peopleRes.data ?? []).map((p) => [p.id, p]));
    const exchanges = rows.map((r) => {
      const counts = tally.get(r.id) ?? { messages: 0, inbound: 0, lastAt: null };
      return {
        id: r.id,
        state: r.state,
        a_response: r.a_response,
        b_response: r.b_response,
        created_at: r.created_at,
        updated_at: r.updated_at,
        person_a: peopleById.get(r.person_a_id) ?? { id: r.person_a_id, name: "Unknown" },
        person_b: peopleById.get(r.person_b_id) ?? { id: r.person_b_id, name: "Unknown" },
        messageCount: counts.messages,
        inboundCount: counts.inbound,
        lastMessageAt: counts.lastAt,
      };
    });

    return NextResponse.json({ exchanges, count: exchanges.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load exchanges";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
