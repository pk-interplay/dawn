import { AgentMailClient } from "agentmail";

// The AgentMail inbox Dawn sends from and receives on. AgentMail gives an agent
// a real two-way inbox (send + receive via webhook), which is what the double
// opt-in flow needs — unlike a send-only transactional provider.
export const AGENTMAIL_INBOX_ID = process.env.AGENTMAIL_INBOX_ID || "dawnagent@agentmail.to";

export interface SendResult {
  messageId: string | null;
  threadId: string | null;
  simulated: boolean;
}

let cached: AgentMailClient | null = null;

function getClient(): AgentMailClient | null {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) return null;
  if (!cached) cached = new AgentMailClient({ apiKey });
  return cached;
}

// When no API key is configured we run in "simulated" mode: the whole intro
// flow still executes and persists, we just log instead of sending real mail.
// This keeps the pipeline testable without a live AgentMail account.
export function agentMailConfigured(): boolean {
  return Boolean(process.env.AGENTMAIL_API_KEY);
}

// Testing override: when MAIL_REDIRECT_TO is set, every outbound email is
// delivered there instead of to the real recipient (seeded people have fake
// @example.com addresses that don't deliver). The original recipient is noted
// in the body so it's clear who the intro was actually for.
function applyRedirect(to: string[], text: string): { to: string[]; text: string } {
  const redirect = process.env.MAIL_REDIRECT_TO?.trim();
  if (!redirect || (to.length === 1 && to[0] === redirect)) return { to, text };
  const note = `[Test redirect — originally to: ${to.join(", ")}]`;
  return { to: [redirect], text: `${note}\n\n${text}` };
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
  inboxId?: string;
}): Promise<SendResult> {
  const client = getClient();
  const inboxId = opts.inboxId ?? AGENTMAIL_INBOX_ID;
  const { to, text } = applyRedirect(opts.to, opts.text);
  if (!client) {
    console.log(`[agentmail:simulated] send → ${to.join(", ")} | ${opts.subject}`);
    return { messageId: null, threadId: null, simulated: true };
  }
  const res = await client.inboxes.messages.send(inboxId, {
    to,
    subject: opts.subject,
    text,
  });
  return { messageId: res.messageId, threadId: res.threadId, simulated: false };
}

export async function replyToMessage(opts: {
  messageId: string;
  text: string;
  inboxId?: string;
}): Promise<SendResult> {
  const client = getClient();
  const inboxId = opts.inboxId ?? AGENTMAIL_INBOX_ID;
  if (!client) {
    console.log(`[agentmail:simulated] reply → ${opts.messageId}`);
    return { messageId: null, threadId: null, simulated: true };
  }
  // AgentMail auto-reuses the parent subject (Re:-prefixed) and threads it.
  const res = await client.inboxes.messages.reply(inboxId, opts.messageId, { text: opts.text });
  return { messageId: res.messageId, threadId: res.threadId, simulated: false };
}

export interface DeliveryResult extends SendResult {
  delivered: boolean;
  /** Why nothing went out, when `delivered` is false. */
  failure: "no_recipient" | "send_failed" | null;
}

/**
 * Reply threaded when possible, fall back to a fresh send, and never throw.
 *
 * AgentMail returns 404 for a reply whose parent id it doesn't recognise — which
 * happens with synthetic/test payloads and with any inbound id the inbox can't see.
 * Callers are mid-transition when they send, so a delivery failure must not abort
 * them; they need a boolean, not an exception. Crucially this reports failure
 * distinctly from "we chose not to send", so the two can't be confused upstream.
 */
export async function sendThreadedOrFresh(opts: {
  replyToMessageId: string | null;
  /** All recipients. Double opt-in scheduling addresses both parties at once. */
  to: (string | null)[];
  subject: string;
  text: string;
  inboxId?: string;
}): Promise<DeliveryResult> {
  const miss: DeliveryResult = {
    messageId: null,
    threadId: null,
    simulated: true,
    delivered: false,
    failure: null,
  };

  if (opts.replyToMessageId) {
    try {
      const res = await replyToMessage({
        messageId: opts.replyToMessageId,
        text: opts.text,
        inboxId: opts.inboxId,
      });
      return { ...res, delivered: true, failure: null };
    } catch (err) {
      console.error(
        `[agentmail] threaded reply to ${opts.replyToMessageId} failed; falling back to a fresh send:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const recipients = [...new Set(opts.to.filter((t): t is string => Boolean(t)))];
  if (!recipients.length) return { ...miss, failure: "no_recipient" };

  try {
    const res = await sendEmail({
      to: recipients,
      subject: opts.subject,
      text: opts.text,
      inboxId: opts.inboxId,
    });
    return { ...res, delivered: true, failure: null };
  } catch (err) {
    console.error("[agentmail] send failed:", err instanceof Error ? err.message : err);
    return { ...miss, failure: "send_failed" };
  }
}
