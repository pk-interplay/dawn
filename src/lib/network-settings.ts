import type { SupabaseClient } from "@supabase/supabase-js";

// The network-wide experiment controls backed by the `network_settings` singleton
// (migration 0032). Read on every run-matches pass to decide whether to run at all
// and how far apart a given member's introductions may fall.

export interface NetworkSettings {
  /** Master switch. When false, the scheduled batch opens no introductions. */
  enabled: boolean;
  /**
   * Multiplier on each member's cadence window. Higher = more frequent: the
   * run-matches gate divides the per-member window (in days) by this number, so
   * 2.0 means "twice as often" and 0.5 means "half as often". 1.0 is a no-op.
   */
  intensity: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

// The UI offers this band; the DB constraint is wider (0.1–10) as a backstop. Kept
// here so the API route and the client agree on what "valid" means.
export const INTENSITY_MIN = 0.25;
export const INTENSITY_MAX = 4;

// Defaults are deliberately "the network as it behaved before this existed": on, and
// a 1.0 multiplier that leaves every cadence window untouched. Returned verbatim when
// the row (or the whole table) is missing, so the feature degrades to today's
// behaviour rather than to a stopped network if the migration hasn't been applied.
export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  enabled: true,
  intensity: 1,
  updatedAt: null,
  updatedBy: null,
};

// --- Hard-coded network switch -------------------------------------------------
// The network is forced OFF in code until migration 0032 (the network_settings
// table) is applied and the DB-backed switch is wired up. While this is true:
//   * run-matches short-circuits and opens no introductions (see route gate), and
//   * the admin panel reads/writes this forced value, so it shows OFF and any
//     Save snaps back to OFF instead of erroring on the missing table.
// Nothing can send email regardless (agentmail.ts is a no-op); this additionally
// stops the matching batch from running. To restore the real switch: apply 0032
// and set HARDCODE_NETWORK_OFF to false.
// Typed as boolean (not the literal `true`) so the DB-backed fallback below stays
// reachable to the compiler — flip to false to restore it without touching anything else.
const HARDCODE_NETWORK_OFF: boolean = true;

const NETWORK_OFF: NetworkSettings = {
  enabled: false,
  intensity: 1,
  updatedAt: null,
  updatedBy: null,
};

/** Clamp an untrusted number into the offered band, defaulting non-finite input to 1.0. */
export function clampIntensity(n: unknown): number {
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(value)) return 1;
  return Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, value));
}

/**
 * Read the singleton. Never throws: any error (table absent, row absent, transport)
 * resolves to DEFAULT_NETWORK_SETTINGS so callers can treat "no settings" as "run
 * normally" instead of having to special-case a stopped or crashing network.
 */
export async function readNetworkSettings(client: SupabaseClient): Promise<NetworkSettings> {
  // Forced off in code for now — see HARDCODE_NETWORK_OFF. Skips the table entirely,
  // so the missing network_settings table can't surface as an error either.
  if (HARDCODE_NETWORK_OFF) return NETWORK_OFF;
  try {
    const { data, error } = await client
      .from("network_settings")
      .select("enabled, intensity, updated_at, updated_by")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return DEFAULT_NETWORK_SETTINGS;
    return {
      enabled: Boolean(data.enabled),
      intensity: clampIntensity(data.intensity),
      updatedAt: data.updated_at ?? null,
      updatedBy: data.updated_by ?? null,
    };
  } catch {
    return DEFAULT_NETWORK_SETTINGS;
  }
}

/**
 * Persist a partial update to the singleton and return the stored result. Only the
 * fields present in `patch` change. `intensity` is clamped here too, so the DB
 * constraint is a backstop and never the thing a caller trips over.
 */
export async function writeNetworkSettings(
  client: SupabaseClient,
  patch: { enabled?: boolean; intensity?: number },
  updatedBy: string | null,
): Promise<NetworkSettings> {
  // Forced off in code for now — see HARDCODE_NETWORK_OFF. Ignore the patch and don't
  // touch the (unmigrated) table, so a Save from the admin panel returns OFF cleanly
  // instead of writing anything or failing on the missing table.
  if (HARDCODE_NETWORK_OFF) return NETWORK_OFF;

  const update: Record<string, unknown> = { id: true, updated_at: new Date().toISOString(), updated_by: updatedBy };
  if (patch.enabled !== undefined) update.enabled = Boolean(patch.enabled);
  if (patch.intensity !== undefined) update.intensity = clampIntensity(patch.intensity);

  const { data, error } = await client
    .from("network_settings")
    .upsert(update, { onConflict: "id" })
    .select("enabled, intensity, updated_at, updated_by")
    .single();
  if (error) throw new Error(error.message);
  return {
    enabled: Boolean(data.enabled),
    intensity: clampIntensity(data.intensity),
    updatedAt: data.updated_at ?? null,
    updatedBy: data.updated_by ?? null,
  };
}
