import { supabase } from "../lib/supabase";
import { syncProfileDownstream } from "../lib/profile-edit";

/**
 * Push every onboarded member's claims back through `syncProfileDownstream`.
 *
 * ## Why this needs to run once
 *
 * Until now, editing a profile changed claims and `entities.embedding` and nothing else.
 * The matching cron reads `people` and ranks on `people.embedding_offering` /
 * `embedding_looking_for`, which no edit path ever wrote — so every existing member is
 * being matched on whatever they said the day their row was created, and members who
 * arrived through Gmail onboarding have no `people` row at all and have never been
 * considered. project-person.ts closes that going forward; this closes it backwards.
 *
 * Without it, each member stays stale until they happen to open /profile and save.
 *
 * ## Cost
 *
 * First run is roughly one Haiku call (derive-asks) plus three embeddings per member,
 * which is why it wants `--yes` rather than running on a stray invocation. Re-runs are
 * cheaper by design: derive-asks no-ops when the evidence it stored still matches the
 * member's current ask, so only the embeddings repeat.
 *
 * Idempotent and resumable — it rewrites the same derived state rather than appending to
 * it, so an interrupted run is fixed by running it again.
 *
 *   npm run resync:profiles -- --yes
 *   npm run resync:profiles -- --yes --limit 5     # try a few first
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "";
}

async function main() {
  const limitArg = arg("limit");
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limitArg && (!Number.isFinite(limit) || limit! <= 0)) {
    throw new Error(`--limit must be a positive number, got "${limitArg}"`);
  }

  // Onboarded only. An entity without `onboarded_at` is a contact someone synced from
  // their mailbox, not a member — projecting those into `people` would enrol hundreds of
  // people who never signed up into the pool the matcher draws from.
  let query = supabase
    .from("entities")
    .select("id, display_name")
    .not("onboarded_at", "is", null)
    .order("onboarded_at", { ascending: true });
  if (limit) query = query.limit(limit);

  const { data: entities, error } = await query;
  if (error) throw error;
  if (!entities?.length) {
    console.log("No onboarded entities to resync.");
    return;
  }

  if (arg("yes") === undefined) {
    console.log(
      `${entities.length} onboarded member(s) would be resynced.\n` +
        `That is about ${entities.length} Haiku call(s) and ${entities.length * 3} embeddings.\n` +
        `Re-run with --yes to go ahead.`,
    );
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  const partial: string[] = [];

  for (const entity of entities) {
    const label = (entity.display_name as string | null) ?? entity.id;
    try {
      // Each of the three steps is caught internally, so this resolves even when one
      // fails — the result is what says whether it actually landed. The projection is
      // the step that matters here; the other two are recoverable by other scripts.
      const result = await syncProfileDownstream(supabase, entity.id);
      if (result.projected) {
        ok++;
        console.log(
          `${label} — projected${result.asksDerived ? ", asks derived" : ""}` +
            `${result.summarized ? "" : ", SUMMARY FAILED"}`,
        );
      } else {
        // Not thrown, so it will not appear in `failed` — but a member whose row was not
        // written is exactly who this script exists for, and must not be reported as done.
        partial.push(`${label}: projection did not land (see the logged error above)`);
      }
    } catch (err) {
      // One bad member must not abort the batch — same posture as summarize-entities.ts
      // and intro-flow.ts's send batch.
      failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nResynced ${ok}/${entities.length} member(s).`);
  if (partial.length) {
    console.log(`\nNot projected (${partial.length}):`);
    for (const p of partial) console.log(`  ${p}`);
  }
  if (failed.length) {
    console.log(`\nFailed (${failed.length}):`);
    for (const f of failed) console.log(`  ${f}`);
  }
  if (partial.length || failed.length) {
    console.log(`\nRe-run to retry — this script is idempotent.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
