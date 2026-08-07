"use client";

/**
 * The list half of the view: every entity, filterable and sortable.
 *
 * A real semantic `<table>`, hand-rolled rather than pulled from the shadcn registry —
 * it is ~20 lines of Tailwind on native elements and avoids adding a vendored component
 * for one consumer. `MembersTab`'s card list is the pattern NOT to copy: 300 rows of
 * cards is unscannable.
 *
 * Selection is lifted to the page and shared with the map, so clicking a dot highlights
 * and scrolls to its row and vice versa. That bidirectional link is what makes the pair
 * more useful than either half alone.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { timeAgo } from "../monitor/shared";
import type { GraphNode } from "./types";

type SortKey = "degree" | "name" | "strength" | "activity";

export function EntitiesTable({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: GraphNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("degree");
  const [usersOnly, setUsersOnly] = useState(false);
  const selectedRow = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = nodes.filter((n) => {
      if (usersOnly && !n.isUser) return false;
      if (!needle) return true;
      return (
        (n.name ?? "").toLowerCase().includes(needle) ||
        (n.email ?? "").toLowerCase().includes(needle)
      );
    });

    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "name":
          return (a.name ?? "￿").localeCompare(b.name ?? "￿");
        case "strength":
          return (b.maxStrength ?? -1) - (a.maxStrength ?? -1);
        case "activity":
          return (b.latestActivity ?? "").localeCompare(a.latestActivity ?? "");
        default:
          return b.degree - a.degree || (a.name ?? "").localeCompare(b.name ?? "");
      }
    });
  }, [nodes, filter, sort, usersOnly]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or email…"
          className="h-9 max-w-xs"
        />
        <SelectNative
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-9 w-auto"
        >
          <option value="degree">Most relationships</option>
          <option value="strength">Strongest relationship</option>
          <option value="activity">Most recent activity</option>
          <option value="name">Name</option>
        </SelectNative>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={usersOnly}
            onChange={(e) => setUsersOnly(e.target.checked)}
          />
          Users only
        </label>
        <span className="text-muted-foreground ml-auto text-xs">
          {rows.length} of {nodes.length}
        </span>
      </div>

      <div className="border-dawn-btn max-h-[480px] overflow-auto rounded-[--radius] border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-card sticky top-0 z-10">
            <tr className="text-dawn-head text-[11px] tracking-[1.6px] uppercase">
              <Th>Name</Th>
              <Th>Email</Th>
              <Th className="text-right">Rel.</Th>
              <Th className="text-right">Mean</Th>
              <Th className="text-right">Max</Th>
              <Th>Embedded</Th>
              {/* NOT "last sync". edges.observed_at is the last interaction time with that
                  contact, not when ingest ran — there is no ingest-run ledger in the
                  schema. Mislabelling a timestamp is what makes an admin page untrusted. */}
              <Th>Latest activity seen</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => {
              const isSelected = node.id === selectedId;
              return (
                <tr
                  key={node.id}
                  ref={isSelected ? selectedRow : null}
                  onClick={() => onSelect(isSelected ? null : node.id)}
                  className={cn(
                    "border-dawn-btn/60 cursor-pointer border-t transition-colors",
                    isSelected ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <Td>
                    <span className={isSelected ? "text-dawn-bone" : undefined}>
                      {node.name ?? "Unnamed"}
                    </span>
                    {node.isUser && (
                      <span className="text-muted-foreground ml-1.5 text-[11px]">· user</span>
                    )}
                    {node.kind === "organization" && (
                      <span className="text-muted-foreground ml-1.5 text-[11px]">· org</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground font-mono text-[11px]">
                    {node.email ?? "—"}
                  </Td>
                  <Td className="text-right">{node.degree}</Td>
                  <Td className="text-muted-foreground text-right">
                    {node.meanStrength?.toFixed(2) ?? "—"}
                  </Td>
                  <Td className="text-muted-foreground text-right">
                    {node.maxStrength?.toFixed(2) ?? "—"}
                  </Td>
                  <Td className="text-muted-foreground">{node.hasEmbedding ? "yes" : "no"}</Td>
                  <Td className="text-muted-foreground">{timeAgo(node.latestActivity)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="text-muted-foreground p-4 text-sm">Nothing matches that filter.</p>
        )}
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-3 py-2 font-medium", className)}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2", className)}>{children}</td>;
}
