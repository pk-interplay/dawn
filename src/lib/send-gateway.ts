/**
 * The send gateway. One function. Every send. No exceptions.
 *
 * SPEC §3.2. Order matters, and it is the order below:
 *
 *   1. Suppression — global opt-out, hard fail
 *   2. Consent     — a `not null` FK, not a lookup someone remembers to do
 *   3. Rate limit  — per sending identity and per recipient domain, rolling window
 *   4. Idempotency — insert the `sends` row BEFORE the provider call, fail closed
 *   5. Delivery    — the kill switch; when off, the row stays a draft and stops here
 *   6. Transmit    — only now does agentmail.ts get called
 *
 * Each gate is here because of something that actually went wrong, not because it
 * sounded prudent. The one worth reading twice is 4: while RLS was silently rejecting
 * the `intros` ledger insert, the run failed OPEN and re-emailed every member on every
 * pass. An idempotency ledger that is best-effort is not an idempotency ledger, so a
 * broken write here throws and nothing is sent.
 *
 * This module is the only permitted importer of ./agentmail (CI enforces it). If you
 * are adding a send path, add it here, or it will skip gates you have not thought about.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENTMAIL_INBOX_ID,
  AgentMailError,
  agentMailConfigured,
  replyToMessage,
  sendEmail,
} from "./agentmail";
import { withRetry, type Classified } from "./retry";

export { AGENTMAIL_INBOX_ID };

/**
 * ────────────────────────────────────────────────────────────────────────────
 *  THE KILL SWITCH
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The only thing standing between this system and live email reaching real people.
 *
 * Read as `=== "true"` and never as `!== "false"`. Unset, empty, "TRUE", "1", "yes",
 * or a typo all mean OFF. The inverted form is not a style preference: it has already
 * cost this project once, in `isSingleSided()`, where a `!== "false"` default meant
 * forgetting a variable silently marked a real human as having consented to an
 * introduction nobody had asked them about (see intro-flow.ts). Absence must mean off.
 *
 * Nothing else in the codebase reads this variable. Every send is already funnelled
 * through `send()` below, so this constant is the whole switch.
 *
 * Evaluated per call rather than at module load: a long-lived server process should
 * pick up the change without a redeploy, and tests need to flip it.
 */
function deliveryEnabled(): boolean {
  return process.env.DAWN_DELIVERY_ENABLED === "true";
}

// ---- Rate limits ------------------------------------------------------------
//
// Two ceilings, because they protect different things. The per-identity limit protects
// the SENDER: AgentMail's sending reputation is a shared, network-wide asset, and a
// runaway cron burning it is unrecoverable in a way a missed intro is not. The
// per-domain limit protects the RECIPIENT ORG: twenty Dawn emails landing at one
// company in an hour reads as a mailing list to their mail filter no matter how
// individually well-matched they are.
//
// Deliberately generous relative to the real cadence — a `burst`-tier member gets one
// intro per six hours, so ordinary operation is nowhere near these. They are a backstop
// against a loop, not a throttle on normal use, and they should never be the reason a
// legitimate intro doesn't go out.
const RATE_WINDOW_MINUTES = 60;
const MAX_PER_IDENTITY_PER_WINDOW = 60;
const MAX_PER_DOMAIN_PER_WINDOW = 10;

/**
 * Provider-failure classification for the transmit step. A transient AgentMail
 * 429 or 5xx used to be treated exactly like a permanent rejection — one blip
 * expired an opt-in or burned a nudge attempt. The idempotencyKey the transmit
 * already carries is what makes these retries safe: the provider dedupes a
 * request that actually landed.
 */
function classifyAgentMailFailure(err: unknown): Classified {
  if (err instanceof AgentMailError) {
    const status = err.statusCode;
    if (status === 429) return { kind: "rate", retryable: true, baseMs: 2000 };
    if (status !== undefined && status >= 500) return { kind: "transient", retryable: true, baseMs: 1000 };
    if (status === undefined) return { kind: "transient", retryable: true, baseMs: 1000 }; // network/timeout
    return { kind: "terminal", retryable: false }; // 400/401/403/404/422
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { kind: "transient", retryable: true, baseMs: 1000 };
  }
  return { kind: "terminal", retryable: false };
}

/** Outreach kinds — the four messages an introduction produces. */
export type OutreachKind = "opt_in_a" | "opt_in_b" | "introduction" | "nudge";
/** Reply kinds — answers to someone who wrote to Dawn first. */
export type ReplyKind = "waitlist_reply" | "out_of_scope_reply";
export type SendKind = OutreachKind | ReplyKind;

export interface SendResult {
  messageId: string | null;
  threadId: string | null;
  /** True when nothing was transmitted — drafted, suppressed, duplicate, or blocked. */
  simulated: boolean;
}

export interface DeliveryResult extends SendResult {
  delivered: boolean;
  /**
   * Why nothing went out, when `delivered` is false. `null` means "we chose not to
   * send" — a drafted message under a closed delivery gate is the normal case, not an
   * error, and callers must be able to tell it from a real failure.
   */
  failure:
    | null
    | "no_recipient"
    | "send_failed"
    | "suppressed"
    | "rate_limited"
    | "duplicate"
    | "not_configured";
  /** The `sends` row this call wrote, when it got far enough to write one. */
  sendId: number | null;
  status: "draft" | "sent" | "suppressed" | "duplicate" | "failed";
}

interface CommonSendParams {
  /** Recipients. Nulls tolerated — a person with no email is a data gap, not a crash. */
  to: (string | null)[];
  subject: string;
  /** The exact body to send AND store. Compose the unsubscribe footer before calling. */
  text: string;
  /** When set, reply threaded onto this message rather than sending fresh. */
  replyToMessageId?: string | null;
  /** SPEC §3.1: 'nexus' for strangers/product-owned, 'user:<id>' for warm intros. */
  identity?: string;
  inboxId?: string;
}

/**
 * Gate 2, in the type system.
 *
 * A discriminated union rather than an optional field, so "outreach with no authorising
 * introduction" is not a thing you can write down. The CHECK constraint in 0039 enforces
 * the same rule at the database, which is the one that actually protects you — this half
 * just means you find out at compile time instead of at 3am.
 */
export type SendParams = CommonSendParams &
  (
    | {
        consentBasis?: "introduction";
        /** Required. Outreach is authorised by an introduction or it does not happen. */
        introductionId: string;
        kind: OutreachKind;
        /** Nudges legitimately repeat; everything else is 0. Part of the idempotency key. */
        attempt?: number;
      }
    | {
        /** Answering someone who wrote in. The inbound message IS the consent. */
        consentBasis: "inbound_reply";
        introductionId?: never;
        kind: ReplyKind;
        attempt?: never;
      }
  );

function notDelivered(
  failure: DeliveryResult["failure"],
  status: DeliveryResult["status"],
  sendId: number | null = null,
): DeliveryResult {
  return { messageId: null, threadId: null, simulated: true, delivered: false, failure, status, sendId };
}

/** Everything after the @, lowercased. Used only for the per-domain rate limit. */
function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Gate 1 — global opt-out.
 *
 * Fails the WHOLE send if any single recipient is suppressed, rather than dropping that
 * recipient and delivering to the rest. The warm introduction addresses both parties in
 * one message, and an introduction is not a thing you can half-make: delivering it to
 * one side means telling someone about a person who has asked not to be contacted, and
 * inviting them to reach out. If one side is out, the introduction is off.
 */
async function suppressedRecipients(
  client: SupabaseClient,
  recipients: string[],
): Promise<string[]> {
  if (!recipients.length) return [];
  const { data, error } = await client
    .from("suppressions")
    .select("email")
    .in("email", recipients);
  if (error) {
    // Fail CLOSED. A suppression table we cannot read is not evidence that nobody has
    // opted out; it is evidence that we do not know. The cost of getting this wrong is
    // asymmetric — a skipped intro is recoverable on the next run, emailing someone who
    // told us to stop is not.
    throw new Error(`Refusing to send: suppression check failed (${error.message}).`);
  }
  return (data ?? []).map((r) => String(r.email).toLowerCase());
}

/**
 * Gate 3 — rolling-window rate limits.
 *
 * Counts only rows that represent real transmitted volume (the partial index in 0039
 * matches this filter). Drafts are excluded on purpose: a draft consumed no reputation
 * and cost the recipient nothing, so counting them would mean a long review backlog
 * silently throttling the moment delivery is switched on.
 */
async function rateLimited(
  client: SupabaseClient,
  identity: string,
  recipients: string[],
): Promise<string | null> {
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const delivered = ["queued", "sent", "bounced", "replied"];

  const { count: identityCount, error: iErr } = await client
    .from("sends")
    .select("*", { count: "exact", head: true })
    .eq("identity", identity)
    .in("status", delivered)
    .gte("created_at", since);
  if (iErr) throw new Error(`Refusing to send: rate-limit check failed (${iErr.message}).`);
  if ((identityCount ?? 0) >= MAX_PER_IDENTITY_PER_WINDOW) {
    return `identity ${identity} sent ${identityCount} in the last ${RATE_WINDOW_MINUTES}m`;
  }

  // Per-domain needs the actual rows: `to_emails` is an array column, so counting
  // "sends to this domain" server-side would mean an unnest, and the window is small
  // enough that reading it and bucketing in code is both cheaper and clearer.
  const { data: recent, error: dErr } = await client
    .from("sends")
    .select("to_emails")
    .in("status", delivered)
    .gte("created_at", since)
    .limit(500);
  if (dErr) throw new Error(`Refusing to send: rate-limit check failed (${dErr.message}).`);

  const perDomain = new Map<string, number>();
  for (const row of recent ?? []) {
    for (const addr of (row.to_emails ?? []) as string[]) {
      const d = domainOf(addr);
      perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
    }
  }
  for (const d of new Set(recipients.map(domainOf))) {
    const n = perDomain.get(d) ?? 0;
    if (n >= MAX_PER_DOMAIN_PER_WINDOW) {
      return `domain ${d} received ${n} in the last ${RATE_WINDOW_MINUTES}m`;
    }
  }
  return null;
}

/**
 * The one send path.
 *
 * Never throws for ordinary refusals — a suppressed recipient, a closed delivery gate,
 * a duplicate, a provider 500 all come back as a `DeliveryResult`. Callers are mid-state-
 * transition when they send (intro-flow.ts wraps these in try/catch precisely so one bad
 * send cannot abort a batch), so they need a value to branch on, not an exception.
 *
 * The deliberate exceptions are the two gates whose FAILURE MODE IS UNSAFE: an
 * unreadable suppression table (above) and a broken ledger insert (gate 4). Both throw,
 * because continuing past either means potentially emailing someone we shouldn't.
 */
export async function send(client: SupabaseClient, p: SendParams): Promise<DeliveryResult> {
  const identity = p.identity ?? "nexus";
  const consentBasis = p.consentBasis ?? "introduction";
  const introductionId = p.introductionId ?? null;
  const attempt = p.attempt ?? 0;
  const recipients = [...new Set(p.to.filter((t): t is string => Boolean(t)))];

  if (!recipients.length) return notDelivered("no_recipient", "failed");

  // ---- Gate 1: suppression ------------------------------------------------
  const suppressed = await suppressedRecipients(client, recipients);
  if (suppressed.length) {
    console.warn(`[send-gateway] suppressed → ${suppressed.join(", ")} | ${p.subject}`);
    // Recorded, not just skipped. "We deliberately did not contact this person, and
    // here is when and why" is exactly the thing you need to be able to show later.
    const { data: row } = await client
      .from("sends")
      .insert({
        consent_basis: consentBasis,
        introduction_id: introductionId,
        kind: p.kind,
        attempt,
        identity,
        to_emails: recipients,
        subject: p.subject,
        body_sent: p.text,
        status: "suppressed",
        failure_reason: `suppressed: ${suppressed.join(", ")}`,
      })
      .select("id")
      .maybeSingle();
    return notDelivered("suppressed", "suppressed", row?.id ?? null);
  }

  // ---- Gate 2: consent ----------------------------------------------------
  // Almost nothing to do here, which is the design working. `SendParams` is a
  // discriminated union and `sends_consent_check` is a table constraint, so outreach
  // with no authorising introduction cannot be written down in TypeScript and cannot be
  // inserted in Postgres. A violation that got past both surfaces as a failed insert at
  // gate 4, which throws. Consent is a constraint, not a check someone remembers.
  if (consentBasis === "introduction" && !introductionId) {
    // Belt and braces for a JS caller that skipped the type checker.
    throw new Error("Refusing to send: outreach with no authorising introduction.");
  }

  // ---- Gate 3: rate limit -------------------------------------------------
  const limit = await rateLimited(client, identity, recipients);
  if (limit !== null) {
    console.warn(`[send-gateway] rate limited (${limit}) | ${p.subject}`);
    return notDelivered("rate_limited", "failed");
  }

  // ---- Gate 4: idempotency ------------------------------------------------
  // The row goes in BEFORE the provider call, so a crash between the two leaves
  // evidence that we tried rather than a clean slate that invites a retry.
  const { data: row, error: insErr } = await client
    .from("sends")
    .insert({
      introduction_id: p.introductionId,
      kind: p.kind,
      attempt,
      identity,
      to_emails: recipients,
      subject: p.subject,
      body_sent: p.text,
      status: "draft",
    })
    .select("id")
    .single();

  let sendId: number;
  let retriedFailedRow = false;

  if (insErr) {
    // 23505 = unique violation on (introduction_id, kind, attempt). Usually this is
    // the gate WORKING: something already sent this exact message, and a duplicate is
    // a no-op, not a failure. The exception is a prior row that TRIED and FAILED —
    // without this branch a failed send permanently claims its idempotency slot and
    // can never be retried, which is how a transient provider error became a
    // permanently unsent warm introduction.
    if (insErr.code === "23505") {
      const { data: prior } = await client
        .from("sends")
        .select("id, status")
        .eq("introduction_id", p.introductionId!)
        .eq("kind", p.kind)
        .eq("attempt", attempt)
        .maybeSingle();

      if (prior?.status !== "failed") {
        console.warn(
          `[send-gateway] duplicate suppressed → ${p.kind}#${attempt} for introduction ${p.introductionId}`,
        );
        return notDelivered("duplicate", "duplicate");
      }

      // Reclaim the failed row. The `.eq("status", "failed")` makes this a
      // conditional take: of two concurrent retries, exactly one flips the row back
      // to draft and proceeds; the other matches zero rows and reports duplicate.
      const { data: reclaimed, error: reclaimErr } = await client
        .from("sends")
        .update({
          status: "draft",
          failure_reason: null,
          to_emails: recipients,
          subject: p.subject,
          body_sent: p.text,
          updated_at: new Date().toISOString(),
        })
        .eq("id", prior.id)
        .eq("status", "failed")
        .select("id");
      if (reclaimErr) {
        throw new Error(
          `Refusing to send: could not reclaim failed sends#${prior.id} (${reclaimErr.message}).`,
        );
      }
      if (!reclaimed?.length) return notDelivered("duplicate", "duplicate");

      console.log(`[send-gateway] retrying previously failed sends#${prior.id} (${p.kind}#${attempt})`);
      sendId = prior.id as number;
      retriedFailedRow = true;
    } else {
      // Anything else — RLS, FK violation, connection loss — is the failure mode that
      // caused the incident this gate exists for. Fail closed, loudly.
      throw new Error(
        `Refusing to send: could not write the send ledger (${insErr.message}). ` +
          `Nothing was transmitted.`,
      );
    }
  } else {
    sendId = row.id as number;
  }

  // ---- Gate 5: the delivery switch ----------------------------------------
  if (!deliveryEnabled()) {
    console.log(
      `[send-gateway] drafted (delivery off) → ${recipients.join(", ")} | ${p.subject} | sends#${sendId}`,
    );
    // The row stays `draft` with the exact body stored. This is the reviewable artefact:
    // everything that would have been sent, visible before anything can be.
    return notDelivered(null, "draft", sendId);
  }

  if (!agentMailConfigured()) {
    // Delivery was switched ON but the transport has no credentials. Distinct from a
    // deliberate draft, and worth its own failure code — this is a deploy that thinks
    // it is live and is not.
    console.error(`[send-gateway] delivery enabled but AGENTMAIL_API_KEY is unset | sends#${sendId}`);
    await markFailed(client, sendId, "AGENTMAIL_API_KEY unset");
    return notDelivered("not_configured", "failed", sendId);
  }

  // ---- Gate 6: transmit ---------------------------------------------------
  try {
    // A reclaimed row gets a fresh key: some providers dedupe against the FAILED
    // attempt's key. Within one call the key is stable, so withRetry's own
    // attempts are still provider-deduped.
    const idempotencyKey = retriedFailedRow ? `sends-${sendId}-r${Date.now()}` : `sends-${sendId}`;
    const transmitPolicy = {
      classify: classifyAgentMailFailure,
      attempts: 3,
      label: `[send-gateway] sends#${sendId}`,
    };
    const res = p.replyToMessageId
      ? await withRetry(
          () =>
            replyToMessage({
              messageId: p.replyToMessageId!,
              text: p.text,
              inboxId: p.inboxId,
              idempotencyKey,
            }),
          transmitPolicy,
        )
      : await withRetry(
          () =>
            sendEmail({
              to: recipients,
              subject: p.subject,
              text: p.text,
              inboxId: p.inboxId,
              idempotencyKey,
            }),
          transmitPolicy,
        );

    const { error: updErr } = await client
      .from("sends")
      .update({
        status: "sent",
        provider_message_id: res.messageId,
        thread_id: res.threadId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sendId);
    // The mail is already gone; a failed bookkeeping update must not be reported as a
    // failed send, or the caller retries and delivers a second copy.
    if (updErr) console.error(`[send-gateway] sent but could not update sends#${sendId}: ${updErr.message}`);

    return {
      messageId: res.messageId,
      threadId: res.threadId,
      simulated: false,
      delivered: true,
      failure: null,
      status: "sent",
      sendId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[send-gateway] send failed | sends#${sendId}: ${message}`);

    // A threaded reply whose parent the inbox doesn't recognise 404s. That is a stale
    // message id, not a reason to drop the follow-up, so fall back to a fresh send —
    // the recipient gets an unthreaded email instead of nothing.
    if (p.replyToMessageId) {
      try {
        const res = await sendEmail({
          to: recipients,
          subject: p.subject,
          text: p.text,
          inboxId: p.inboxId,
          idempotencyKey: `sends-${sendId}-fresh`,
        });
        await client
          .from("sends")
          .update({
            status: "sent",
            provider_message_id: res.messageId,
            thread_id: res.threadId,
            failure_reason: `threaded reply failed, sent fresh: ${message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", sendId);
        return {
          messageId: res.messageId,
          threadId: res.threadId,
          simulated: false,
          delivered: true,
          failure: null,
          status: "sent",
          sendId,
        };
      } catch (fresh) {
        const freshMessage = fresh instanceof Error ? fresh.message : String(fresh);
        await markFailed(client, sendId, `${message}; fresh retry: ${freshMessage}`);
        return notDelivered("send_failed", "failed", sendId);
      }
    }

    await markFailed(client, sendId, message);
    return notDelivered("send_failed", "failed", sendId);
  }
}

async function markFailed(client: SupabaseClient, sendId: number, reason: string): Promise<void> {
  // status: 'failed' (0042), not a failure_reason smeared onto a 'draft' — a
  // failed send must be distinguishable from a deliberately-held draft in the
  // Outbox, must not be deleted by draft cleanup, and (via the reclaim branch in
  // send()) is what makes the send retryable at all.
  const { error } = await client
    .from("sends")
    .update({ status: "failed", failure_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", sendId);
  if (error) console.error(`[send-gateway] could not record failure on sends#${sendId}: ${error.message}`);
}

/**
 * Record a global opt-out. Called by inbound triage when someone replies "unsubscribe".
 *
 * Idempotent: a second unsubscribe from the same address is a no-op, not an error. It
 * happens routinely — people reply twice, or to two different threads — and it must
 * never surface as a failure that stops the rest of the inbound handler running.
 */
export async function suppress(
  client: SupabaseClient,
  email: string,
  reason = "unsubscribe",
  evidence?: string,
): Promise<void> {
  const { error } = await client
    .from("suppressions")
    .upsert({ email, reason, evidence: evidence ?? null }, { onConflict: "email" });
  if (error) throw new Error(`Could not record suppression for ${email}: ${error.message}`);
}
