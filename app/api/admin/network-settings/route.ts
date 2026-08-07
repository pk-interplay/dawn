import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import { requireAdmin } from "../../../lib/admin-auth";
import {
  INTENSITY_MAX,
  INTENSITY_MIN,
  readNetworkSettings,
  writeNetworkSettings,
} from "../../../../src/lib/network-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read/write the network-wide experiment controls (enabled + cadence intensity).
// Both guarded by requireAdmin — the same allowlist as every other /api/admin route.

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const settings = await readNetworkSettings(db);
  return NextResponse.json({ settings, bounds: { min: INTENSITY_MIN, max: INTENSITY_MAX } });
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { enabled?: unknown; intensity?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  // Accept a partial patch: send only what changed. Reject the wrong TYPE (a caller
  // bug worth surfacing) but let writeNetworkSettings clamp an out-of-range
  // intensity rather than 400 on it — a slider that overshoots the band shouldn't
  // fail, it should land at the edge.
  const patch: { enabled?: boolean; intensity?: number } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    patch.enabled = body.enabled;
  }
  if (body.intensity !== undefined) {
    const n = Number(body.intensity);
    if (!Number.isFinite(n)) {
      return NextResponse.json({ error: "intensity must be a number" }, { status: 400 });
    }
    patch.intensity = n;
  }
  if (patch.enabled === undefined && patch.intensity === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const settings = await writeNetworkSettings(db, patch, auth.email);
    return NextResponse.json({ settings, bounds: { min: INTENSITY_MIN, max: INTENSITY_MAX } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save network settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
