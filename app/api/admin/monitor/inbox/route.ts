import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const BODY_PREVIEW_CHARS = 400;

// GET ?decision=<decision>&limit=<n> — the agent's inbound triage log: every
// email that hit the AgentMail webhook, what the classifier decided, and whether
// Dawn replied. This is the main "is the agent behaving?" view.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const params = new URL(req.url).searchParams;
  const decision = params.get("decision");
  const limit = Math.min(Number(params.get("limit")) || DEFAULT_LIMIT, 500);

  try {
    let query = db
      .from("inbound_events")
      .select("id, agentmail_message_id, thread_id, from_email, subject, body, person_id, conversation_id, decision, classification, replied, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (decision) query = query.eq("decision", decision);

    const { data: events, error } = await query;
    if (error) throw new Error(error.message);
    const rows = events ?? [];

    const personIds = [...new Set(rows.map((r) => r.person_id).filter(Boolean))] as string[];
    const conversationIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))] as string[];

    const [peopleRes, convoRes] = await Promise.all([
      personIds.length
        ? db.from("people").select("id, name, headline, email").in("id", personIds)
        : Promise.resolve({ data: [], error: null }),
      conversationIds.length
        ? db
            .from("conversations")
            .select("id, subject, purpose, state, introduction_id")
            .in("id", conversationIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    for (const result of [peopleRes, convoRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const peopleById = new Map((peopleRes.data ?? []).map((p) => [p.id, p]));
    const convoById = new Map((convoRes.data ?? []).map((c) => [c.id, c]));

    const items = rows.map((r) => ({
      id: r.id,
      from_email: r.from_email,
      subject: r.subject,
      // Bodies can be long; the thread view loads the full text on demand.
      preview: (r.body ?? "").slice(0, BODY_PREVIEW_CHARS),
      truncated: (r.body ?? "").length > BODY_PREVIEW_CHARS,
      decision: r.decision,
      classification: r.classification,
      replied: r.replied,
      created_at: r.created_at,
      thread_id: r.thread_id,
      person: r.person_id ? (peopleById.get(r.person_id) ?? null) : null,
      conversation: r.conversation_id ? (convoById.get(r.conversation_id) ?? null) : null,
    }));

    return NextResponse.json({ events: items, count: items.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load inbound events";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
