import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isInboundAuthorized } from "../../../lib/authz";
import { triage, type InboundDecision, type TriageResult } from "../../../../src/lib/triage";
import {
  advanceOnReply,
  pausePerson,
  recordPreferences,
  type ReplyIntent,
} from "../../../../src/lib/intro-flow";
import { send as sendViaGateway, suppress, type ReplyKind } from "../../../../src/lib/send-gateway";

export const runtime = "nodejs";
export const maxDuration = 120;

// Receives an inbound AgentMail message (delivered by the AgentMail webhook, which
// is configured with a custom `Authorization: Bearer <INBOUND_WEBHOOK_SECRET>`
// header), decides what — if anything — Dawn should do with it, and records the
// decision.
//
// Authenticity today rests on that shared header, which AgentMail stores write-only
// server-side. If this app is ever exposed beyond the pilot, upgrade to verifying
// AgentMail's svix-style signature (HMAC-SHA256 over `${svix-id}.${svix-timestamp}.
// ${rawBody}` with the webhook secret, plus a timestamp freshness window) instead of
// a static header.
//
// All the judgement lives in src/lib/triage.ts; this route is the dispatcher. The
// important invariant: EVERY inbound message produces exactly one `inbound_events`
// row, including the ones we refuse. That row is simultaneously the replay guard,
// the rate-limit counter, and the audit trail — a message we silently dropped is
// indistinguishable from one that never arrived, which is how the old route's
// failures stayed invisible.
//
// The webhook delivers snake_case JSON, so we accept both snake_case and the SDK's
// camelCase field names defensively.

interface InboundMessage {
  inbox_id?: string;
  inboxId?: string;
  message_id?: string;
  messageId?: string;
  thread_id?: string;
  threadId?: string;
  from_?: string;
  from?: string;
  subject?: string;
  text?: string;
  extractedText?: string;
  extracted_text?: string;
  in_reply_to?: string;
}

interface InboundBody {
  event_type?: string;
  type?: string;
  message?: InboundMessage;
}

/** AgentMail's event for mail whose sending domain published no passing SPF/DKIM. */
const UNAUTH_EVENT = "message.received.unauthenticated";

function firstDefined(...vals: (string | undefined)[]): string | null {
  for (const v of vals) if (v) return v;
  return null;
}

/** Outbound replies to non-members and out-of-scope asks are off unless enabled. */
function autoReplyEnabled(): boolean {
  return process.env.INBOUND_AUTOREPLY === "true";
}

const WAITLIST_REPLY = {
  subject: "Thanks for reaching out — Dawn is members-only for now",
  body:
    `Thanks for writing in.\n\n` +
    `I'm Dawn, an agent that makes introductions inside a private network — I only ` +
    `work with people who've joined, so I can't take requests over email just yet.\n\n` +
    `I've added you to the waitlist and someone will be in touch when there's room.\n\n— Dawn`,
};

const OUT_OF_SCOPE_REPLY = {
  subject: "I can't help with that one",
  body:
    `Thanks for the note.\n\n` +
    `I only do one thing: propose introductions to people in your network and ` +
    `coordinate a time once you both say yes. I can't take open-ended requests or ` +
    `answer general questions.\n\n` +
    `If you'd like to change what kinds of introductions I send you, just tell me ` +
    `and I'll remember it. If you'd like me to stop, reply "unsubscribe".\n\n— Dawn`,
};

type ReplyOutcome = "sent" | "disabled" | "drafted" | "no_recipient" | "send_failed";

/**
 * Send one templated reply, threaded onto the inbound message when possible.
 *
 * Goes through the send gateway with `consentBasis: "inbound_reply"` — this person
 * wrote to Dawn, which is what authorises answering them. There is no introduction, and
 * requiring one would mean the only way to answer a stranger is to route around the
 * gateway, which is the second send path all of this exists to prevent.
 *
 * Returns WHY nothing went out rather than a bare boolean. Collapsing "the flag is off"
 * and "delivery failed" into one false is how a broken send masquerades as a deliberate
 * silence — and for the waitlist path that distinction decides whether the lead still
 * deserves an invite later. `drafted` is the newest member of that family: the delivery
 * switch is closed, the reply is composed and stored, and nothing was transmitted.
 */
async function sendTemplatedReply(
  to: string | null,
  inboundMessageId: string | null,
  kind: ReplyKind,
  template: { subject: string; body: string },
): Promise<ReplyOutcome> {
  if (!autoReplyEnabled()) return "disabled";
  const res = await sendViaGateway(db, {
    consentBasis: "inbound_reply",
    kind,
    replyToMessageId: inboundMessageId,
    to: [to],
    subject: template.subject,
    text: template.body,
  });
  if (res.delivered) return "sent";
  if (res.status === "draft") return "drafted";
  return res.failure === "no_recipient" ? "no_recipient" : "send_failed";
}

/** Persist the inbound message against its conversation, returning the row id. */
async function storeInboundMessage(
  t: TriageResult,
  messageId: string | null,
  subject: string | null,
  text: string,
  intent: ReplyIntent | null,
): Promise<string | null> {
  if (!t.conversationId) return null;

  // Scoped to inbound rows on purpose. The old lookup matched any message with this
  // AgentMail id, so a payload echoing one of Dawn's OWN outbound ids would
  // overwrite that outbound row's `parsed` instead of recording a reply.
  if (messageId) {
    const { data: existing } = await db
      .from("messages")
      .select("id")
      .eq("agentmail_message_id", messageId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (existing) {
      await db.from("messages").update({ parsed: intent ?? {} }).eq("id", existing.id);
      return existing.id as string;
    }
  }

  const { data, error } = await db
    .from("messages")
    .insert({
      conversation_id: t.conversationId,
      agentmail_message_id: messageId,
      direction: "inbound",
      from_email: t.fromEmail,
      to_emails: [],
      subject,
      body: text,
      parsed: intent ?? {},
    })
    .select("id")
    .single();
  if (error) console.error("[inbound] messages insert failed:", error.message);
  return (data?.id as string) ?? null;
}

/** Record a non-member as a lead; invite at most once, ever. */
async function captureLead(t: TriageResult, text: string, inboundMessageId: string | null) {
  if (!t.fromEmail) return { invited: false, note: "no sender address" };

  const { data: existing } = await db
    .from("leads")
    .select("id, invited_at")
    .ilike("email", t.fromEmail)
    .maybeSingle();

  if (existing) {
    if (existing.invited_at) {
      return { invited: false, note: "lead already invited; staying silent" };
    }
    // No invite has landed yet, so this sender is still owed exactly one. Only stamp
    // `invited_at` on an actual send — stamping on a failure would silence them
    // forever without ever having told them anything.
    const outcome = await sendTemplatedReply(t.fromEmail, inboundMessageId, "waitlist_reply", WAITLIST_REPLY);
    if (outcome === "sent") {
      await db
        .from("leads")
        .update({
          invited_at: new Date().toISOString(),
          status: "invited",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    }
    return { invited: outcome === "sent", note: `existing lead: ${outcome}` };
  }

  const outcome = await sendTemplatedReply(t.fromEmail, inboundMessageId, "waitlist_reply", WAITLIST_REPLY);
  const invited = outcome === "sent";
  const { error } = await db.from("leads").insert({
    email: t.fromEmail,
    name: t.fromName,
    raw_ask: text,
    source: "inbound_email",
    status: invited ? "invited" : "new",
    invited_at: invited ? new Date().toISOString() : null,
  });
  if (error) console.error("[inbound] leads insert failed:", error.message);
  return { invited, note: `new lead: ${outcome}` };
}

export async function POST(req: Request) {
  if (!isInboundAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as InboundBody;
    const eventType = body.event_type ?? body.type;
    // Only the received variants dispatch. Both are accepted — AgentMail routes mail
    // from domains without passing SPF/DKIM to `message.received.unauthenticated`,
    // and refusing those here would drop real replies from any member whose domain
    // isn't set up (see triage's `authenticated` handling for how that mail is then
    // constrained).
    if (eventType && eventType !== "message.received" && eventType !== UNAUTH_EVENT) {
      return NextResponse.json({ ok: true, ignored: eventType });
    }

    // Authenticity is inferred from the event name AgentMail chose — a body field
    // would be forgeable by anyone holding the webhook secret. Undefined stays
    // undefined — triage treats "unknown" as authenticated, so the CLI scripts and
    // older payloads keep working.
    const authenticated = eventType === UNAUTH_EVENT ? false : undefined;

    const msg = body.message;
    if (!msg) return NextResponse.json({ error: "No message in payload" }, { status: 400 });

    const messageId = firstDefined(msg.message_id, msg.messageId);
    const threadId = firstDefined(msg.thread_id, msg.threadId);
    const fromRaw = firstDefined(msg.from_, msg.from);
    const subject = msg.subject ?? null;
    // Bounded for storage sanity — a pathological payload should not become a
    // multi-megabyte messages/inbound_events row. The LLM prompt is clipped much
    // tighter inside parseReplyIntent (8k chars); this cap only guards the writes.
    const text = (firstDefined(msg.extractedText, msg.extracted_text, msg.text) ?? "").slice(0, 100_000);

    const t = await triage(db, {
      agentmailMessageId: messageId,
      threadId,
      fromRaw,
      subject,
      text,
      authenticated,
    });

    // Log BEFORE dispatching. If dispatch throws, the audit row still exists and
    // replay protection still holds — otherwise a message that failed halfway
    // through (after its DB writes committed) would be reprocessed on the webhook's
    // retry, repeating those side effects. `replied` is patched in afterwards.
    //
    // The insert is also the authoritative replay guard. Triage's SELECT-based
    // duplicate check is only the cheap fast path (it saves the LLM call): two
    // simultaneous deliveries of one message both pass that SELECT, and only the
    // unique index on agentmail_message_id decides who dispatches.
    const logged = await logEvent(t, messageId, threadId, subject, text);
    if (logged.outcome === "conflict") {
      // A concurrent (or earlier) delivery already claimed this message id.
      // Dispatching anyway would double-advance the state machine.
      return NextResponse.json({ ok: true, decision: "duplicate", note: "replay guard: event row already exists" });
    }
    if (logged.outcome === "error") {
      // Without the row there is no replay guard, no rate-limit counter, and no
      // audit trail — dispatching in that state is how failures stay invisible.
      // 500 so the webhook retries once the insert can succeed.
      return NextResponse.json({ error: "failed to record inbound event" }, { status: 500 });
    }
    const eventId = logged.id;

    let replied = false;
    let action: string = t.decision;
    let detail: unknown = null;

    switch (t.decision) {
      case "duplicate":
      case "self_send":
      case "rate_limited":
        // Nothing to do beyond leaving the audit row. Deliberately silent: replying
        // to a rate-limited or looping sender is how you build an email loop.
        break;

      case "unverified_sender":
        // Silent on purpose. This is an unauthenticated message claiming to be a
        // member, with no Dawn thread behind it — i.e. either a spoof attempt or a
        // member writing in cold from a domain we can't verify. Replying would
        // confirm to a spoofer that the address they guessed is a real member, and
        // the audit row is enough to spot the honest case in /admin/monitor and
        // reach out by hand.
        break;

      case "non_member": {
        const lead = await captureLead(t, text, messageId);
        replied = lead.invited;
        detail = lead.note;
        break;
      }

      case "pause": {
        const rowId = await storeInboundMessage(t, messageId, subject, text, t.intent);
        if (t.personId) {
          // A member gets the reversible stop, which is what the reply below promises:
          // `people.paused` takes them out of matching in both directions, and any
          // later message from them picks things back up.
          await pausePerson(db, t.personId);
        } else if (t.fromEmail) {
          // Nobody to pause. Without this the request is honoured by writing an audit
          // row and nothing else — every Dawn email promises `Reply "unsubscribe" and
          // I'll stop`, and for a non-member that promise had no mechanism behind it.
          // They can arrive here legitimately: a sourced lead, someone replying from a
          // second address, a person whose member row was removed.
          //
          // Address-level and harder to undo than a pause, which is the correct
          // asymmetry when there is no account to re-enable — the suppression table is
          // the only thing that will still be checked when they surface again under
          // some other row.
          await suppress(db, t.fromEmail, "unsubscribe", `inbound message ${messageId ?? "(no id)"}`);
        }
        // A pause request often carries the reason with it ("on parental leave until
        // September", "not raising this year"). Those are durable preferences and
        // must survive the pause, or the reason for stopping is lost the moment we
        // act on it — and there'd be nothing to inform when or how to resume.
        const written = t.personId
          ? await recordPreferences(db, {
              personId: t.personId,
              signals: t.intent?.preference_signals ?? [],
              evidenceMessageId: rowId,
            })
          : 0;
        const pauseReply = await sendTemplatedReply(t.fromEmail, messageId, "out_of_scope_reply", {
          subject: "You're paused",
          body: `Done — I won't send you any more introductions. Reply any time and I'll pick back up.\n\n— Dawn`,
        });
        replied = pauseReply === "sent";
        detail = { paused: true, preferences_written: written };
        break;
      }

      case "preference_update": {
        const rowId = await storeInboundMessage(t, messageId, subject, text, t.intent);
        const written = t.personId
          ? await recordPreferences(db, {
              personId: t.personId,
              signals: t.intent?.preference_signals ?? [],
              evidenceMessageId: rowId,
            })
          : 0;
        detail = { preferences_written: written };
        break;
      }

      case "reply_to_intro": {
        const rowId = await storeInboundMessage(t, messageId, subject, text, t.intent);
        if (!t.introductionId || !t.personId || !t.intent) {
          action = "noop";
          detail = "missing introduction, member or intent";
          break;
        }
        detail = await advanceOnReply(db, {
          introductionId: t.introductionId,
          conversationId: t.conversationId!,
          replierId: t.personId,
          intent: t.intent,
          replyToMessageId: messageId,
          replyMessageRowId: rowId,
        });
        break;
      }

      case "out_of_scope": {
        await storeInboundMessage(t, messageId, subject, text, t.intent);
        const scopeReply = await sendTemplatedReply(t.fromEmail, messageId, "out_of_scope_reply", OUT_OF_SCOPE_REPLY);
        replied = scopeReply === "sent";
        detail = { reply: scopeReply };
        break;
      }
    }

    if (replied && eventId) {
      await db.from("inbound_events").update({ replied: true }).eq("id", eventId);
    }

    return NextResponse.json({
      ok: true,
      decision: t.decision,
      note: t.note,
      action,
      replied,
      intent: t.intent,
      detail,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "inbound processing failed" },
      { status: 500 },
    );
  }
}

type LogEventResult =
  | { outcome: "ok"; id: string | null }
  | { outcome: "conflict" } // unique index says another delivery already owns this message id
  | { outcome: "error" };

async function logEvent(
  t: TriageResult,
  messageId: string | null,
  threadId: string | null,
  subject: string | null,
  text: string,
): Promise<LogEventResult> {
  const decision: InboundDecision = t.decision;
  const { data, error } = await db
    .from("inbound_events")
    .insert({
      agentmail_message_id: messageId,
      thread_id: threadId,
      from_email: t.fromEmail ?? "unknown",
      subject,
      body: text,
      person_id: t.personId,
      conversation_id: t.conversationId,
      decision,
      classification: t.intent ?? {},
      replied: false,
    })
    .select("id")
    .single();
  if (!error) return { outcome: "ok", id: (data?.id as string) ?? null };
  // 23505 on inbound_events_message_idx: the concurrent-replay case the SELECT
  // fast path can't catch. The caller must not dispatch.
  if (error.code === "23505") return { outcome: "conflict" };
  // A failure here breaks replay protection and the rate limiter, so it must be loud
  // — and it must stop the dispatch, not just log.
  console.error(`[inbound] FAILED to log inbound_event: ${error.message}`);
  return { outcome: "error" };
}
