// Supabase Edge Function: agentmail-webhook
//
// Receives AgentMail webhook events and forwards inbound replies to the Next.js
// agent route, which does the slow LLM work of parsing the reply and advancing the
// introduction. We return 200 immediately so AgentMail never times out or retries,
// and we drop `message.sent` so Dawn never reacts to its own outgoing mail (no
// reply loops).
//
// Deploy:  supabase functions deploy agentmail-webhook
// Register (once): npx tsx src/scripts/webhooks.ts --create "<function-url>"
//
// Secrets: APP_URL (base URL of the Next.js app), CRON_SECRET (shared bearer).

// AgentMail authenticates inbound mail and splits the result across TWO events.
// Mail whose SPF/DKIM/DMARC headers are absent is delivered with an
// `unauthenticated` label and raises `message.received.unauthenticated` — NOT
// `message.received`. Forwarding only the latter is indistinguishable from the
// webhook being down for any sender whose domain doesn't publish SPF/DKIM: the
// reply is visibly in the inbox, no `inbound_events` row is ever written, and the
// introduction sits at `a_invited` forever.
//
// Both are forwarded to the same route. Authentication is a deliverability signal,
// not an identity check, and triage does not trust the From address on its own
// anyway — it resolves the sender against the thread's known recipient.
const FORWARDED_EVENTS = new Set([
  "message.received",
  "message.received.unauthenticated",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = await req.json();
  } catch {
    payload = null;
  }

  const eventType = (payload?.event_type ?? payload?.type) as string | undefined;
  if (eventType && !FORWARDED_EVENTS.has(eventType)) {
    return json({ ok: true, ignored: eventType });
  }

  // Pass the authentication verdict downstream rather than discarding it. The route
  // cannot re-derive this — by the time it sees the payload the original SPF/DKIM
  // headers are gone — and it needs it, because an unauthenticated sender's From
  // address is forgeable and must not be trusted on its own.
  const authenticated = eventType !== "message.received.unauthenticated";

  const appUrl = Deno.env.get("APP_URL");
  const secret = Deno.env.get("CRON_SECRET");

  if (appUrl && secret && payload) {
    const forward = fetch(`${appUrl}/api/agent/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ ...payload, authenticated }),
    }).catch((e) => console.error("[agentmail-webhook] forward failed:", e));

    // Process in the background; respond 200 right away.
    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime;
    if (runtime?.waitUntil) runtime.waitUntil(forward);
  } else {
    console.warn("[agentmail-webhook] APP_URL/CRON_SECRET not set — cannot forward inbound email.");
  }

  return json({ ok: true });
});
