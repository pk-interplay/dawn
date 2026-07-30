// Post a single inbound reply straight at a running /api/agent/inbound, exactly as
// the AgentMail webhook Edge Function would.
//
// This is the sibling of replay-inbound.ts, and it exists for the case that script
// cannot cover: replies that never reached the AgentMail inbox at all. AgentMail
// authenticates inbound mail (SPF/DKIM/DMARC) and a domain publishing neither SPF
// nor DKIM has its replies labelled `unauthenticated` — which raises
// `message.received.unauthenticated`, not `message.received`. replay-inbound can
// only forward what is sitting in the inbox; when nothing is, this types the reply
// for you so the double opt-in state machine can still be exercised end to end.
//
// Everything downstream is real: real triage, real LLM intent classification, real
// state transitions, real outbound email.
//
//   npx tsx src/scripts/simulate-reply.ts --thread <thread_id> --from <email> --text "yes please"
//
// Env: CRON_SECRET, LOCAL_APP_URL (default http://localhost:3000).

import "../lib/env";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const APP = (process.env.LOCAL_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
const threadId = arg("thread");
const from = arg("from");
const text = arg("text");
const subject = arg("subject") ?? "Re: intro";

if (!SECRET) throw new Error("CRON_SECRET is required — /api/agent/inbound would 401.");
if (!threadId || !from || !text) {
  throw new Error('Usage: --thread <id> --from <email> --text "..." [--subject "..."]');
}

// Unique per run so the route's replay guard (one inbound_events row per message id)
// treats each simulated reply as a new message rather than a retry.
const messageId = `sim-${threadId.slice(0, 8)}-${process.hrtime.bigint()}@simulated.local`;

// --unauthenticated reproduces a sender whose domain publishes no passing SPF/DKIM.
// AgentMail delivers that mail under a different event, and Dawn only lets it act
// inside a thread Dawn itself opened with that person.
const unauth = process.argv.includes("--unauthenticated");

const body = {
  event_type: unauth ? "message.received.unauthenticated" : "message.received",
  authenticated: !unauth,
  message: {
    inbox_id: process.env.AGENTMAIL_INBOX_ID ?? "dawnagent@agentmail.to",
    message_id: messageId,
    thread_id: threadId,
    from,
    subject,
    text,
  },
};

const res = await fetch(`${APP}/api/agent/inbound`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
  body: JSON.stringify(body),
});

const out = await res.text();
console.log(`→ ${from} on thread ${threadId} (HTTP ${res.status})`);
try {
  console.log(JSON.stringify(JSON.parse(out), null, 2));
} catch {
  console.log(out.slice(0, 1000));
}
