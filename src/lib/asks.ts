import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Asks: what someone says they want, in their own words.
 *
 * Deliberately not claims. See the header of migration 0038 and SPEC §10 — an ask is a
 * want, not an attribute. It expires, it gets acted on, and it says nothing about who
 * the person is, so it must not enter the controlled vocabulary the matching layer
 * reads as ground truth.
 *
 * The onboarding confirm screen seeds a text box with the model's `suggestedIntros` and
 * lets the person edit them. Only what comes back from that box is written here, and
 * only as text they authored — an untouched suggestion is still a guess, and the
 * `authored` column exists so a later matching pass can tell the two apart.
 */

/** One ask per line. Blank lines and bullet leaders are noise from a seeded textarea. */
export function parseAsks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Strip the "· " / "- " / "• " leaders the box is seeded with, so a user who edits
    // around them doesn't store the bullet as part of their ask.
    const line = raw.replace(/^\s*[·•\-*]\s*/, "").trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    // A profile is not a backlog; past this the box is being used for something else.
    if (out.length >= MAX_ASKS) break;
  }
  return out;
}

export const MAX_ASKS = 12;
/** Long enough for a real sentence, short enough not to be a bio in disguise. */
export const MAX_ASK_LENGTH = 280;

export async function writeAsks(
  client: SupabaseClient,
  opts: { entityId: string; asks: string[]; source?: string },
): Promise<{ written: number }> {
  const rows = opts.asks
    .map((body) => body.trim().slice(0, MAX_ASK_LENGTH))
    .filter(Boolean)
    .map((body) => ({
      entity_id: opts.entityId,
      body,
      source: opts.source ?? "onboarding",
      authored: true,
    }));

  if (!rows.length) return { written: 0 };

  const { data, error } = await client.from("asks").insert(rows).select("id");
  if (error) throw new Error(`writeAsks failed: ${error.message}`);
  return { written: data?.length ?? 0 };
}

/** Live asks for one person, newest first. */
export async function listAsks(
  client: SupabaseClient,
  entityId: string,
): Promise<{ id: string; body: string; createdAt: string }[]> {
  const { data, error } = await client
    .from("asks")
    .select("id, body, created_at")
    .eq("entity_id", entityId)
    .is("fulfilled_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listAsks failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    body: r.body as string,
    createdAt: r.created_at as string,
  }));
}
