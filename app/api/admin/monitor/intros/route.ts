import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;

// GET ?state=<state>&limit=<n> — every introduction with both parties resolved,
// the match that produced it, and the conversation thread it spawned.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const params = new URL(req.url).searchParams;
  const state = params.get("state");
  const limit = Math.min(Number(params.get("limit")) || DEFAULT_LIMIT, 500);

  try {
    let query = db
      .from("introductions")
      .select("id, match_id, person_a_id, person_b_id, state, a_response, b_response, rationale, channel, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (state) query = query.eq("state", state);

    const { data: intros, error } = await query;
    if (error) throw new Error(error.message);
    const rows = intros ?? [];

    // Resolve the three related tables in one round trip each rather than a
    // nested select — introductions has two FKs into people, which makes the
    // implicit-join syntax ambiguous.
    const personIds = [...new Set(rows.flatMap((r) => [r.person_a_id, r.person_b_id]))];
    const matchIds = [...new Set(rows.map((r) => r.match_id).filter(Boolean))] as string[];
    const introIds = rows.map((r) => r.id);

    const [peopleRes, matchRes, convoRes] = await Promise.all([
      personIds.length
        ? db.from("people").select("id, name, headline, email, paused").in("id", personIds)
        : Promise.resolve({ data: [], error: null }),
      matchIds.length
        ? db.from("matches").select("id, score, direction, status").in("id", matchIds)
        : Promise.resolve({ data: [], error: null }),
      introIds.length
        ? db
            .from("conversations")
            .select("id, introduction_id, purpose, state, subject, thread_id, updated_at")
            .in("introduction_id", introIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    for (const result of [peopleRes, matchRes, convoRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const peopleById = new Map((peopleRes.data ?? []).map((p) => [p.id, p]));
    const matchById = new Map((matchRes.data ?? []).map((m) => [m.id, m]));
    const convosByIntro = new Map<string, Array<Record<string, unknown>>>();
    for (const c of convoRes.data ?? []) {
      const key = String(c.introduction_id);
      convosByIntro.set(key, [...(convosByIntro.get(key) ?? []), c]);
    }

    // Message volume per conversation, so the table can show thread size without
    // loading every body.
    const convoIds = (convoRes.data ?? []).map((c) => c.id);
    const messageCounts = new Map<string, number>();
    if (convoIds.length) {
      const { data: msgs, error: msgError } = await db
        .from("messages")
        .select("id, conversation_id")
        .in("conversation_id", convoIds);
      if (msgError) throw new Error(msgError.message);
      for (const m of msgs ?? []) {
        const key = String(m.conversation_id);
        messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
      }
    }

    const introductions = rows.map((r) => {
      const convos = (convosByIntro.get(r.id) ?? []).map((c) => ({
        ...c,
        messageCount: messageCounts.get(String(c.id)) ?? 0,
      }));
      return {
        id: r.id,
        state: r.state,
        a_response: r.a_response,
        b_response: r.b_response,
        rationale: r.rationale,
        channel: r.channel,
        created_at: r.created_at,
        updated_at: r.updated_at,
        person_a: peopleById.get(r.person_a_id) ?? { id: r.person_a_id, name: "Unknown" },
        person_b: peopleById.get(r.person_b_id) ?? { id: r.person_b_id, name: "Unknown" },
        match: r.match_id ? (matchById.get(r.match_id) ?? null) : null,
        conversations: convos,
        messageCount: convos.reduce((sum, c) => sum + (c.messageCount as number), 0),
      };
    });

    return NextResponse.json({ introductions, count: introductions.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load introductions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
