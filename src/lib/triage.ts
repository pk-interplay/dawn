import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENTMAIL_INBOX_ID } from "./agentmail";
import { parseReplyIntent, type ReplyIntent } from "./intro-flow";

// The gate in front of Dawn's inbox.
//
// Before this existed, /api/agent/inbound would classify any message that could be
// tied to an open conversation — running the model BEFORE checking whether the
// sender was even a member, with no replay protection and no per-sender ceiling.
// Three consequences: a webhook retry re-ran the state machine, an unknown sender
// could burn tokens, and there was no way for Dawn to decline a request that isn't
// something it does.
//
// Checks run strictly cheapest-first, and the single LLM call is LAST. Everything
// before it is one indexed query or a string comparison, so the cost of an abusive
// or accidental sender is bounded at roughly zero.

export type InboundDecision =
  | "reply_to_intro"
  | "preference_update"
  | "pause"
  | "out_of_scope"
  | "non_member"
  | "rate_limited"
  | "duplicate"
  | "self_send";

/** Introductions in these states can no longer be advanced by a reply. */
const TERMINAL_INTRO_STATES = ["declined", "expired", "scheduled", "completed"];

const RATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MEMBER_MAX_PER_HOUR = 10;

function memberRateLimit(): number {
  const raw = Number(process.env.INBOUND_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MEMBER_MAX_PER_HOUR;
}

/** Extract a bare address from `Display Name <user@host>` or `user@host`. */
export function extractEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const candidate = (m ? m[1] : raw).trim().toLowerCase();
  return /.+@.+\..+/.test(candidate) ? candidate : null;
}

/**
 * The address with any `+tag` stripped from the local part: `pk+ava@x.com` → `pk@x.com`.
 *
 * Gmail-style tags are how one operator mailbox backs many `people` rows (the demo
 * personas of 0018 — `people.email` is unique, so they cannot simply share an
 * address). Replies, though, arrive FROM the untagged mailbox, so the tag is the one
 * part of the round trip that doesn't survive.
 */
export function baseAddress(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  const plus = local.indexOf("+");
  return (plus < 0 ? local : local.slice(0, plus)) + email.slice(at);
}

/** Extract a display name from `Display Name <user@host>`, if present. */
export function extractName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = m?.[1]?.trim();
  return name && !name.includes("@") ? name : null;
}

export interface InboundMessageInput {
  agentmailMessageId: string | null;
  threadId: string | null;
  fromRaw: string | null;
  subject: string | null;
  text: string;
}

export interface TriageResult {
  decision: InboundDecision;
  fromEmail: string | null;
  fromName: string | null;
  personId: string | null;
  conversationId: string | null;
  introductionId: string | null;
  /** Name of the person Dawn suggested, when the reply is inside an introduction. */
  suggestedName: string | null;
  /** Present only when we actually paid for a classification. */
  intent: ReplyIntent | null;
  note: string;
}

function base(msg: InboundMessageInput): TriageResult {
  return {
    decision: "out_of_scope",
    fromEmail: extractEmail(msg.fromRaw),
    fromName: extractName(msg.fromRaw),
    personId: null,
    conversationId: null,
    introductionId: null,
    suggestedName: null,
    intent: null,
    note: "",
  };
}

interface Participant {
  person_id?: string;
  email?: string;
  role?: string;
}

/**
 * Who Dawn addressed a given thread to.
 *
 * Every side of an introduction gets its own conversation and therefore its own
 * thread (see `inviteSecondSide`), so a thread has exactly one recipient — which
 * makes the thread id enough to say which person a reply is speaking for, even when
 * the From address alone cannot.
 *
 * The outbound message's `to_emails` is the literal address we wrote to, so it is
 * preferred over participant ordering, which is only conventionally recipient-first.
 */
async function threadRecipient(
  client: SupabaseClient,
  threadId: string,
): Promise<{ personId: string; email: string | null } | null> {
  const { data: convo } = await client
    .from("conversations")
    .select("id, participants")
    .eq("thread_id", threadId)
    .maybeSingle();
  if (!convo) return null;

  const participants = (Array.isArray(convo.participants) ? convo.participants : []) as Participant[];
  if (!participants.length) return null;

  const { data: sent } = await client
    .from("messages")
    .select("to_emails")
    .eq("conversation_id", convo.id)
    .eq("direction", "outbound")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const toEmails = (Array.isArray(sent?.to_emails) ? sent!.to_emails : []) as string[];
  const addressed = toEmails[0]?.toLowerCase() ?? null;
  const matched = addressed
    ? participants.find((p) => p.email && p.email.toLowerCase() === addressed)
    : null;
  const recipient = matched ?? participants[0];
  if (!recipient?.person_id) return null;

  return { personId: recipient.person_id, email: recipient.email?.toLowerCase() ?? addressed };
}

/**
 * Which member sent this message.
 *
 * The address is normally decisive, and stays decisive for real members. The thread
 * is consulted FIRST — but only when it points at someone sharing the sender's base
 * address — because that is the single case the address cannot settle: the operator
 * replying from `pk@` on behalf of the persona Dawn wrote to at `pk+ava@`. Without
 * it, every persona reply is a `non_member` and the second half of double opt-in can
 * never be exercised over real email.
 *
 * Requiring the base match keeps this narrow. Someone forwarded a Dawn email cannot
 * assume the recipient's identity by replying into the thread: their address doesn't
 * reduce to the recipient's, so they fall through to the ordinary lookup and end up a
 * lead, exactly as before.
 */
async function resolveSender(
  client: SupabaseClient,
  fromEmail: string,
  threadId: string | null,
): Promise<{ id: string; name: string | null; via: "address" | "thread_alias" } | null> {
  const senderBase = baseAddress(fromEmail);

  if (threadId) {
    const recipient = await threadRecipient(client, threadId);
    if (recipient?.email && baseAddress(recipient.email) === senderBase) {
      const { data } = await client
        .from("people")
        .select("id, name")
        .eq("id", recipient.personId)
        .maybeSingle();
      if (data) {
        const via = recipient.email === fromEmail ? "address" : "thread_alias";
        if (via === "thread_alias") {
          console.info(
            `[triage] ${fromEmail} resolved to ${data.name} (${recipient.email}) via thread ${threadId}.`,
          );
        }
        return { id: data.id as string, name: (data.name as string) ?? null, via };
      }
    }
  }

  // `maybeSingle()` errors rather than guesses when two rows match; 0016 makes the
  // email unique, so a failure here means an invariant broke and must be loud —
  // swallowing it once turned a duplicate signup into a real member being told they
  // weren't one.
  const { data: person, error } = await client
    .from("people")
    .select("id, name")
    .ilike("email", fromEmail)
    .maybeSingle();
  if (error) {
    console.error(`[triage] member lookup for ${fromEmail} failed (duplicate rows?): ${error.message}`);
    return null;
  }
  if (!person) return null;
  return { id: person.id as string, name: (person.name as string) ?? null, via: "address" };
}

export async function triage(
  client: SupabaseClient,
  msg: InboundMessageInput,
): Promise<TriageResult> {
  const result = base(msg);
  const fromEmail = result.fromEmail;

  if (!fromEmail) {
    return { ...result, decision: "out_of_scope", note: "No parseable sender address." };
  }

  // 1. Replay protection. AgentMail retries deliveries, and the old route would
  //    re-classify and re-advance the state machine on every retry. Checked first
  //    so a retry storm consumes neither tokens nor rate-limit budget.
  if (msg.agentmailMessageId) {
    const { data: seen } = await client
      .from("inbound_events")
      .select("id")
      .eq("agentmail_message_id", msg.agentmailMessageId)
      .maybeSingle();
    if (seen) {
      return { ...result, decision: "duplicate", note: "Already processed this message id." };
    }
  }

  // 2. Loop guard. The Edge Function drops `message.sent`, but a misconfigured
  //    webhook or a forwarding rule can still hand us our own mail.
  if (fromEmail === AGENTMAIL_INBOX_ID.toLowerCase()) {
    return { ...result, decision: "self_send", note: "Message is from Dawn's own inbox." };
  }

  // 3. Membership. Dawn only works with members; everyone else becomes a lead.
  const person = await resolveSender(client, fromEmail, msg.threadId);
  if (!person) {
    return { ...result, decision: "non_member", note: "Sender is not a member." };
  }
  result.personId = person.id;

  // 4. Per-member ceiling. Bounds both accidental loops and deliberate abuse, and
  //    caps the token spend any one member can trigger.
  //
  //    Counted per resolved PERSON, not per From address. Only members ever reach
  //    this line (non-members returned above, before any token spend), so the person
  //    is the meaningful unit — and one mailbox can now legitimately answer for
  //    several people, so a per-address ceiling would silence the operator's whole
  //    persona set after ten replies while each individual persona sat well under it.
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const limit = memberRateLimit();
  const { count } = await client
    .from("inbound_events")
    .select("*", { count: "exact", head: true })
    .eq("person_id", result.personId)
    .gte("created_at", since);
  if ((count ?? 0) >= limit) {
    return {
      ...result,
      decision: "rate_limited",
      note: `${count} messages in the last hour (limit ${limit}).`,
    };
  }

  // 5. Bind the conversation. Prefer the AgentMail thread id; otherwise fall back
  //    to the most recent open conversation this sender participates in.
  let conversation:
    | { id: string; introduction_id: string | null }
    | null = null;

  if (msg.threadId) {
    const { data } = await client
      .from("conversations")
      .select("id, introduction_id")
      .eq("thread_id", msg.threadId)
      .maybeSingle();
    conversation = data ?? null;
  }
  if (!conversation) {
    const { data } = await client
      .from("conversations")
      .select("id, introduction_id, participants")
      .eq("state", "open")
      .order("created_at", { ascending: false })
      .limit(25);
    conversation =
      (data ?? []).find(
        (c) =>
          Array.isArray(c.participants) &&
          c.participants.some(
            (p: { person_id?: string }) => p.person_id === result.personId,
          ),
      ) ?? null;
  }

  // 6. If we bound an introduction, check it can still be advanced. A stale thread
  //    must not be able to reanimate an intro that was declined or already booked.
  let introTerminalState: string | null = null;
  if (conversation?.introduction_id) {
    const { data: intro } = await client
      .from("introductions")
      .select("id, state, person_a_id, person_b_id")
      .eq("id", conversation.introduction_id)
      .maybeSingle();
    if (intro) {
      if (TERMINAL_INTRO_STATES.includes(intro.state as string)) {
        introTerminalState = intro.state as string;
      } else {
        result.conversationId = conversation.id;
        result.introductionId = intro.id as string;
        const otherId =
          intro.person_a_id === result.personId ? intro.person_b_id : intro.person_a_id;
        const { data: other } = await client
          .from("people")
          .select("name")
          .eq("id", otherId)
          .maybeSingle();
        result.suggestedName = (other?.name as string) ?? null;
      }
    }
  } else if (conversation) {
    // A conversation with no introduction (e.g. onboarding) — still worth binding
    // so the message is stored against it.
    result.conversationId = conversation.id;
  }

  // 7. Only now do we spend a model call.
  const intent = await parseReplyIntent(msg.text, {
    inIntroduction: Boolean(result.introductionId),
    suggestedName: result.suggestedName,
  });
  result.intent = intent;

  // An unsubscribe outranks everything else — never keep processing someone who
  // just asked us to stop.
  if (intent.requests_pause) {
    return { ...result, decision: "pause", note: "Member asked Dawn to stop." };
  }

  if (result.introductionId) {
    if (intent.off_topic && intent.opted_in === "unclear") {
      return {
        ...result,
        decision: "out_of_scope",
        note: "Reply in an intro thread, but asking for something Dawn doesn't do.",
      };
    }
    return { ...result, decision: "reply_to_intro", note: "Reply inside a live introduction." };
  }

  if (introTerminalState) {
    return {
      ...result,
      decision: "out_of_scope",
      note: `Thread's introduction is already ${introTerminalState}; nothing to advance.`,
    };
  }

  // Member, but not inside a live introduction. The only unsolicited things Dawn
  // accepts are statements about their own preferences — not open-ended requests.
  if (intent.preference_signals.length > 0 && !intent.off_topic) {
    return {
      ...result,
      decision: "preference_update",
      note: `${intent.preference_signals.length} preference signal(s) from a member.`,
    };
  }

  return {
    ...result,
    decision: "out_of_scope",
    note: "Member message outside any live introduction, with no preference to record.",
  };
}
