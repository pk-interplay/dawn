/**
 * Clears ONE person out of the graph, by email — the "let me onboard again from
 * scratch" button, and the targeted counterpart to reset-graph.ts.
 *
 * reset-graph is all-or-nothing, which is the wrong tool when some of the accounts in
 * a shared graph are real users and some are test runs. This takes an address, resolves
 * it to the entity holding it as a live `email` claim, and removes that entity and
 * everything keyed to it.
 *
 * What it deletes, in dependency order: the chat messages under their threads, their
 * threads, asks, staged profile draft, people_entity_map row, every claim about them,
 * every edge in either direction, the entity itself, and the legacy `people` row
 * carrying the same address.
 *
 * What it deliberately leaves alone:
 *   - The contact entities their ingest created. Those are the graph, not the account —
 *     other members' edges point at them, and a re-onboard is supposed to resolve them
 *     rather than mint duplicates (the adoption path in entity-identity.ts). Deleting
 *     them here would quietly vandalise everyone else's network.
 *   - `workspaces` and `network_settings`, for the reasons reset-graph.ts spells out.
 *
 * Auth needs no cleanup: NextAuth runs JWT-only with no database adapter, so signing in
 * again after this creates a fresh entity and stamps `auth_user_id` onto it.
 *
 * Requires `--yes`, same as reset-graph: this is irreversible and should not be a
 * muscle-memory command.
 *
 *   npm run reset:user -- --email someone@example.com --yes
 */
import { supabase } from "../lib/supabase";
import { findEntityIdByEmail } from "../lib/claims";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function countOf(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value);
  return error ? 0 : (count ?? 0);
}

async function resetOne(email: string, dryRun: boolean) {
  const entityId = await findEntityIdByEmail(supabase, email);
  if (!entityId) {
    console.log(`\n${email}: no entity holds this address — nothing to do.`);
    return;
  }

  const { data: entity } = await supabase
    .from("entities")
    .select("display_name, onboarded_at, auth_user_id")
    .eq("id", entityId)
    .maybeSingle();

  console.log(`\n${email} → ${entityId}`);
  console.log(`  display_name  ${entity?.display_name ?? "(none)"}`);
  console.log(`  onboarded_at  ${entity?.onboarded_at ?? "(never)"}`);

  const threads = await supabase.from("chat_threads").select("id").eq("entity_id", entityId);
  const threadIds = (threads.data ?? []).map((t) => t.id as string);

  const counts = {
    claims: await countOf("claims", "subject_id", entityId),
    "edges (from)": await countOf("edges", "from_id", entityId),
    "edges (to)": await countOf("edges", "to_id", entityId),
    chat_threads: threadIds.length,
    asks: await countOf("asks", "entity_id", entityId),
    profile_drafts: await countOf("profile_drafts", "entity_id", entityId),
    people_entity_map: await countOf("people_entity_map", "entity_id", entityId),
  };
  for (const [label, count] of Object.entries(counts)) {
    if (count) console.log(`  ${label.padEnd(18)} ${count}`);
  }

  if (dryRun) {
    console.log("  (dry run — nothing deleted)");
    return;
  }

  const fail = (label: string, error: { message: string } | null) => {
    if (error) console.error(`  ! ${label}: ${error.message}`);
  };

  if (threadIds.length) {
    fail(
      "chat_messages",
      (await supabase.from("chat_messages").delete().in("thread_id", threadIds)).error,
    );
  }
  fail("chat_threads", (await supabase.from("chat_threads").delete().eq("entity_id", entityId)).error);
  fail("asks", (await supabase.from("asks").delete().eq("entity_id", entityId)).error);
  fail(
    "profile_drafts",
    (await supabase.from("profile_drafts").delete().eq("entity_id", entityId)).error,
  );
  fail(
    "people_entity_map",
    (await supabase.from("people_entity_map").delete().eq("entity_id", entityId)).error,
  );
  // Claims before the entity: the FK points this way, and an orphaned claim would keep
  // the address resolvable to a row that no longer exists.
  fail("claims", (await supabase.from("claims").delete().eq("subject_id", entityId)).error);
  fail("edges (from)", (await supabase.from("edges").delete().eq("from_id", entityId)).error);
  fail("edges (to)", (await supabase.from("edges").delete().eq("to_id", entityId)).error);
  fail("entities", (await supabase.from("entities").delete().eq("id", entityId)).error);
  // The legacy projection carries the same address and is matched on it downstream.
  fail("people", (await supabase.from("people").delete().ilike("email", email)).error);

  const survivors = await countOf("claims", "subject_id", entityId);
  console.log(survivors === 0 ? "  cleared." : `  ${survivors} claims survived — see errors above.`);
}

async function main() {
  const emails = process.argv
    .flatMap((arg, i) => (arg === "--email" ? [process.argv[i + 1]] : []))
    .filter(Boolean);

  if (!emails.length) {
    console.error(
      "reset-user removes one person and everything keyed to them, by email.\n" +
        "  npm run reset:user -- --email someone@example.com --yes\n" +
        "Pass --email more than once to clear several. Omit --yes for a dry run.",
    );
    process.exit(1);
  }

  const dryRun = !process.argv.includes("--yes");
  if (dryRun) console.log("DRY RUN — pass --yes to actually delete.\n");

  for (const email of emails) {
    await resetOne(email.trim().toLowerCase(), dryRun);
  }

  console.log(
    "\nContact entities created by these ingests were left in place — they are shared" +
      "\ngraph data, and a re-onboard is meant to resolve them rather than duplicate them.",
  );
}

main();
