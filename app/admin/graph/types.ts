/** Shared response types for /api/admin/graph/*. */

export interface GraphNode {
  id: string;
  name: string | null;
  kind: "person" | "organization";
  /** Null when the entity has no embedding, so there is no honest position for it. */
  x: number | null;
  y: number | null;
  /** Deduped, undirected. */
  degree: number;
  meanStrength: number | null;
  maxStrength: number | null;
  isUser: boolean;
  hasEmbedding: boolean;
  hasSummary: boolean;
  /** Most recent interaction seen on any of its edges — NOT an ingest timestamp. */
  latestActivity: string | null;
  email: string | null;
}

export interface GraphEdge {
  /** Sorted so `a < b`: the pair key after collapsing direction and source. */
  a: string;
  b: string;
  strength: number | null;
  /** Percentile within the drawn set, [0,1]. This is what drives opacity, not `strength`. */
  rank: number;
  sources: string[];
  observedAt: string | null;
  /** Both endpoints have coordinates. */
  drawable: boolean;
}

export interface ConstellationResponse {
  generatedAt: string;
  projection: {
    method: string;
    dimensions: number;
    placed: number;
    unplaced: number;
    explainedVariance: [number, number];
    axisSeparation: number;
    sigma: [number, number];
    iterations: number;
    converged: boolean;
    renormalized: number;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Distinct `edges.source` values, for the mailbox filter. */
  sources: string[];
  truncated: boolean;
}

export interface EntityAttribute {
  attribute: string;
  value: unknown;
  source: string;
  method: string;
  confidence: number | null;
  observedAt: string | null;
  evidence: string | null;
  contested: boolean;
  stale: boolean;
}

export interface EntityDetailResponse {
  entity: {
    id: string;
    name: string | null;
    kind: string;
    summary: string | null;
    hasEmbedding: boolean;
    isUser: boolean;
    createdAt: string | null;
  };
  attributes: EntityAttribute[];
  edges: Array<{
    other: { id: string; name: string | null };
    strength: number | null;
    source: string;
    observedAt: string | null;
    direction: "out" | "in";
  }>;
  links: Array<{
    other: { id: string; name: string | null };
    basis: string;
    confidence: number | null;
    status: string;
  }>;
}

export interface SummarizeResponse {
  results: Array<{ id: string; ok: boolean; error?: string }>;
}
