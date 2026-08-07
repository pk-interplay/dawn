"use client";

/**
 * Entities with no embedding, and a bounded action to give them one.
 *
 * They are listed BELOW the map rather than ringed around its edge. A position on the
 * canvas implies a projection, and for these there isn't one — placing them anywhere
 * would be lying with a chart.
 *
 * Sorted by degree descending, because a high-degree unplaced entity is the one most
 * worth spending a summarize call on.
 *
 * The action is capped at 25 by the route and the UI enforces the same limit. There is
 * deliberately no "summarize all": over a few hundred entities that is a few hundred
 * model calls behind a function timeout that will die halfway with no record of what
 * succeeded.
 */

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { adminFetch } from "../../lib/admin-fetch";
import type { GraphNode, SummarizeResponse } from "./types";

const MAX_BATCH = 25;

export function UnplacedList({
  nodes,
  onDone,
}: {
  nodes: GraphNode[];
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const unplaced = useMemo(
    () => nodes.filter((n) => !n.hasEmbedding).sort((a, b) => b.degree - a.degree),
    [nodes],
  );

  if (unplaced.length === 0) return null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BATCH) next.add(id);
      return next;
    });
  }

  async function summarize() {
    setBusy(true);
    setResult(null);
    try {
      const body = await adminFetch<SummarizeResponse>("/api/admin/graph/summarize", {
        entityIds: [...selected],
      });
      const ok = body.results.filter((r) => r.ok).length;
      const failed = body.results.filter((r) => !r.ok);
      setResult(
        failed.length === 0
          ? `Summarized and embedded ${ok}.`
          : `Summarized ${ok}, ${failed.length} failed: ${failed[0].error ?? "unknown error"}`,
      );
      setSelected(new Set());
      // The projection basis changes when new vectors appear, so the whole map moves.
      onDone();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">
        Unplaced
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        {unplaced.length} entities have no embedding, so there is no honest position for
        them on the map. Summarizing one writes a summary and an embedding, after which it
        appears. Highest-degree first — those are the ones worth the call.
      </p>

      <div className="border-dawn-btn mt-3 max-h-64 overflow-auto rounded-[--radius] border">
        <ul className="divide-dawn-btn/60 divide-y">
          {unplaced.map((node) => (
            <li key={node.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(node.id)}
                disabled={!selected.has(node.id) && selected.size >= MAX_BATCH}
                onChange={() => toggle(node.id)}
                aria-label={`Select ${node.name ?? "unnamed entity"}`}
              />
              <span className="flex-1 truncate">{node.name ?? "Unnamed"}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {node.degree} rel.{node.hasSummary ? " · has summary" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy || selected.size === 0} onClick={summarize}>
          {busy ? "Summarizing…" : `Summarize ${selected.size} selected`}
        </Button>
        <span className="text-muted-foreground text-xs">
          Max {MAX_BATCH} at a time.
          {selected.size >= MAX_BATCH ? " Limit reached." : ""}
        </span>
        {result && <span className="text-muted-foreground text-xs">{result}</span>}
      </div>
    </section>
  );
}
