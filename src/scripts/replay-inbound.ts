// Pull recent messages from the AgentMail inbox and replay them into a locally
// running /api/agent/inbound, exactly as the webhook Edge Function would.
//
// Why this exists: the webhook posts to APP_URL, so while APP_URL points at a
// deployment the operator cannot reach (access protection, or simply a URL that
// isn't serving this build), every reply is accepted by AgentMail and then dropped.
// The reply is not lost — it is sitting in the inbox. This forwards it by hand so the
// double opt-in state machine can advance without waiting on a tunnel or a deploy.
//
//   npx tsx src/scripts/replay-inbound.ts              # list what's replayable
//   npx tsx src/scripts/replay-inbound.ts --send       # actually forward them
//
// Env: AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID, CRON_SECRET, LOCAL_APP_URL.
//
// Safe to re-run: the route writes one `inbound_events` row per message_id and uses
// it as a replay guard, so a message forwarded twice is recorded and ignored the
// second time rather than advancing the state machine twice.

import "../lib/env";
import { AgentMailClient } from "agentmail";
import { AGENTMAIL_INBOX_ID } from "../lib/agentmail";

const APP = (process.env.LOCAL_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
const SEND = process.argv.includes("--send");
const LIMIT = Number(process.env.REPLAY_LIMIT ?? 20);

if (!process.env.AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY is required.");
if (!SECRET) throw new Error("CRON_SECRET is required — /api/agent/inbound would 401.");

const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });

/** The inbox's own address, so Dawn's own sends aren't replayed back at it. */
const SELF = AGENTMAIL_INBOX_ID.toLowerCase();

async function main() {
  const list = await client.inboxes.messages.list(AGENTMAIL_INBOX_ID, { limit: LIMIT });
  const messages = (list as { messages?: unknown[] }).messages ?? [];

  // Newest last, so a thread's replies are forwarded in the order they were written.
  // Out of order, an "ok Tuesday works" can arrive before the "yes" it follows and be
  // triaged against an introduction that hasn't reached scheduling yet.
  const inbound = messages
    .map((m) => m as Record<string, unknown>)
    .filter((m) => {
      const from = String(m.from ?? m.from_ ?? "").toLowerCase();
      return from && !from.includes(SELF);
    })
    .reverse();

  if (!inbound.length) {
    console.log(`No inbound messages in ${AGENTMAIL_INBOX_ID} (checked ${messages.length}).`);
    return;
  }

  console.log(`${inbound.length} inbound message(s) in ${AGENTMAIL_INBOX_ID}:\n`);
  for (const m of inbound) {
    const text = String(m.text ?? m.preview ?? "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`  from=${m.from ?? m.from_}  subject=${String(m.subject ?? "").slice(0, 50)}`);
    console.log(`    id=${m.messageId ?? m.message_id}  thread=${m.threadId ?? m.thread_id}`);
    console.log(`    "${text}"`);
  }

  if (!SEND) {
    console.log(`\nDry run. Re-run with --send to forward these to ${APP}/api/agent/inbound`);
    return;
  }

  for (const m of inbound) {
    // Mirrors the Edge Function's payload, including the snake_case field names the
    // real webhook uses — the route accepts either, but sending what production sends
    // means this script exercises the same parsing path.
    const body = {
      event_type: "message.received",
      message: {
        inbox_id: AGENTMAIL_INBOX_ID,
        message_id: m.messageId ?? m.message_id,
        thread_id: m.threadId ?? m.thread_id,
        from: m.from ?? m.from_,
        subject: m.subject,
        text: m.text ?? m.preview ?? "",
      },
    };

    const res = await fetch(`${APP}/api/agent/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    });
    const out = await res.text();
    console.log(`\n→ ${body.message.from} (${res.status}): ${out.slice(0, 300)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
