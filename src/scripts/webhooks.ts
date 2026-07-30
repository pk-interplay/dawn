// List (and optionally register) AgentMail webhooks.
//
//   npx tsx src/scripts/webhooks.ts                     # list
//   npx tsx src/scripts/webhooks.ts --create <url>      # register for both received events
//
// Registers BOTH `message.received` and `message.received.unauthenticated`. The
// second is not optional here: AgentMail labels inbound mail `unauthenticated` when
// the sending domain publishes no passing SPF/DKIM, and routes it to that separate
// event. A webhook subscribed only to `message.received` silently never fires for
// those senders.
import "../lib/env";
import { AgentMailClient } from "agentmail";

const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
const createIdx = process.argv.indexOf("--create");
const createUrl = createIdx >= 0 ? process.argv[createIdx + 1] : null;
const deleteIdx = process.argv.indexOf("--delete");
const deleteId = deleteIdx >= 0 ? process.argv[deleteIdx + 1] : null;

// Deleting matters more than it looks: two webhooks on the same URL means AgentMail
// delivers every message twice. Dawn survives that (the `inbound_events` replay guard
// drops the second), but it doubles the inbound rate-limit budget each member burns.
if (deleteId) {
  await (client as any).webhooks.delete(deleteId);
  console.log(`deleted ${deleteId}`);
}

const BOTH = ["message.received", "message.received.unauthenticated"];

if (createUrl) {
  try {
    const res = await (client as any).webhooks.create({ url: createUrl, eventTypes: BOTH });
    console.log("created (both events):", JSON.stringify(res, null, 2));
  } catch (err) {
    // Subscribing to the unauthenticated event requires the `label_unauthenticated_read`
    // permission, which restricted API keys don't carry. Fall back rather than leaving
    // NO webhook registered at all: authenticated senders are the majority and should
    // start working immediately, while the operator mints a broader key for the rest.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("label_unauthenticated_read")) throw err;
    console.warn(
      "!! This API key lacks 'label_unauthenticated_read', so it cannot subscribe to\n" +
        "   message.received.unauthenticated. Registering message.received only.\n" +
        "   Replies from domains without SPF/DKIM will still be dropped until you mint\n" +
        "   an org-scoped key at https://console.agentmail.to and re-run this.\n",
    );
    const res = await (client as any).webhooks.create({
      url: createUrl,
      eventTypes: ["message.received"],
    });
    console.log("created (authenticated only):", JSON.stringify(res, null, 2));
  }
}

const list = (await (client as any).webhooks.list()) as any;
console.log(JSON.stringify(list, null, 2));
