"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "../../lib/admin-fetch";
import type { NetworkSettings, NetworkSettingsResponse } from "./types";
import { ErrorNote, timeAgo } from "./shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// The network-wide experiment panel: a master on/off switch and a cadence-intensity
// dial that scale the whole cohort at once. Both persist to `network_settings` via
// /api/admin/network-settings and take effect on the next run-matches pass.

// Trim a trailing ".0" so 2.0 reads as "2" but 1.5 stays "1.5".
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// Intensity scales frequency linearly (the run-matches window is base ÷ intensity),
// so "×N as often" is exact for every value: 0.5 = half as often, 2 = twice.
function effectLabel(m: number): string {
  if (m === 1) return "Normal — every member's own chosen cadence, unchanged.";
  const dir = m > 1 ? "Turned up" : "Turned down";
  return `${dir} — intros arrive about ${trim(m)}× as often as each member chose.`;
}

// A concrete anchor so the multiplier isn't abstract: what a weekly member gets.
function weeklyExample(m: number): string {
  const days = 7 / m;
  if (days < 1) return `a weekly member ≈ every ${trim(days * 24)}h`;
  return `a weekly member ≈ every ${trim(days)} day${days === 1 ? "" : "s"}`;
}

export default function NetworkControls() {
  const [saved, setSaved] = useState<NetworkSettings | null>(null);
  const [bounds, setBounds] = useState<{ min: number; max: number }>({ min: 0.25, max: 4 });
  // Local draft: the switch and slider edit these, and Save flushes them.
  const [enabled, setEnabled] = useState(true);
  const [intensity, setIntensity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function apply(res: NetworkSettingsResponse) {
    setSaved(res.settings);
    setBounds(res.bounds);
    setEnabled(res.settings.enabled);
    setIntensity(res.settings.intensity);
  }

  useEffect(() => {
    adminFetch<NetworkSettingsResponse>("/api/admin/network-settings")
      .then(apply)
      .catch((err) => setError(err.message));
  }, []);

  const dirty = saved !== null && (enabled !== saved.enabled || intensity !== saved.intensity);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await adminFetch<NetworkSettingsResponse>("/api/admin/network-settings", {
        enabled,
        intensity,
      });
      apply(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Network controls</CardTitle>
            <CardDescription>
              Cohort-wide levers for experiments. Take effect on the next matching run.
            </CardDescription>
          </div>
          {/* Master switch, styled as an accessible toggle. */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Network enabled"
            onClick={() => setEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              enabled ? "bg-[#0ca30c]" : "bg-muted-foreground/40"
            }`}
          >
            <span
              className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${
                enabled ? "translate-x-[22px]" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm">
          Network is{" "}
          <span className={enabled ? "font-medium text-[#0ca30c]" : "text-muted-foreground font-medium"}>
            {enabled ? "ON" : "OFF"}
          </span>
          {enabled ? "" : " — the scheduled run opens no introductions."}
        </p>

        <div className={enabled ? "" : "pointer-events-none opacity-50"}>
          <div className="mb-2 flex items-baseline justify-between">
            <label htmlFor="intensity" className="text-sm font-medium">
              Intro intensity
            </label>
            <span className="text-lg font-semibold tabular-nums">{trim(intensity)}×</span>
          </div>
          <input
            id="intensity"
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={0.25}
            value={intensity}
            disabled={!enabled}
            onChange={(e) => setIntensity(Number(e.target.value))}
            className="accent-primary w-full"
          />
          <div className="text-muted-foreground mt-1 flex justify-between text-[11px] tabular-nums">
            <span>{trim(bounds.min)}× less</span>
            <span>1× normal</span>
            <span>{trim(bounds.max)}× more</span>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            {effectLabel(intensity)} <span className="text-foreground/70">({weeklyExample(intensity)})</span>
          </p>
        </div>

        {error && <ErrorNote message={error} />}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
          {saved && (
            <span className="text-muted-foreground text-xs">
              {saved.updatedBy
                ? `Last changed ${timeAgo(saved.updatedAt)} by ${saved.updatedBy}`
                : "Unchanged from defaults"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
