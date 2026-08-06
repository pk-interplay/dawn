import { supabase } from "../lib/supabase";
import { summarizeEntity } from "../lib/summarize-entity";

/**
 * Nexus v0.2 build step 3 (SPEC.md §7 step 3). Batch backfill: every entity
 * with no summary/embedding yet gets one via summarize_entity. Mirrors
 * match.ts's shape. Run after backfill-entities-from-people.ts so migrated
 * entities get a claims-derived embedding rather than keeping `people`'s two
 * directional embeddings (which don't fit the single-column schema — see
 * migration 0027's comment).
 */
async function main() {
  const { data: entities, error } = await supabase.from("entities").select("id, display_name").is("embedding", null);
  if (error) throw error;
  if (!entities?.length) {
    console.log("No entities need summarizing.");
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const entity of entities) {
    try {
      await summarizeEntity(supabase, entity.id);
      ok++;
      console.log(`Summarized ${entity.display_name ?? entity.id}`);
    } catch (err) {
      // One bad entity must not abort the batch — same posture as
      // intro-flow.ts's send batch and network-ingest.ts's per-contact loop.
      failed.push(`${entity.display_name ?? entity.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nSummarized ${ok}/${entities.length} entities.`);
  if (failed.length) {
    console.log(`\nFailed (${failed.length}):`);
    for (const f of failed) console.log(`  ${f}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
