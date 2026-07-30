"use client";

import type { ExchangeSummary } from "./types";
import { StateBadge, timeAgo } from "../monitor/shared";
import { SelectNative } from "@/components/ui/select-native";

export type Filter = "replied" | "sent" | "all";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "replied", label: "With replies" },
  { value: "sent", label: "With email sent" },
  { value: "all", label: "All introductions" },
];

/** The one filter that matters for a demo comes first: an introduction nobody
 *  replied to plays back as a single frame and shows none of the machinery. */
export function applyFilter(rows: ExchangeSummary[], filter: Filter): ExchangeSummary[] {
  if (filter === "replied") return rows.filter((r) => r.inboundCount > 0);
  if (filter === "sent") return rows.filter((r) => r.messageCount > 0);
  return rows;
}

export default function ExchangeList({
  rows,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  totalCount,
}: {
  rows: ExchangeSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: Filter;
  onFilterChange: (filter: Filter) => void;
  totalCount: number;
}) {
  return (
    <div className="space-y-3">
      <SelectNative
        className="w-full"
        value={filter}
        onChange={(e) => onFilterChange(e.target.value as Filter)}
        aria-label="Filter introductions"
      >
        {FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </SelectNative>

      <p className="text-muted-foreground text-xs">
        {rows.length} of {totalCount} introduction{totalCount === 1 ? "" : "s"}
      </p>

      <ul className="space-y-1.5">
        {rows.map((row) => {
          const selected = row.id === selectedId;
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onSelect(row.id)}
                aria-current={selected ? "true" : undefined}
                className={[
                  "w-full rounded-md border px-3 py-2 text-left transition-colors",
                  selected
                    ? "border-foreground/30 bg-secondary/70"
                    : "border-border/60 hover:bg-secondary/30",
                ].join(" ")}
              >
                <span className="block truncate text-sm font-medium">
                  {row.person_a.name} <span className="text-muted-foreground">↔</span>{" "}
                  {row.person_b.name}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StateBadge state={row.state} />
                </span>
                <span className="text-muted-foreground mt-1 block text-xs">
                  {row.messageCount} email{row.messageCount === 1 ? "" : "s"}
                  {row.inboundCount > 0 && ` · ${row.inboundCount} reply${row.inboundCount === 1 ? "" : "s"}`}
                  {" · "}
                  {timeAgo(row.lastMessageAt ?? row.updated_at)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
