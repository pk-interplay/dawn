/**
 * AgentMail transport. Dumb on purpose.
 *
 * This module knows how to put bytes on the wire and nothing else. It does not decide
 * whether a message SHOULD go out — no suppression check, no consent check, no rate
 * limit, no ledger write, no kill switch. Every one of those lives in send-gateway.ts,
 * which is the only module allowed to import this one (CI enforces both halves of that:
 * one transport, one caller).
 *
 * The split exists because the previous arrangement had gating and sending in the same
 * file, which is how you end up with a second send path that skips half the gates. If
 * you are here to add a "just this once" send, you are in the wrong file.
 *
 * AgentMail rather than a transactional provider because the double opt-in flow needs a
 * real two-way inbox: Dawn sends an ask and a human replies to it, and that reply has to
 * come back through a webhook. Resend/SendGrid/Postmark are send-only and cannot do the
 * second half. (They are also all banned by the CI guard, for the same reason this file
 * is quarantined: they'd be a send path around the gateway.)
 */

import { AgentMailClient, AgentMailError } from "agentmail";

// Re-exported so the send gateway can classify provider failures (429 vs 5xx vs
// terminal 4xx) without importing the SDK itself — CI's "one transport" guard
// allows the SDK only in this file.
export { AgentMailError };

/**
 * The inbox Dawn sends from and receives on.
 *
 * Env-overridable, but the default is load-bearing: it is already written into existing
 * `conversations.inbox_id` and `messages.from_email` rows by the state machine that ran
 * while sending was disabled. Changing the default orphans those rows from the inbox
 * they claim to belong to.
 */
export const AGENTMAIL_INBOX_ID = process.env.AGENTMAIL_INBOX_ID || "dawnagent@agentmail.to";

export interface SendResult {
  messageId: string | null;
  threadId: string | null;
  /** True when nothing was actually transmitted. Always false on this path. */
  simulated: boolean;
}

let cached: AgentMailClient | null = null;

function getClient(): AgentMailClient {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    // Deliberately throws rather than silently simulating.
    //
    // The old behaviour was "no key → log and pretend it sent", which is the right
    // default for a dev script and the wrong one for a system with a real delivery
    // switch: it means a production deploy that is missing its key reports every send
    // as fine while nothing leaves the building. There is now exactly one intentional
    // way not to send (DAWN_DELIVERY_ENABLED, checked in the gateway before we ever get
    // here), and a missing key is not it — that is a misconfiguration and should look
    // like one.
    throw new Error(
      "AGENTMAIL_API_KEY is not set. Delivery is enabled but the transport has no credentials.",
    );
  }
  if (!cached) cached = new AgentMailClient({ apiKey });
  return cached;
}

/** Whether the transport could send if asked. The gateway reports this distinctly. */
export function agentMailConfigured(): boolean {
  return Boolean(process.env.AGENTMAIL_API_KEY);
}

/**
 * Testing override: with MAIL_REDIRECT_TO set, every outbound email goes there instead
 * of to the real recipient, with the intended recipient noted in the body.
 *
 * This is what makes the seeded personas usable — their @example.com addresses don't
 * deliver, and the sandbox maps the operator's real inboxes onto fake personas so the
 * inbound reply leg is testable. It stays in the transport rather than the gateway
 * because it rewrites the envelope, not the decision: the ledger records who the message
 * was FOR, which is the thing you want to read six months later.
 */
function applyRedirect(to: string[], text: string): { to: string[]; text: string } {
  const redirect = process.env.MAIL_REDIRECT_TO?.trim();
  if (!redirect || (to.length === 1 && to[0] === redirect)) return { to, text };
  const note = `[Test redirect — originally to: ${to.join(", ")}]`;
  return { to: [redirect], text: `${note}\n\n${text}` };
}

/**
 * Send a fresh message. Throws on any provider error — the gateway catches.
 *
 * `idempotencyKey` should be the `sends.id` the gateway just wrote. The unique index on
 * `(introduction_id, kind, attempt)` already makes a duplicate impossible on our side;
 * this closes the remaining window where our write succeeded, the provider call
 * succeeded, and the response was lost in transit, so a retry would otherwise deliver a
 * second copy.
 */
export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
  inboxId?: string;
  idempotencyKey?: string;
}): Promise<SendResult> {
  const client = getClient();
  const inboxId = opts.inboxId ?? AGENTMAIL_INBOX_ID;
  const { to, text } = applyRedirect(opts.to, opts.text);
  const res = await client.inboxes.messages.send(
    inboxId,
    { to, subject: opts.subject, text },
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  return { messageId: res.messageId, threadId: res.threadId, simulated: false };
}

/**
 * List recent messages in the inbox. Read-only.
 *
 * Here rather than in a caller because this module is the only place allowed to
 * construct an `AgentMailClient` — one SDK handle, one file, enforced in CI. Reading is
 * not sending and does not go through the gateway: there is nothing to suppress, no
 * consent to establish, and no ledger row to write. The gateway governs what LEAVES.
 */
export async function listInboxMessages(
  inboxId: string = AGENTMAIL_INBOX_ID,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const client = getClient();
  const list = await client.inboxes.messages.list(inboxId, { limit });
  const messages = (list as { messages?: unknown[] }).messages ?? [];
  return messages.map((m) => m as Record<string, unknown>);
}

/**
 * Reply to an existing message, threaded. Throws on any provider error.
 *
 * AgentMail reuses the parent subject (Re:-prefixed) and threads it, and takes no
 * recipient list — it answers whoever sent the parent. That constraint is why the warm
 * introduction (which must address both parties at once) is a fresh send rather than a
 * reply; see the call site in intro-flow.ts.
 */
export async function replyToMessage(opts: {
  messageId: string;
  text: string;
  inboxId?: string;
  idempotencyKey?: string;
}): Promise<SendResult> {
  const client = getClient();
  const inboxId = opts.inboxId ?? AGENTMAIL_INBOX_ID;
  const res = await client.inboxes.messages.reply(
    inboxId,
    opts.messageId,
    { text: opts.text },
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  return { messageId: res.messageId, threadId: res.threadId, simulated: false };
}
