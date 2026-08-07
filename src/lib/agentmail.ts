/**
 * THIS MODULE CANNOT SEND EMAIL. It is a typed no-op.
 *
 * Dawn's email product — the AgentMail two-way inbox, the inbound webhook, the
 * triage layer, and the inbox/exchange UI — has been removed. What remains is the
 * double opt-in state machine in intro-flow.ts, deliberately kept in the repo but
 * dark, to be rewired to another channel later.
 *
 * That state machine imports this module's send surface at five call sites, so the
 * surface is retained with identical signatures and every function hard-wired to
 * the "not delivered" branch. Nothing here reads an API key, constructs a client,
 * or makes a network call; the `agentmail` dependency is gone from package.json and
 * a CI grep guard fails the build if any email SDK import comes back.
 *
 * Two decisions worth keeping:
 *
 *   1. These functions RETURN rather than throw. intro-flow.ts wraps its sends in a
 *      try/catch (see the comment at its ledger write) whose job is to stop one bad
 *      send from aborting a batch — so a throw here would be swallowed and
 *      startIntroduction() would half-run, writing rows for an intro that never
 *      went anywhere. Returning the not-delivered shape keeps the state machine
 *      coherent: it already knows how to record "we chose not to send".
 *
 *   2. This is the removal of a branch, not new behaviour. The `simulated` path
 *      below is exactly what ran locally whenever AGENTMAIL_API_KEY was unset, so
 *      it is the best-exercised path in the file. It is now the only path.
 *
 * The real replacement is SPEC.md §3.2's send gateway: one function every send goes
 * through, ordered suppression → consent → rate limit → idempotency → approval.
 * That is build step 5. Do not restore this file's send capability to get there.
 */

// Retained as a plain constant, no env read. intro-flow.ts writes it into
// `conversations.inbox_id` and `messages.from_email`, so the value still has to
// exist and still has to be stable — it is now just an identifier for rows the
// dark state machine writes, not a mailbox anything talks to.
export const AGENTMAIL_INBOX_ID = "dawnagent@agentmail.to";

export interface SendResult {
  messageId: string | null;
  threadId: string | null;
  simulated: boolean;
}

export interface DeliveryResult extends SendResult {
  delivered: boolean;
  /** Why nothing went out, when `delivered` is false. */
  failure: "no_recipient" | "send_failed" | null;
}

/** Always false. Kept so callers branching on it compile and take the no-send path. */
export function agentMailConfigured(): boolean {
  return false;
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
  inboxId?: string;
}): Promise<SendResult> {
  console.warn(
    `[agentmail:disabled] send suppressed → ${opts.to.join(", ")} | ${opts.subject}`,
  );
  return { messageId: null, threadId: null, simulated: true };
}

export async function replyToMessage(opts: {
  messageId: string;
  text: string;
  inboxId?: string;
}): Promise<SendResult> {
  console.warn(`[agentmail:disabled] reply suppressed → ${opts.messageId}`);
  return { messageId: null, threadId: null, simulated: true };
}

/**
 * Previously: reply threaded when possible, fall back to a fresh send, never throw.
 * Now: never sends, still never throws, and still reports "we chose not to send"
 * (`failure: null`) distinctly from a real failure — the distinction intro-flow.ts
 * relies on to tell a suppressed send from a broken one.
 */
export async function sendThreadedOrFresh(opts: {
  replyToMessageId: string | null;
  /** All recipients. Double opt-in scheduling addresses both parties at once. */
  to: (string | null)[];
  subject: string;
  text: string;
  inboxId?: string;
}): Promise<DeliveryResult> {
  const recipients = [...new Set(opts.to.filter((t): t is string => Boolean(t)))];
  console.warn(
    `[agentmail:disabled] send suppressed → ${recipients.join(", ") || "(no recipient)"} | ${opts.subject}`,
  );
  return {
    messageId: null,
    threadId: null,
    simulated: true,
    delivered: false,
    // Preserved even with no recipients: "nobody to send to" is a data problem the
    // state machine reports differently from a suppressed send.
    failure: recipients.length ? null : "no_recipient",
  };
}
