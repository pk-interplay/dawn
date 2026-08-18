import "./src/lib/env";
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function check(table: string, column = "*"): Promise<string> {
  const { error } = await db.from(table).select(column, { count: "exact", head: true });
  return `${table}${column === "*" ? "" : "." + column}: ${error ? "MISSING (" + error.message + ")" : "ok"}`;
}

async function main() {
  const checks = await Promise.all([
    check("llm_usage"), // 0042
    check("google_accounts"), // 0043
    check("gmail_sync_state"), // 0043
    check("gmail_sync_state", "backfill_before"), // 0045 — expect MISSING
  ]);
  console.log(checks.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
