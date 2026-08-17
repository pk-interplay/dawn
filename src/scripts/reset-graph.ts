/**
 * Clears the claims graph and chat history — the prelaunch "start over" button.
 *
 * What it deletes: every row of user-derived data (entities and everything that
 * cascades off it, chat threads, and the tables that can hold orphans).
 *
 * What it deliberately keeps:
 *   - `workspaces`. This is a *fixed singleton row*, not user data: migration 0026
 *     defaults `workspace_id` on entities/claims/edges to `current_workspace_id()`,
 *     which reads that row. Deleting it doesn't reset the graph, it breaks every
 *     subsequent insert.
 *   - `network_settings`. Also a singleton, and network-settings.ts already treats a
 *     missing row as "network off" — wiping it changes product behaviour rather than
 *     clearing data.
 *
 * Requires `--yes`, because the whole point of this file is that it is destructive
 * and a bare `npm run reset:graph` should not be able to fire by muscle memory.
 */
import { supabase } from "../lib/supabase";

/**
 * Deletion order is dependency order. Most of these cascade from `entities`
 * anyway, but naming each one means an orphaned row (from a migration that landed
 * after its parent's cascade, say) still gets cleared instead of silently surviving.
 */
/**
 * Each entry is [table, key column]. The key column is only there because Supabase
 * requires a filter on delete and not every table has an `id`: profile_drafts is
 * keyed by `entity_id` (migration 0029) and people_entity_map by `person_id`
 * (0028). Getting this wrong fails loudly per-table rather than silently skipping,
 * but it is still worth getting right.
 */
const TABLES_IN_DELETE_ORDER: [table: string, key: string][] = [
  ["chat_messages", "id"],
  ["chat_threads", "id"],
  ["agent_notes", "id"],
  ["asks", "id"],
  ["profile_drafts", "entity_id"],
  ["claims", "id"],
  ["edges", "id"],
  ["entity_links", "id"],
  ["people_entity_map", "person_id"],
  ["matches", "id"],
  ["sends", "id"],
  ["inbound_events", "id"],
  ["entities", "id"],
];

async function countOf(table: string): Promise<number | null> {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  return error ? null : (count ?? 0);
}

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "reset-graph deletes the entire claims graph and chat history.\n" +
        "Re-run with --yes to confirm:  npm run reset:graph -- --yes",
    );
    process.exit(1);
  }

  console.log("before:");
  const before: Record<string, number | null> = {};
  for (const [table] of TABLES_IN_DELETE_ORDER) {
    before[table] = await countOf(table);
    if (before[table]) console.log(`  ${table.padEnd(20)} ${before[table]}`);
  }

  for (const [table, key] of TABLES_IN_DELETE_ORDER) {
    if (before[table] === null) continue; // table absent — nothing to clear
    // Supabase requires a filter on delete; `<key> is not null` is the "all rows" form.
    const { error } = await supabase.from(table).delete().not(key, "is", null);
    if (error) console.error(`  ! ${table}: ${error.message}`);
  }

  console.log("\nafter:");
  let remaining = 0;
  for (const [table] of TABLES_IN_DELETE_ORDER) {
    const count = await countOf(table);
    if (count) {
      console.log(`  ${table.padEnd(20)} ${count}`);
      remaining += count;
    }
  }
  console.log(remaining === 0 ? "  (all clear)" : `\n${remaining} rows survived — see errors above.`);

  // Proof the singletons the app depends on are still standing.
  for (const table of ["workspaces", "network_settings"]) {
    console.log(`kept ${table}: ${await countOf(table)} row(s)`);
  }
}

main();
