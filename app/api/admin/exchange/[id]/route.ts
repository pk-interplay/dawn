import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { requireAdmin } from "../../../../lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How far apart an `inbound_events` row and its `messages` row may be created
// and still be considered the same arrival. They are written in the same request
// (see app/api/agent/inbound/route.ts), so this is generous by an order of
// magnitude; it exists only so a slow LLM classification can't break the pairing.
const PAIRING_WINDOW_MS = 5 * 60_000;

type EventRow = {
  id: string;
  agentmail_message_id: string | null;
  conversation_id: string | null;
  person_id: string | null;
  from_email: string;
  decision: string;
  classification: Record<string, unknown>;
  replied: boolean;
  created_at: string;
};

/**
 * Pair each inbound message with the triage event it produced.
 *
 * `agentmail_message_id` is the real key and is used whenever both sides have
 * one, but it is null for synthetic and replayed payloads (`simulate-reply`,
 * `replay-inbound`) — which is most of what a demo run contains. So unmatched
 * messages fall back to the nearest unconsumed event on the same conversation.
 * Consuming greedily in time order keeps two replies on one thread from both
 * resolving to the first event.
 */
function pairEvents(
  messages: Array<{ id: string; conversation_id: string; direction: string; created_at: string }>,
  events: EventRow[],
): Map<string, EventRow> {
  const paired = new Map<string, EventRow>();
  const consumed = new Set<string>();

  const byMessageId = new Map<string, EventRow>();
  for (const e of events) {
    if (e.agentmail_message_id) byMessageId.set(e.agentmail_message_id, e);
  }

  const inbound = messages.filter((m) => m.direction === "inbound");

  for (const m of inbound) {
    const withId = m as typeof m & { agentmail_message_id: string | null };
    const exact = withId.agentmail_message_id
      ? byMessageId.get(withId.agentmail_message_id)
      : undefined;
    if (exact && !consumed.has(exact.id)) {
      paired.set(m.id, exact);
      consumed.add(exact.id);
    }
  }

  for (const m of inbound) {
    if (paired.has(m.id)) continue;
    const target = new Date(m.created_at).getTime();
    let best: { event: EventRow; distance: number } | null = null;
    for (const e of events) {
      if (consumed.has(e.id)) continue;
      if (e.conversation_id !== m.conversation_id) continue;
      const distance = Math.abs(new Date(e.created_at).getTime() - target);
      if (distance > PAIRING_WINDOW_MS) continue;
      if (!best || distance < best.distance) best = { event: e, distance };
    }
    if (best) {
      paired.set(m.id, best.event);
      consumed.add(best.event.id);
    }
  }

  return paired;
}

// GET /api/admin/exchange/<introduction_id> — one introduction's complete email
// trail, ordered as it happened.
//
// Two things make this more than a message dump, and both are the point of the
// demo. Every inbound message carries the intent Dawn extracted from it, so a
// reply can be shown next to the machine-readable read of that reply. And the
// speaker is resolved through `inbound_events.person_id` rather than the sender
// address, because during the pilot the operator answers as every persona from
// one mailbox — the address on the envelope is often not the person talking.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  try {
    const { data: intro, error: introError } = await db
      .from("introductions")
      .select(
        "id, match_id, person_a_id, person_b_id, state, a_response, b_response, rationale, channel, created_at, updated_at",
      )
      .eq("id", id)
      .maybeSingle();
    if (introError) throw new Error(introError.message);
    if (!intro) return NextResponse.json({ error: "Introduction not found" }, { status: 404 });

    const { data: convos, error: convoError } = await db
      .from("conversations")
      .select("id, purpose, state, subject, thread_id, created_at")
      .eq("introduction_id", id)
      .order("created_at", { ascending: true });
    if (convoError) throw new Error(convoError.message);
    const conversations = convos ?? [];
    const convoIds = conversations.map((c) => String(c.id));

    const [msgRes, eventRes, matchRes] = await Promise.all([
      convoIds.length
        ? db
            .from("messages")
            .select(
              "id, conversation_id, agentmail_message_id, direction, from_email, to_emails, subject, body, parsed, created_at",
            )
            .in("conversation_id", convoIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      convoIds.length
        ? db
            .from("inbound_events")
            .select(
              "id, agentmail_message_id, conversation_id, person_id, from_email, decision, classification, replied, created_at",
            )
            .in("conversation_id", convoIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      intro.match_id
        ? db.from("matches").select("id, score, direction, status").eq("id", intro.match_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    for (const result of [msgRes, eventRes, matchRes]) {
      if (result.error) throw new Error(result.error.message);
    }

    const messages = msgRes.data ?? [];
    const events = (eventRes.data ?? []) as EventRow[];

    // Anyone who might be named in this trail: the two parties, plus whoever a
    // triage event attributed a reply to (normally one of the two, but a
    // forwarded reply can resolve to a third member).
    const personIds = [
      ...new Set([
        intro.person_a_id,
        intro.person_b_id,
        ...events.map((e) => e.person_id).filter(Boolean),
      ]),
    ] as string[];
    const { data: people, error: peopleError } = await db
      .from("people")
      .select("id, name, headline, email, paused, is_demo_persona")
      .in("id", personIds);
    if (peopleError) throw new Error(peopleError.message);

    const peopleById = new Map((people ?? []).map((p) => [String(p.id), p]));
    const personA = peopleById.get(String(intro.person_a_id)) ?? null;
    const personB = peopleById.get(String(intro.person_b_id)) ?? null;
    const convoById = new Map(conversations.map((c) => [String(c.id), c]));

    const roleFor = (personId: string | null): "a" | "b" | "other" => {
      if (personId && personId === intro.person_a_id) return "a";
      if (personId && personId === intro.person_b_id) return "b";
      return "other";
    };

    const paired = pairEvents(
      messages.map((m) => ({
        id: String(m.id),
        conversation_id: String(m.conversation_id),
        direction: String(m.direction),
        created_at: String(m.created_at),
        agentmail_message_id: m.agentmail_message_id,
      })),
      events,
    );

    // Address → person, so an outbound recipient can be named. Built from the two
    // parties only; Dawn's own inbox stays unnamed and reads as "Dawn".
    const personByEmail = new Map(
      [personA, personB]
        .filter(Boolean)
        .filter((p) => p!.email)
        .map((p) => [String(p!.email).toLowerCase(), p!]),
    );

    const steps = messages.map((m) => {
      const event = paired.get(String(m.id)) ?? null;
      const convo = convoById.get(String(m.conversation_id));

      let speaker;
      if (m.direction === "outbound") {
        speaker = { role: "dawn" as const, name: "Dawn", email: m.from_email, viaOperator: false };
      } else {
        const attributed = event?.person_id ? peopleById.get(String(event.person_id)) : undefined;
        const byAddress = m.from_email
          ? personByEmail.get(String(m.from_email).toLowerCase())
          : undefined;
        const person = attributed ?? byAddress ?? null;
        speaker = {
          role: person ? roleFor(String(person.id)) : ("unknown" as const),
          name: person?.name ?? m.from_email ?? "Unknown sender",
          email: m.from_email,
          // The reply came from an address that isn't this person's own — the
          // operator answering as a persona. Worth showing rather than hiding.
          viaOperator: Boolean(
            person?.email &&
              m.from_email &&
              String(person.email).toLowerCase() !== String(m.from_email).toLowerCase(),
          ),
        };
      }

      const recipients = (m.to_emails ?? []).map((email: string) => {
        const person = personByEmail.get(String(email).toLowerCase());
        return { email, name: person?.name ?? null, role: person ? roleFor(String(person.id)) : "other" };
      });

      return {
        id: String(m.id),
        conversationId: String(m.conversation_id),
        purpose: convo?.purpose ?? "opt_in",
        direction: m.direction as "inbound" | "outbound",
        speaker,
        recipients,
        subject: m.subject,
        body: m.body,
        createdAt: m.created_at,
        // Only inbound messages carry an extracted intent; outbound `parsed` is
        // always {} and is dropped rather than rendered as an empty panel.
        intent:
          m.direction === "inbound" && m.parsed && Object.keys(m.parsed).length ? m.parsed : null,
        triage: event
          ? {
              decision: event.decision,
              replied: event.replied,
              classification: event.classification ?? {},
            }
          : null,
      };
    });

    return NextResponse.json({
      introduction: {
        id: intro.id,
        state: intro.state,
        a_response: intro.a_response,
        b_response: intro.b_response,
        rationale: intro.rationale,
        channel: intro.channel,
        created_at: intro.created_at,
        updated_at: intro.updated_at,
        person_a: personA ?? { id: intro.person_a_id, name: "Unknown" },
        person_b: personB ?? { id: intro.person_b_id, name: "Unknown" },
        match: matchRes.data ?? null,
      },
      conversations,
      steps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load exchange";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
