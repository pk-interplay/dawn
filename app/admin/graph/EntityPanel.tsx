"use client";

/**
 * SPEC §6's "Entity view": every attribute with its source, method, confidence,
 * observed_at, and the contested/stale flags.
 *
 * `evidence` is rendered INLINE rather than behind a disclosure, because §6 is explicit
 * that a row without visible evidence makes approving into rubber-stamping. Long
 * evidence truncates with a toggle, but the first line is always there.
 *
 * `contested` and `stale` always pair their marker with the literal WORD. Colour alone
 * would be both an accessibility failure and, in a palette with no saturated accent,
 * nearly invisible.
 */

import { useEffect, useState } from "react";

import { adminFetch } from "../../lib/admin-fetch";
import { EmptyNote, ErrorNote, Loading, timeAgo } from "../monitor/shared";
import { cn } from "@/lib/utils";
import type { EntityAttribute, EntityDetailResponse } from "./types";

const EVIDENCE_CLAMP = 200;

/** `value` is jsonb — string, number, array, or object. `String(value)` prints [object Object]. */
function formatClaimValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatClaimValue).join(", ");
  return JSON.stringify(value);
}

export function EntityPanel({ entityId }: { entityId: string }) {
  const [data, setData] = useState<EntityDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    adminFetch<EntityDetailResponse>(`/api/admin/graph/entity?id=${entityId}`)
      .then((body) => !cancelled && setData(body))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading what="entity" />;

  return (
    <div className="space-y-6">
      <div>
        <p className="font-serif text-2xl leading-snug tracking-[0.2px] text-dawn-bone">
          {data.entity.name ?? "Unnamed"}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {data.entity.kind}
          {data.entity.isUser ? " · signed-in user" : ""}
          {data.entity.hasEmbedding ? " · embedded" : " · no embedding"}
          {data.entity.createdAt ? ` · added ${timeAgo(data.entity.createdAt)}` : ""}
        </p>
        {data.entity.summary && (
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            {data.entity.summary}
          </p>
        )}
      </div>

      <section>
        <Kicker>Attributes</Kicker>
        {data.attributes.length === 0 ? (
          <EmptyNote>Nothing claimed about this entity yet.</EmptyNote>
        ) : (
          <div className="mt-3 space-y-2">
            {data.attributes.map((attr) => (
              <AttributeRow key={`${attr.attribute}:${attr.source}`} attr={attr} />
            ))}
          </div>
        )}
        {data.attributes.some((a) => a.contested) && (
          <p className="text-muted-foreground mt-3 text-xs">
            Contested rows show only the winning claim — <code>resolved_attributes</code> is
            <code> distinct on (subject_id, attribute)</code>. Seeing what it conflicts with
            needs a claims-level drill-down, which isn&rsquo;t built yet.
          </p>
        )}
      </section>

      <section>
        <Kicker>Relationships</Kicker>
        {data.edges.length === 0 ? (
          <EmptyNote>No relationships recorded.</EmptyNote>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {data.edges.map((edge, i) => (
              <li key={`${edge.other.id}-${edge.source}-${i}`} className="text-sm">
                <span className="text-dawn-bone">{edge.other.name ?? "Unnamed"}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {edge.direction === "out" ? "knows" : "known by"} · strength{" "}
                  {edge.strength === null ? "unknown" : edge.strength.toFixed(2)} · last seen{" "}
                  {timeAgo(edge.observedAt)} · via{" "}
                  <span className="font-mono text-[11px]">{edge.source}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.links.length > 0 && (
        <section>
          <Kicker>Possible duplicates</Kicker>
          <p className="text-muted-foreground mt-2 text-xs">
            Candidate identity matches. Entities are never hard-merged — SPEC §2.4.
          </p>
          <ul className="mt-3 space-y-1.5">
            {data.links.map((link, i) => (
              <li key={`${link.other.id}-${i}`} className="text-sm">
                <span className="text-dawn-bone">{link.other.name ?? "Unnamed"}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · matched on {link.basis} · confidence{" "}
                  {link.confidence?.toFixed(2) ?? "—"} · {link.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AttributeRow({ attr }: { attr: EntityAttribute }) {
  const [expanded, setExpanded] = useState(false);
  const evidence = attr.evidence ?? "";
  const needsClamp = evidence.length > EVIDENCE_CLAMP;
  const shown = expanded || !needsClamp ? evidence : `${evidence.slice(0, EVIDENCE_CLAMP)}…`;

  return (
    <div className="border-dawn-btn bg-card rounded-[--radius] border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-dawn-head text-[11px] font-medium tracking-[1.6px] uppercase">
          {attr.attribute}
        </span>
        <span className="text-sm text-foreground">{formatClaimValue(attr.value)}</span>
        {attr.contested && <Flag role="warning">contested</Flag>}
        {attr.stale && <Flag role="serious">stale</Flag>}
      </div>

      <p className="text-muted-foreground mt-1.5 text-xs">
        {attr.method} · confidence {attr.confidence?.toFixed(2) ?? "—"} · observed{" "}
        {timeAgo(attr.observedAt)} · source{" "}
        <span className="font-mono text-[11px]">{attr.source}</span>
      </p>

      {evidence ? (
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          {shown}
          {needsClamp && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-dawn-bone ml-1 underline underline-offset-2"
            >
              {expanded ? "less" : "more"}
            </button>
          )}
        </p>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs italic">
          No evidence recorded — approving this would be rubber-stamping.
        </p>
      )}
    </div>
  );
}

function Flag({ role, children }: { role: "warning" | "serious"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "border-dawn-btn inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px]",
        "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: role === "warning" ? "#fab219" : "#ec835a" }}
      />
      {children}
    </span>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-dawn-head text-[11px] font-medium tracking-[2.4px] uppercase">{children}</p>
  );
}
