import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?conversation_id=<uuid> — full message thread with bodies, oldest first,
// plus the introduction it belongs to. Loaded on demand from the Intros / Inbox
// tables so the list views stay light.
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const conversationId = new URL(req.url).searchParams.get("conversation_id");
  if (!conversationId) {
    return NextResponse.json({ error: "conversation_id is required" }, { status: 400 });
  }

  try {
    const { data: conversation, error: convoError } = await db
      .from("conversations")
      .select("id, introduction_id, inbox_id, thread_id, subject, participants, purpose, state, created_at, updated_at")
      .eq("id", conversationId)
      .maybeSingle();
    if (convoError) throw new Error(convoError.message);
    if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const { data: messages, error: msgError } = await db
      .from("messages")
      .select("id, agentmail_message_id, direction, from_email, to_emails, subject, body, parsed, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (msgError) throw new Error(msgError.message);

    // The introduction gives the thread its context (who, what state, why).
    let introduction = null;
    if (conversation.introduction_id) {
      const { data: intro, error: introError } = await db
        .from("introductions")
        .select("id, person_a_id, person_b_id, state, a_response, b_response, rationale")
        .eq("id", conversation.introduction_id)
        .maybeSingle();
      if (introError) throw new Error(introError.message);

      if (intro) {
        const { data: people, error: peopleError } = await db
          .from("people")
          .select("id, name, headline, email")
          .in("id", [intro.person_a_id, intro.person_b_id]);
        if (peopleError) throw new Error(peopleError.message);
        const byId = new Map((people ?? []).map((p) => [p.id, p]));
        introduction = {
          ...intro,
          person_a: byId.get(intro.person_a_id) ?? null,
          person_b: byId.get(intro.person_b_id) ?? null,
        };
      }
    }

    return NextResponse.json({
      conversation,
      introduction,
      messages: messages ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load thread";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
