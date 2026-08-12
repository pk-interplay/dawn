"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { ChartConfig } from "@/components/ui/chart";

// Single-hue series color for every chart here — each one plots one measure, so
// there is no categorical palette to keep colorblind-safe. Steps are the
// documented sequential blue; the dark step clears 3:1 on the card surface.
export const chartConfig = {
  count: { label: "Count", theme: { light: "#2a78d6", dark: "#3987e5" } },
} satisfies ChartConfig;

// Reserved status palette — never reused as series colors, and always paired
// with the state's text label so meaning never rides on hue alone.
const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  neutral: "#898781",
  active: "#3987e5",
} as const;

type StatusRole = keyof typeof STATUS;

const INTRO_STATE_ROLE: Record<string, StatusRole> = {
  proposed: "neutral",
  a_invited: "neutral",
  b_invited: "neutral",
  a_opted_in: "active",
  b_opted_in: "active",
  both_opted_in: "active",
  // The terminal success state: both sides said yes and the warm intro went out.
  introduced: "good",
  // Legacy, for rows opened before Dawn stopped owning the calendar.
  scheduling: "active",
  scheduled: "good",
  completed: "good",
  declined: "critical",
  expired: "warning",
};

const DECISION_ROLE: Record<string, StatusRole> = {
  reply_to_intro: "good",
  preference_update: "good",
  pause: "warning",
  rate_limited: "warning",
  out_of_scope: "serious",
  non_member: "neutral",
  duplicate: "neutral",
  self_send: "neutral",
};

function Dot({ role }: { role: StatusRole }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: STATUS[role] }}
    />
  );
}

function Pill({ role, children }: { role: StatusRole; children: React.ReactNode }) {
  return (
    <span className="border-border/60 bg-secondary/40 text-secondary-foreground inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs whitespace-nowrap">
      <Dot role={role} />
      {children}
    </span>
  );
}

export function StateBadge({ state }: { state: string }) {
  return <Pill role={INTRO_STATE_ROLE[state] ?? "neutral"}>{state.replace(/_/g, " ")}</Pill>;
}

export function DecisionBadge({ decision }: { decision: string }) {
  return <Pill role={DECISION_ROLE[decision] ?? "neutral"}>{decision.replace(/_/g, " ")}</Pill>;
}

export function ResponseBadge({ label, response }: { label: string; response: string }) {
  const role: StatusRole =
    response === "yes" ? "good" : response === "no" ? "critical" : "neutral";
  return (
    <Pill role={role}>
      {label} {response}
    </Pill>
  );
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
        {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: Array<[string, number]> = [
    ["m", 60],
    ["h", 3600],
    ["d", 86400],
  ];
  if (seconds < 3600) return `${Math.floor(seconds / units[0][1])}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / units[1][1])}h ago`;
  const days = Math.floor(seconds / units[2][1]);
  return days < 30 ? `${days}d ago` : new Date(iso).toISOString().slice(0, 10);
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="text-destructive text-sm">Error: {message}</p>;
}

export function Loading({ what }: { what: string }) {
  return <p className="text-muted-foreground text-sm">Loading {what}…</p>;
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground bg-muted/40 rounded-md border border-dashed p-4 text-sm">
      {children}
    </p>
  );
}

// ThreadPanel (the expandable email thread reader) lived here and was removed with
// the email layer. `Dot`/`Pill` below are the pattern to reuse for any new status
// marker — note they always pair the colour with a word, never colour alone.
