"use client";

/**
 * The embedding constellation: hand-rolled inline SVG.
 *
 * Not recharts, though recharts is already installed and used for the monitor's bar
 * charts. It could technically do this (`ZAxis` for per-point size, `ReferenceLine
 * segment` for edges) and fails on the three things this view needs most: every edge
 * becomes a React element inside recharts' layout pass and is re-reconciled on each
 * hover; there is no label collision avoidance at all, and this view is illegible
 * without it; and numeric ticks on PC1/PC2 — axes with no units — invite exactly the
 * false precision the caption is trying to avoid.
 *
 * Encoding choices, all of which are about not lying:
 *  - ONE uniform scale for both axes, so equal screen distance means equal semantic
 *    distance. Normalizing each axis to fill the frame would distort distance and make
 *    one outlier rescale everything.
 *  - Edge opacity from PERCENTILE RANK, not raw strength — strength saturates at 1.00
 *    (see the route), so raw values would be nearly constant.
 *  - Null strength renders dashed at floor opacity, so "unknown" cannot pass for "weak".
 *  - Users and organizations differ by SHAPE and WEIGHT, never hue. The palette has no
 *    saturated accent and this does not introduce one.
 *  - Points beyond the 3σ window are clamped into the frame and marked, rather than
 *    silently dropped off-canvas.
 */

import { useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { ConstellationResponse, GraphEdge, GraphNode } from "./types";

const VIEW_W = 1000;
const VIEW_H = 620;
const PAD = 48;
/** Beyond this many σ a point is clamped to the frame edge and flagged. */
const SIGMA_WINDOW = 3;
const EDGE_OPACITY_MIN = 0.06;
const EDGE_OPACITY_MAX = 0.32;
/** Above this many edges, batch into opacity bins (one <path> each) instead of <line>s. */
const EDGE_ELEMENT_BUDGET = 200;
const MAX_LABELS = 24;
const LABEL_CHARS = 22;

interface Placed {
  node: GraphNode;
  cx: number;
  cy: number;
  r: number;
  clamped: boolean;
}

export function Constellation({
  data,
  selectedId,
  onSelect,
}: {
  data: ConstellationResponse;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<Placed | null>(null);

  const { placed, byId, edges, degMax } = useMemo(() => {
    const withCoords = data.nodes.filter(
      (n): n is GraphNode & { x: number; y: number } => n.x !== null && n.y !== null,
    );

    const [sx, sy] = data.projection.sigma;
    const spread = Math.max(sx, sy, 1e-9);
    const innerW = VIEW_W - PAD * 2;
    const innerH = VIEW_H - PAD * 2;
    // One scale for both axes. PC1's genuinely larger spread then shows as a wider
    // cloud, which is truthful.
    const scale = Math.min(innerW, innerH) / (2 * SIGMA_WINDOW * spread);

    const degMax = Math.max(1, ...withCoords.map((n) => n.degree));

    const placed: Placed[] = withCoords.map((node) => {
      const rawX = VIEW_W / 2 + node.x * scale;
      const rawY = VIEW_H / 2 - node.y * scale;
      const cx = Math.min(VIEW_W - PAD, Math.max(PAD, rawX));
      const cy = Math.min(VIEW_H - PAD, Math.max(PAD, rawY));
      return {
        node,
        cx,
        cy,
        // Area-proportional: radius-linear would give a 100-degree hub 10x the area it
        // should have, and mailbox owners have degree in the hundreds.
        r: 3 + 11 * Math.sqrt(node.degree / degMax),
        clamped: Math.abs(rawX - cx) > 0.5 || Math.abs(rawY - cy) > 0.5,
      };
    });

    const byId = new Map(placed.map((p) => [p.node.id, p]));
    const edges = data.edges.filter((e) => e.drawable && byId.has(e.a) && byId.has(e.b));
    return { placed, byId, edges, degMax };
  }, [data]);

  const neighbours = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const e of edges) {
      if (e.a === selectedId) set.add(e.b);
      if (e.b === selectedId) set.add(e.a);
    }
    return set;
  }, [selectedId, edges]);

  const labels = useMemo(
    () => layoutLabels(placed, selectedId, neighbours),
    [placed, selectedId, neighbours],
  );

  // Takes the coordinate fields both pointer and mouse events carry, so the same
  // hit-testing serves onPointerMove and onClick.
  function nearest(event: { clientX: number; clientY: number }): Placed | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    // Map client px into viewBox units; the SVG scales with its container.
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((event.clientY - rect.top) / rect.height) * VIEW_H;
    const tolerance = (16 / rect.width) * VIEW_W;
    let best: Placed | null = null;
    let bestDist = Infinity;
    for (const p of placed) {
      const d = Math.hypot(p.cx - x, p.cy - y);
      if (d < Math.max(p.r + tolerance, tolerance) && d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
  }

  const dim = (id: string) => (neighbours ? (neighbours.has(id) ? 1 : 0.18) : 1);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Network space: ${placed.length} entities plotted by semantic similarity, with ${edges.length} relationships drawn between them.`}
        className="border-dawn-btn bg-card w-full rounded-[--radius] border"
        // One delegated listener beats 300, and gives forgiving hit targets for r=3 dots.
        onPointerMove={(e) => setHovered(nearest(e))}
        onPointerLeave={() => setHovered(null)}
        onClick={(e) => {
          const hit = nearest(e);
          onSelect(hit ? hit.node.id : null);
        }}
      >
        <Edges edges={edges} byId={byId} selectedId={selectedId} neighbours={neighbours} />

        {placed.map((p) => {
          const opacity = dim(p.node.id);
          const isSelected = p.node.id === selectedId;
          const common = {
            opacity,
            className: cn("transition-opacity duration-200 motion-reduce:transition-none"),
          };
          return (
            <g key={p.node.id}>
              {isSelected && (
                <circle cx={p.cx} cy={p.cy} r={p.r + 4} fill="none" stroke="var(--dawn-btn)" strokeWidth={1} />
              )}
              {p.node.kind === "organization" ? (
                <rect
                  x={p.cx - p.r * 0.8}
                  y={p.cy - p.r * 0.8}
                  width={p.r * 1.6}
                  height={p.r * 1.6}
                  fill="var(--dawn-bone)"
                  fillOpacity={isSelected ? 1 : p.node.degree === 0 ? 0.3 : 0.55}
                  {...common}
                />
              ) : (
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={p.r}
                  fill="var(--dawn-bone)"
                  fillOpacity={isSelected ? 1 : p.node.isUser ? 0.9 : p.node.degree === 0 ? 0.3 : 0.55}
                  stroke={p.node.isUser ? "var(--dawn-bone)" : "none"}
                  strokeWidth={p.node.isUser ? 1 : 0}
                  {...common}
                />
              )}
              {p.clamped && (
                <title>{`${p.node.name ?? "Unnamed"} — off scale, clamped into view`}</title>
              )}
            </g>
          );
        })}

        {labels.map((label) => (
          <text
            key={label.id}
            x={label.x}
            y={label.y}
            fontSize={11}
            textAnchor={label.anchor}
            fill={label.id === selectedId ? "var(--dawn-bone)" : "var(--muted-foreground)"}
            opacity={dim(label.id)}
            className="pointer-events-none select-none"
          >
            {label.text}
          </text>
        ))}
      </svg>

      {hovered && <Tooltip placed={hovered} />}

      {/* Operable and screen-readable without reimplementing SVG focus management — and
          it partly IS the plain list of everyone on the map. */}
      <ul className="sr-only">
        {placed.map((p) => (
          <li key={p.node.id}>
            <button type="button" onClick={() => onSelect(p.node.id)}>
              {p.node.name ?? "Unnamed"} — {p.node.degree} relationships
              {p.node.isUser ? ", a signed-in user" : ""}
            </button>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground mt-3 text-xs">
        Distance approximates semantic distance — PCA on the entity embeddings, which for
        unit vectors is the same eigenproblem as classical MDS on their cosine distances.
        Edge opacity is the relationship&rsquo;s percentile strength (raw strength
        saturates, so ranking it is the only encoding that carries information); dot size
        is how many relationships it has; a ring marks a signed-in user; squares are
        organizations.{" "}
        {data.projection.axisSeparation < 1.05 && (
          <strong className="text-dawn-bone">
            The two axes have nearly equal variance, so the map&rsquo;s orientation is
            arbitrary — read distances, not directions.
          </strong>
        )}{" "}
        {!data.projection.converged && (
          <strong className="text-dawn-bone">
            The projection did not fully converge ({data.projection.iterations} iterations).
          </strong>
        )}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        {data.projection.placed} of {data.nodes.length} entities placed ·{" "}
        {data.projection.unplaced} have no embedding yet · {edges.length} relationships
        drawn ({data.edges.length - edges.length} not drawable) · axes explain{" "}
        {Math.round(data.projection.explainedVariance[0] * 100)}% and{" "}
        {Math.round(data.projection.explainedVariance[1] * 100)}% of variance · computed
        from {data.projection.placed} vectors, so adding entities reshapes it · max degree{" "}
        {degMax}
      </p>
    </div>
  );
}

function Edges({
  edges,
  byId,
  selectedId,
  neighbours,
}: {
  edges: GraphEdge[];
  byId: Map<string, Placed>;
  selectedId: string | null;
  neighbours: Set<string> | null;
}) {
  const opacityFor = (rank: number) =>
    EDGE_OPACITY_MIN + rank * (EDGE_OPACITY_MAX - EDGE_OPACITY_MIN);

  // Above the element budget, collapse into six opacity bins and emit one <path> per
  // bin. 400 elements become 6, at the cost of per-edge hover — which the tooltip does
  // not use anyway.
  if (edges.length > EDGE_ELEMENT_BUDGET && !selectedId) {
    const bins = new Map<number, string[]>();
    for (const e of edges) {
      const a = byId.get(e.a)!;
      const b = byId.get(e.b)!;
      const bin = Math.min(5, Math.floor(e.rank * 6));
      bins.set(bin, [...(bins.get(bin) ?? []), `M${a.cx} ${a.cy}L${b.cx} ${b.cy}`]);
    }
    return (
      <g>
        {[...bins.entries()].map(([bin, segments]) => (
          <path
            key={bin}
            d={segments.join("")}
            stroke="var(--dawn-bone)"
            strokeOpacity={opacityFor((bin + 0.5) / 6)}
            strokeWidth={1}
            fill="none"
          />
        ))}
      </g>
    );
  }

  return (
    <g>
      {edges.map((e) => {
        const a = byId.get(e.a)!;
        const b = byId.get(e.b)!;
        const touchesSelection = neighbours ? e.a === selectedId || e.b === selectedId : false;
        const base = opacityFor(e.rank);
        return (
          <line
            key={`${e.a}|${e.b}`}
            x1={a.cx}
            y1={a.cy}
            x2={b.cx}
            y2={b.cy}
            stroke="var(--dawn-bone)"
            strokeOpacity={neighbours ? (touchesSelection ? 0.6 : 0.05) : base}
            strokeWidth={1}
            // Dashed for unknown strength, so it cannot masquerade as weak.
            strokeDasharray={e.strength === null ? "2 3" : undefined}
            className="transition-opacity duration-200 motion-reduce:transition-none"
          />
        );
      })}
    </g>
  );
}

function Tooltip({ placed }: { placed: Placed }) {
  const { node } = placed;
  return (
    <div
      className="border-dawn-btn bg-popover pointer-events-none absolute z-10 rounded-[--radius] border px-3 py-2 text-xs shadow-lg"
      style={{
        left: `${(placed.cx / VIEW_W) * 100}%`,
        top: `${(placed.cy / VIEW_H) * 100}%`,
        transform: "translate(12px, -50%)",
      }}
    >
      <p className="text-dawn-bone font-medium">{node.name ?? "Unnamed"}</p>
      <p className="text-muted-foreground mt-0.5">
        {node.kind}
        {node.isUser ? " · user" : ""} · {node.degree} relationship
        {node.degree === 1 ? "" : "s"}
      </p>
      {node.maxStrength !== null && (
        <p className="text-muted-foreground">
          strength max {node.maxStrength.toFixed(2)} · mean{" "}
          {node.meanStrength?.toFixed(2) ?? "—"}
        </p>
      )}
      {!node.hasEmbedding && <p className="text-muted-foreground">no embedding</p>}
    </div>
  );
}

interface LabelBox {
  id: string;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Greedy deterministic collision avoidance.
 *
 * Sorted by degree then id so ties break the same way every render. Four candidate
 * anchors per label; the first that collides with nothing already accepted (labels AND
 * dots) wins. Width is estimated at 5.6px/char rather than measured in the DOM —
 * slightly generous is fine and avoids a layout pass.
 *
 * On selection, the selected entity and its neighbours are seeded first so they are
 * always labelled, even when that displaces a higher-degree label.
 */
function layoutLabels(
  placed: Placed[],
  selectedId: string | null,
  neighbours: Set<string> | null,
): LabelBox[] {
  const priority = [...placed].sort((a, b) => {
    if (neighbours) {
      const an = neighbours.has(a.node.id) ? 1 : 0;
      const bn = neighbours.has(b.node.id) ? 1 : 0;
      if (an !== bn) return bn - an;
    }
    if (a.node.id === selectedId) return -1;
    if (b.node.id === selectedId) return 1;
    if (b.node.degree !== a.node.degree) return b.node.degree - a.node.degree;
    return a.node.id < b.node.id ? -1 : 1;
  });

  const accepted: LabelBox[] = [];
  const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = placed.map(
    (p) => ({ left: p.cx - p.r, right: p.cx + p.r, top: p.cy - p.r, bottom: p.cy + p.r }),
  );

  let consecutiveFailures = 0;

  for (const p of priority) {
    if (accepted.length >= MAX_LABELS) break;
    if (consecutiveFailures >= 6) break;

    const raw = p.node.name ?? "Unnamed";
    const text = raw.length > LABEL_CHARS ? `${raw.slice(0, LABEL_CHARS - 1)}…` : raw;
    const width = text.length * 5.6;
    const height = 12;
    const gap = 4;

    const candidates: LabelBox[] = [
      { x: p.cx + p.r + gap, y: p.cy + 4, anchor: "start" as const },
      { x: p.cx - p.r - gap, y: p.cy + 4, anchor: "end" as const },
      { x: p.cx, y: p.cy - p.r - gap, anchor: "middle" as const },
      { x: p.cx, y: p.cy + p.r + gap + height, anchor: "middle" as const },
    ].map((c) => {
      const left = c.anchor === "start" ? c.x : c.anchor === "end" ? c.x - width : c.x - width / 2;
      return {
        id: p.node.id,
        text,
        x: c.x,
        y: c.y,
        anchor: c.anchor,
        left,
        right: left + width,
        top: c.y - height,
        bottom: c.y,
      };
    });

    const fit = candidates.find(
      (c) =>
        c.left >= 0 &&
        c.right <= VIEW_W &&
        c.top >= 0 &&
        c.bottom <= VIEW_H &&
        !occupied.some(
          (o) => c.left < o.right && c.right > o.left && c.top < o.bottom && c.bottom > o.top,
        ),
    );

    if (!fit) {
      consecutiveFailures++;
      continue;
    }
    consecutiveFailures = 0;
    accepted.push(fit);
    occupied.push({ left: fit.left, right: fit.right, top: fit.top, bottom: fit.bottom });
  }

  return accepted;
}
