import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { isAuthorized } from "../../../lib/authz";
import { triage, type InboundDecision, type TriageResult } from "../../../../src/lib/triage";
import {
  advanceOnReply,
  pausePerson,
  recordPreferences,
  type ReplyIntent,
} from "../../../../src/lib/intro-flow";
import { sendThreadedOrFresh } from "../../../../src/lib/agentmail";

export const runtime = "nodejs";
export const maxDuration = 120;

// Receives an inbound AgentMail message (forwarded by the agentmail-webhook Edge
// Function), decides what — if anything — Dawn should do with it, and records the
// decision.
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
  /** Set by the Edge Function from the event type; see UNAUTH_EVENT. */
  authenticated?: boolean;
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

type ReplyOutcome = "sent" | "disabled" | "no_recipient" | "send_failed";

/**
 * Send one templated reply, threaded onto the inbound message when possible.
 *
 * Returns WHY nothing went out rather than a bare boolean. Collapsing "the flag is
 * off" and "delivery failed" into one false is how a broken send masquerades as a
 * deliberate silence — and for the waitlist path that distinction decides whether
 * the lead still deserves an invite later.
 */
async function sendTemplatedReply(
  to: string | null,
  inboundMessageId: string | null,
  template: { subject: string; body: string },
): Promise<ReplyOutcome> {
  if (!autoReplyEnabled()) return "disabled";
  const res = await sendThreadedOrFresh({
    replyToMessageId: inboundMessageId,
    to: [to],
    subject: template.subject,
    text: template.body,
  });
  if (res.delivered) return "sent";
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
    const outcome = await sendTemplatedReply(t.fromEmail, inboundMessageId, WAITLIST_REPLY);
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

  const outcome = await sendTemplatedReply(t.fromEmail, inboundMessageId, WAITLIST_REPLY);
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
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as InboundBody;
    const eventType = body.event_type ?? body.type;
    // The Edge Function already filters message.sent; guard here too. Both received
    // variants are accepted — AgentMail routes mail from domains without passing
    // SPF/DKIM to `message.received.unauthenticated`, and refusing those here would
    // drop real replies from any member whose domain isn't set up (see triage's
    // `authenticated` handling for how that mail is then constrained).
    if (eventType && eventType !== "message.received" && eventType !== UNAUTH_EVENT) {
      return NextResponse.json({ ok: true, ignored: eventType });
    }

    // Trust the Edge Function's explicit flag when present; otherwise infer from the
    // event name. Undefined stays undefined — triage treats "unknown" as
    // authenticated, so the CLI scripts and older payloads keep working.
    const authenticated =
      typeof body.authenticated === "boolean"
        ? body.authenticated
        : eventType === UNAUTH_EVENT
          ? false
          : undefined;

    const msg = body.message;
    if (!msg) return NextResponse.json({ error: "No message in payload" }, { status: 400 });

    const messageId = firstDefined(msg.message_id, msg.messageId);
    const threadId = firstDefined(msg.thread_id, msg.threadId);
    const fromRaw = firstDefined(msg.from_, msg.from);
    const subject = msg.subject ?? null;
    const text = firstDefined(msg.extractedText, msg.extracted_text, msg.text) ?? "";

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
    const eventId = await logEvent(t, messageId, threadId, subject, text);

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
        if (t.personId) await pausePerson(db, t.personId);
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
        const pauseReply = await sendTemplatedReply(t.fromEmail, messageId, {
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
        const scopeReply = await sendTemplatedReply(t.fromEmail, messageId, OUT_OF_SCOPE_REPLY);
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

async function logEvent(
  t: TriageResult,
  messageId: string | null,
  threadId: string | null,
  subject: string | null,
  text: string,
): Promise<string | null> {
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
  // A failure here breaks replay protection and the rate limiter, so it must be loud.
  if (error) console.error(`[inbound] FAILED to log inbound_event: ${error.message}`);
  return (data?.id as string) ?? null;
}
