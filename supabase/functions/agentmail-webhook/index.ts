// Supabase Edge Function: agentmail-webhook
//
// Receives AgentMail webhook events (register it for `message.received`) and
// forwards inbound replies to the Next.js agent route, which does the slow LLM
// work of parsing the reply and advancing the introduction. We return 200
// immediately so AgentMail never times out or retries, and we drop `message.sent`
// so Dawn never reacts to its own outgoing mail (no reply loops).
//
// Deploy:  supabase functions deploy agentmail-webhook
// Register (once): client.webhooks.create({ url: "<function-url>", events: ["message.received"] })
//
// Secrets: APP_URL (base URL of the Next.js app), CRON_SECRET (shared bearer).

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
  if (eventType && eventType !== "message.received") {
    return json({ ok: true, ignored: eventType });
  }

  const appUrl = Deno.env.get("APP_URL");
  const secret = Deno.env.get("CRON_SECRET");

  if (appUrl && secret && payload) {
    const forward = fetch(`${appUrl}/api/agent/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
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
