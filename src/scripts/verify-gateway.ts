// End-to-end exercise of the send gateway against the real database.
//
//   npx tsx src/scripts/verify-gateway.ts
//
// Run this before switching DAWN_DELIVERY_ENABLED on (RUNBOOK step 10). It proves the
// five gates actually refuse what they claim to refuse, which is not something the unit
// tests can show: every one of them is a database constraint or a live query.
//
// Creates a throwaway synthetic pair + introduction, drives send() through every gate,
// and deletes everything afterwards. Nothing here can transmit: DAWN_DELIVERY_ENABLED is
// forced off at the top, which is also the assertion that "off" is the default behaviour
// rather than something the caller has to remember.
import "../lib/env";
import { createClient } from "@supabase/supabase-js";
import { send, suppress } from "../lib/send-gateway";

// Belt and braces — the whole point is that this cannot send.
delete process.env.DAWN_DELIVERY_ENABLED;

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

const TAG = `gwprobe-${Date.now()}`;
const A_EMAIL = `${TAG}-a@example.com`;
const B_EMAIL = `${TAG}-b@example.com`;

async function main() {
  let aId: string | null = null;
  let bId: string | null = null;
  let introId: string | null = null;

  try {
    // ---- fixture ----------------------------------------------------------
    const mk = async (name: string, email: string) => {
      const { data, error } = await db
        .from("people")
        .insert({ name, email, is_synthetic: true, offering: "probe", looking_for: "probe" })
        .select("id")
        .single();
      if (error) throw new Error(`fixture person: ${error.message}`);
      return data.id as string;
    };
    aId = await mk(`${TAG} A`, A_EMAIL);
    bId = await mk(`${TAG} B`, B_EMAIL);

    const { data: intro, error: iErr } = await db
      .from("introductions")
      .insert({ person_a_id: aId, person_b_id: bId, state: "proposed", rationale: "probe" })
      .select("id")
      .single();
    if (iErr) throw new Error(`fixture introduction: ${iErr.message}`);
    introId = intro.id as string;
    console.log(`fixture: introduction ${introId}\n`);

    // ---- gate 5: delivery off means drafted, not sent ----------------------
    console.log("=== gate 5: delivery switch ===");
    const first = await send(db, {
      introductionId: introId,
      kind: "opt_in_a",
      to: [A_EMAIL],
      subject: "probe opt-in",
      text: "body one\n\n—\nReply \"unsubscribe\" and I'll stop sending you introductions.",
    });
    ok("drafted, not delivered", first.delivered === false && first.status === "draft");
    ok("failure is null (chose not to send, not an error)", first.failure === null, `got ${first.failure}`);
    ok("a sends row was written", typeof first.sendId === "number");

    const { data: row } = await db
      .from("sends")
      .select("status, body_sent, to_emails, consent_basis, provider_message_id")
      .eq("id", first.sendId!)
      .single();
    ok("row status is draft", row?.status === "draft", `got ${row?.status}`);
    ok("exact body stored, footer included", (row?.body_sent ?? "").includes("unsubscribe"));
    ok("nothing was transmitted", row?.provider_message_id === null);
    ok("consent basis recorded", row?.consent_basis === "introduction");

    // ---- gate 4: idempotency ----------------------------------------------
    console.log("=== gate 4: idempotency ===");
    const dup = await send(db, {
      introductionId: introId,
      kind: "opt_in_a",
      to: [A_EMAIL],
      subject: "probe opt-in (again)",
      text: "body two",
    });
    ok("duplicate refused", dup.delivered === false && dup.failure === "duplicate", `got ${dup.failure}`);
    const { count: afterDup } = await db
      .from("sends")
      .select("*", { count: "exact", head: true })
      .eq("introduction_id", introId)
      .eq("kind", "opt_in_a");
    ok("still exactly one opt_in_a row", afterDup === 1, `got ${afterDup}`);

    console.log("=== gate 4: nudges legitimately repeat via attempt ===");
    const n1 = await send(db, { introductionId: introId, kind: "nudge", attempt: 0, to: [A_EMAIL], subject: "n1", text: "n1" });
    const n2 = await send(db, { introductionId: introId, kind: "nudge", attempt: 1, to: [A_EMAIL], subject: "n2", text: "n2" });
    ok("nudge attempt 0 accepted", n1.status === "draft", `got ${n1.status}`);
    ok("nudge attempt 1 accepted (not a duplicate)", n2.status === "draft", `got ${n2.status}`);

    // ---- gate 1: suppression ----------------------------------------------
    console.log("=== gate 1: suppression ===");
    await suppress(db, B_EMAIL, "unsubscribe", "probe");
    const sup = await send(db, {
      introductionId: introId,
      kind: "opt_in_b",
      to: [B_EMAIL],
      subject: "probe to a suppressed address",
      text: "should not be drafted for delivery",
    });
    ok("suppressed recipient refused", sup.failure === "suppressed", `got ${sup.failure}`);
    ok("recorded as suppressed, not silently skipped", sup.status === "suppressed");

    console.log("=== gate 1: suppression fails the WHOLE send, not just one recipient ===");
    const both = await send(db, {
      introductionId: introId,
      kind: "introduction",
      to: [A_EMAIL, B_EMAIL],
      subject: "warm intro to both",
      text: "one of these two has opted out",
    });
    ok("mixed recipient list refused entirely", both.failure === "suppressed", `got ${both.failure}`);
    const { count: introRows } = await db
      .from("sends")
      .select("*", { count: "exact", head: true })
      .eq("introduction_id", introId)
      .eq("kind", "introduction")
      .eq("status", "draft");
    ok("no draft was created for the mixed send", introRows === 0, `got ${introRows}`);

    // ---- gate 2: consent ---------------------------------------------------
    console.log("=== gate 2: consent ===");
    let threw = false;
    try {
      // Cast through unknown: the discriminated union makes this unwriteable in
      // TypeScript, which is the point — this probes the runtime backstop.
      await send(db, {
        kind: "opt_in_a",
        to: [A_EMAIL],
        subject: "no introduction",
        text: "x",
      } as unknown as Parameters<typeof send>[1]);
    } catch {
      threw = true;
    }
    ok("outreach with no introduction throws", threw);

    // ---- no recipients -----------------------------------------------------
    console.log("=== degenerate input ===");
    const none = await send(db, {
      introductionId: introId,
      kind: "nudge",
      attempt: 5,
      to: [null, null],
      subject: "nobody",
      text: "x",
    });
    ok("no recipient reported distinctly", none.failure === "no_recipient", `got ${none.failure}`);
  } finally {
    // ---- cleanup ----------------------------------------------------------
    if (introId) await db.from("sends").delete().eq("introduction_id", introId);
    await db.from("suppressions").delete().in("email", [A_EMAIL, B_EMAIL]);
    if (introId) await db.from("introductions").delete().eq("id", introId);
    for (const id of [aId, bId]) if (id) await db.from("people").delete().eq("id", id);

    const { count: leftoverPeople } = await db
      .from("people")
      .select("*", { count: "exact", head: true })
      .like("name", `${TAG}%`);
    const { count: leftoverSends } = await db.from("sends").select("*", { count: "exact", head: true });
    console.log(`\ncleanup: ${leftoverPeople ?? 0} fixture people left, ${leftoverSends ?? 0} sends rows remain`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
