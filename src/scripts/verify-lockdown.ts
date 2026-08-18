// Prove the publishable (anon) key is dead and the open routes are gated.
//
//   npx tsx src/scripts/verify-lockdown.ts
//
// Run BEFORE applying migration 0041 to capture the baseline (expect loud
// failures — that is the hole being closed), and AFTER to prove the lockdown:
// every table read/write with the publishable key must fail or return nothing,
// every RPC must refuse, and the once-open HTTP routes must 401/403 without a
// session.
//
// Env: SUPABASE_URL, VERIFY_PUBLISHABLE_KEY (the old publishable key — kept out
// of normal env on purpose; falls back to SUPABASE_PUBLISHABLE_KEY if that is
// still set locally). Optional: APP_URL + CRON_SECRET + INBOUND_WEBHOOK_SECRET
// for the HTTP probes; they are skipped when APP_URL is unset.

import "../lib/env";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.VERIFY_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
if (!url || !anonKey) {
  throw new Error("SUPABASE_URL and VERIFY_PUBLISHABLE_KEY (the old publishable key) are required.");
}

const anon = createClient(url, anonKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

// Every table in the schema (see 0041 for the RLS treatment of each), plus the
// resolved_attributes view.
const TABLES = [
  "agent_notes", "asks", "chat_messages", "chat_threads", "claims",
  "conversations", "edges", "entities", "entity_links", "inbound_events",
  "interactions", "introductions", "intros", "leads", "matches", "messages",
  "network_settings", "people", "people_entity_map", "person_preferences",
  "profile_drafts", "relationships", "sends", "suppressions", "workspaces",
  "resolved_attributes",
];

async function probeTables() {
  console.log("\nTable probes with the publishable key (all must deny):");
  for (const table of TABLES) {
    const { data, error } = await anon.from(table).select("*").limit(1);
    // RLS-with-no-policies yields an empty result rather than an error; the
    // revoked grants (0041 §3) upgrade that to a loud permission error. Either
    // is a pass — what fails is a row coming back.
    ok(`select ${table}`, Boolean(error) || (data ?? []).length === 0,
      error ? "" : `returned ${data?.length} row(s)`);

    const { error: insErr } = await anon.from(table).insert({});
    ok(`insert ${table}`, Boolean(insErr), "insert was accepted");
  }
}

async function probeRpcs() {
  console.log("\nRPC probes with the publishable key (all must deny or return nothing):");
  const zeros = new Array(1536).fill(0);
  const probes: [string, Record<string, unknown>][] = [
    ["match_people_by_offering", { query_embedding: zeros, exclude_id: "00000000-0000-0000-0000-000000000000", match_count: 1, query_tags_embedding: null }],
    ["match_entities", { query_embedding: zeros, match_count: 1 }],
  ];
  for (const [fn, args] of probes) {
    const { data, error } = await anon.rpc(fn, args);
    ok(`rpc ${fn}`, Boolean(error) || !data || (Array.isArray(data) && data.length === 0),
      error ? "" : "returned rows");
  }
}

async function probeHttp() {
  const app = process.env.APP_URL?.replace(/\/$/, "");
  if (!app) {
    console.log("\nAPP_URL unset — skipping HTTP probes.");
    return;
  }
  console.log(`\nHTTP probes against ${app} (no session cookie — all must refuse):`);

  const expectDenied = async (name: string, path: string, init?: RequestInit) => {
    const res = await fetch(`${app}${path}`, { ...init, redirect: "manual" });
    // 401/403 from the gate; 3xx counts too (a redirect to sign-in, not data).
    ok(name, res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400),
      `got ${res.status}`);
  };

  await expectDenied("GET /api/people", "/api/people");
  await expectDenied("GET /api/people/search", "/api/people/search?q=a");
  await expectDenied("POST /api/find", "/api/find", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "probe" }),
  });
  const anyUuid = "00000000-0000-0000-0000-000000000001";
  await expectDenied("GET /api/people/[id]/matches", `/api/people/${anyUuid}/matches`);
  await expectDenied("POST /api/people/[id]/matches", `/api/people/${anyUuid}/matches`, { method: "POST" });
  await expectDenied("PATCH /api/match-status", "/api/match-status", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: anyUuid, status: "accepted" }),
  });

  // The inbound webhook: no header, wrong bearer, and the CRON secret (the old
  // cross-use this split exists to end) must all 401.
  const inbound = (name: string, headers: Record<string, string>) =>
    fetch(`${app}/api/agent/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ event_type: "message.received", message: { message_id: `probe-${Date.now()}`, from: "probe@example.com", text: "probe" } }),
    }).then((res) => ({ name, status: res.status }));

  const noHeader = await inbound("inbound: no header", {});
  ok(noHeader.name, noHeader.status === 401, `got ${noHeader.status}`);
  const wrong = await inbound("inbound: wrong bearer", { Authorization: "Bearer wrong" });
  ok(wrong.name, wrong.status === 401, `got ${wrong.status}`);
  if (process.env.CRON_SECRET) {
    const cross = await inbound("inbound: CRON_SECRET refused", { Authorization: `Bearer ${process.env.CRON_SECRET}` });
    ok(cross.name, cross.status === 401, `got ${cross.status}`);
  }
  if (process.env.CRON_SECRET) {
    const res = await fetch(`${app}/api/cron/run-matches`, { headers: { Authorization: "Bearer wrong" } });
    ok("cron: wrong bearer refused", res.status === 401, `got ${res.status}`);
  }
}

async function main() {
  await probeTables();
  await probeRpcs();
  await probeHttp();
  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
