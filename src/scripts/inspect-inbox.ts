// What is actually sitting in Dawn's AgentMail inbox, and how AgentMail labelled it.
//
// The label is the point. AgentMail runs SPF/DKIM/DMARC on every inbound message:
// it DROPS mail whose authentication headers are present and fail, and it delivers
// mail whose headers are MISSING with an `unauthenticated` label. An unauthenticated
// message raises `message.received.unauthenticated`, NOT `message.received` — so a
// webhook subscribed only to the latter never fires, the reply is never forwarded to
// /api/agent/inbound, and the double opt-in state machine sits at `a_invited`
// forever while the reply itself is plainly visible in the inbox.
//
// That failure is invisible from the app side (no inbound_events row is written —
// nothing ever arrived) and invisible from the mail client side (the reply looks
// sent). This script is the only place the two views meet.
//
//   npx tsx src/scripts/inspect-inbox.ts
//   LIMIT=50 npx tsx src/scripts/inspect-inbox.ts
//
// Env: AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID.

import "../lib/env";
import { AgentMailClient } from "agentmail";
import { AGENTMAIL_INBOX_ID } from "../lib/agentmail";

const LIMIT = Number(process.env.LIMIT ?? 40);

if (!process.env.AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY is required.");

const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });
const SELF = AGENTMAIL_INBOX_ID.toLowerCase();

interface Msg {
  from?: string;
  from_?: string;
  to?: string[];
  subject?: string;
  labels?: string[];
  messageId?: string;
  message_id?: string;
  threadId?: string;
  thread_id?: string;
  timestamp?: string | Date;
  createdAt?: string | Date;
  text?: string;
  preview?: string;
}

const res = (await client.inboxes.messages.list(AGENTMAIL_INBOX_ID, {
  limit: LIMIT,
})) as { messages?: Msg[]; count?: number };

const messages = res.messages ?? [];
console.log(`inbox=${AGENTMAIL_INBOX_ID}  returned=${messages.length}\n`);

let inboundCount = 0;
let unauthCount = 0;

for (const m of messages) {
  const from = String(m.from ?? m.from_ ?? "");
  const labels = m.labels ?? [];
  const outbound = from.toLowerCase().includes(SELF);
  const unauth = labels.some((l) => l.toLowerCase().includes("unauthenticated"));

  if (!outbound) inboundCount++;
  if (unauth) unauthCount++;

  const dir = outbound ? "OUT" : "IN ";
  const flag = unauth ? "  ⚠️  UNAUTHENTICATED" : "";
  const body = String(m.text ?? m.preview ?? "").replace(/\s+/g, " ").slice(0, 80);

  console.log(
    `[${dir}] ${String(m.timestamp ?? m.createdAt ?? "").slice(0, 19)}${flag}\n` +
      `      from=${from}\n` +
      `      to=${JSON.stringify(m.to ?? [])}\n` +
      `      subject=${String(m.subject ?? "").slice(0, 70)}\n` +
      `      labels=${JSON.stringify(labels)}\n` +
      `      thread=${m.threadId ?? m.thread_id}\n` +
      `      "${body}"\n`,
  );
}

console.log(
  `\n${inboundCount} inbound, ${unauthCount} labelled unauthenticated.` +
    (unauthCount
      ? `\n\nUnauthenticated mail does NOT raise message.received. Subscribe the webhook to\n` +
        `message.received.unauthenticated as well, or replay these by hand:\n` +
        `  npx tsx src/scripts/replay-inbound.ts --send`
      : ""),
);
