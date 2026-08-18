// Run one incremental Gmail sync pass from the command line, against the real
// database — the operator's "sync now" and the local test loop for gmail-sync.ts.
//
//   npx tsx src/scripts/sync-gmail.ts                       # oldest-synced accounts, up to 8
//   npx tsx src/scripts/sync-gmail.ts --sub <google_sub>    # one account
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID/SECRET,
// GOOGLE_TOKEN_ENC_KEY. Same code path as /api/cron/sync-gmail, minus HTTP.

import "../lib/env";
import { createClient } from "@supabase/supabase-js";
import { syncGmailForAccount } from "../lib/gmail-sync";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const subFlag = process.argv.indexOf("--sub");
const onlySub = subFlag !== -1 ? process.argv[subFlag + 1] : null;

async function main() {
  let subs: string[];
  if (onlySub) {
    subs = [onlySub];
  } else {
    const { data, error } = await db
      .from("gmail_sync_state")
      .select("google_sub")
      .not("history_id", "is", null)
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(8);
    if (error) throw new Error(error.message);
    subs = (data ?? []).map((row) => row.google_sub as string);
  }

  if (!subs.length) {
    console.log("No accounts with a sync baseline. Onboard someone first.");
    return;
  }

  for (const sub of subs) {
    const outcome = await syncGmailForAccount(db, sub, { deadline: Date.now() + 120_000 });
    console.log(JSON.stringify(outcome, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
