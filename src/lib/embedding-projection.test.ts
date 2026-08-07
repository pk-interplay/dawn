import { describe, expect, it } from "vitest";

import { projectTo2D, type ProjectionInput } from "./embedding-projection";

const DIMENSIONS = 1536;

/** Two fixed orthonormal directions in 1536-d, plus a third low-variance one. */
function basis(index: number): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  // Spread each basis vector over a distinct stride so they're orthogonal by construction
  // and none is a single axis (which would make the test trivially easy on the algorithm).
  for (let d = index; d < DIMENSIONS; d += 3) v[d] = 1;
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / len);
}

const B0 = basis(0);
const B1 = basis(1);
const B2 = basis(2);

/** Embed a planted 2D point into 1536-d, with a little variance on a third direction. */
function embedPoint(x: number, y: number, noise = 0): number[] {
  const out = new Array(DIMENSIONS).fill(0);
  for (let d = 0; d < DIMENSIONS; d++) {
    out[d] = x * B0[d] + y * B1[d] + noise * B2[d];
  }
  return out;
}

/** A deliberately asymmetric point set, so the skewness sign tier has something to bite on. */
const PLANTED: Array<{ id: string; x: number; y: number }> = [
  { id: "a", x: 3.0, y: 0.4 },
  { id: "b", x: 2.2, y: -0.5 },
  { id: "c", x: 1.1, y: 0.9 },
  { id: "d", x: 0.2, y: -0.8 },
  { id: "e", x: -0.6, y: 0.3 },
  { id: "f", x: -1.4, y: -0.2 },
  { id: "g", x: -2.1, y: 0.6 },
];

function plantedRows(scale = 1): ProjectionInput[] {
  return PLANTED.map((p, i) => ({
    id: p.id,
    embedding: embedPoint(p.x * scale, p.y * scale, ((i % 3) - 1) * 0.02),
  }));
}

function pairwise(coords: Map<string, { x: number; y: number }>, ids: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = coords.get(ids[i])!;
      const b = coords.get(ids[j])!;
      out.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return out;
}

describe("projectTo2D", () => {
  it("preserves pairwise distances for data that genuinely lies in a plane", () => {
    // Distance is the right invariant to assert. A principal basis has residual sign and
    // (when variances tie) rotation freedom, so individual coordinates are not uniquely
    // determined — but distances between points are, and distance is exactly what an
    // operator reads off the map.
    //
    // The planted vectors must be UNIT NORM, because projectTo2D re-normalizes anything
    // that isn't (real text-embedding-3-small output always is). So they sit on a circle
    // in the B0/B1 plane at deliberately uneven angles: unit length, genuinely rank-2,
    // and asymmetric enough to exercise the skewness sign tier.
    const angles = [0, 0.35, 0.9, 1.7, 2.4, 3.5, 4.2, 5.6];
    const rows: ProjectionInput[] = angles.map((theta, i) => ({
      id: `p${i}`,
      embedding: embedPoint(Math.cos(theta), Math.sin(theta)),
    }));

    const result = projectTo2D(rows);
    const ids = rows.map((r) => r.id);

    // Ground truth is the distance in the ORIGINAL 1536-d space. If the projection is
    // faithful for planar data, the 2D distances reproduce it.
    const expected: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        let sum = 0;
        for (let d = 0; d < DIMENSIONS; d++) {
          sum += (rows[i].embedding[d] - rows[j].embedding[d]) ** 2;
        }
        expected.push(Math.sqrt(sum));
      }
    }

    const actual = pairwise(result.coords, ids);
    for (let k = 0; k < expected.length; k++) {
      expect(actual[k]).toBeCloseTo(expected[k], 6);
    }

    // Exactly rank 2, so the two axes should account for all of the variance.
    expect(result.explainedVariance[0] + result.explainedVariance[1]).toBeGreaterThan(0.999);
    expect(result.converged).toBe(true);
  });

  it("is bit-for-bit deterministic across runs", () => {
    const a = projectTo2D(plantedRows());
    const b = projectTo2D(plantedRows());
    for (const [id, point] of a.coords) {
      expect(b.coords.get(id)!.x).toBe(point.x);
      expect(b.coords.get(id)!.y).toBe(point.y);
    }
  });

  it("is invariant to input row order", () => {
    // This is the test that validates the id sort. Without it, floating-point summation
    // order changes and every coordinate shifts slightly on each reload.
    const forward = projectTo2D(plantedRows());
    const shuffled = projectTo2D([...plantedRows()].reverse());
    for (const [id, point] of forward.coords) {
      expect(shuffled.coords.get(id)!.x).toBeCloseTo(point.x, 9);
      expect(shuffled.coords.get(id)!.y).toBeCloseTo(point.y, 9);
    }
  });

  it("orients the dominant axis the same way regardless of planted sign", () => {
    const positive = projectTo2D(plantedRows());
    const negated = projectTo2D(
      PLANTED.map((p, i) => ({
        id: p.id,
        embedding: embedPoint(-p.x, -p.y, ((i % 3) - 1) * 0.02),
      })),
    );
    // Same shape either way — and the convention resolves the mirror, so 'a' does not
    // swap ends of the map just because the underlying vectors were negated.
    expect(Math.sign(negated.coords.get("a")!.x)).toBe(Math.sign(positive.coords.get("a")!.x));
  });

  it("reports low axis separation instead of pretending the axes are meaningful", () => {
    // Equal variance on both planted directions: λ1 ≈ λ2, so the pair can rotate freely
    // and the map's orientation genuinely is arbitrary. The caller needs to be told.
    const ring = Array.from({ length: 12 }, (_, i) => {
      const theta = (i / 12) * Math.PI * 2;
      return { id: `r${i}`, embedding: embedPoint(Math.cos(theta), Math.sin(theta)) };
    });
    const result = projectTo2D(ring);
    expect(result.axisSeparation).toBeLessThan(1.05);
    expect(Number.isFinite(result.axisSeparation)).toBe(true);
  });

  it("never emits NaN or Infinity on degenerate input", () => {
    const identical = Array.from({ length: 5 }, (_, i) => ({
      id: `same${i}`,
      embedding: embedPoint(1, 1),
    }));

    for (const rows of [
      [] as ProjectionInput[],
      [{ id: "solo", embedding: embedPoint(1, 0) }],
      [
        { id: "one", embedding: embedPoint(1, 0) },
        { id: "two", embedding: embedPoint(-1, 0) },
      ],
      identical,
    ]) {
      const result = projectTo2D(rows);
      for (const [, point] of result.coords) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
      expect(Number.isFinite(result.explainedVariance[0])).toBe(true);
      expect(Number.isFinite(result.sigma[0])).toBe(true);
    }

    // All-identical vectors are rank 0 after centering: everything lands at the origin
    // and there is no second component to report.
    const flat = projectTo2D(identical);
    expect(flat.coords.size).toBe(5);
    expect(flat.explainedVariance[1]).toBe(0);

    // Rank-1 data has no second axis either; y must be flat, not noise.
    const rank1 = projectTo2D([
      { id: "one", embedding: embedPoint(1, 0) },
      { id: "two", embedding: embedPoint(-1, 0) },
    ]);
    for (const [, point] of rank1.coords) expect(Math.abs(point.y)).toBeLessThan(1e-9);
  });

  it("skips malformed rows rather than throwing", () => {
    const result = projectTo2D([
      ...plantedRows(),
      { id: "short", embedding: [1, 2, 3] },
      { id: "empty", embedding: [] },
    ]);
    expect(result.coords.has("short")).toBe(false);
    expect(result.coords.has("empty")).toBe(false);
    expect(result.coords.size).toBe(PLANTED.length);
  });

  it("reports non-convergence honestly instead of silently returning garbage", () => {
    const result = projectTo2D(plantedRows(), { maxIterations: 1, tolerance: 1e-15 });
    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(1);
    for (const [, point] of result.coords) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("counts rows it had to re-normalize", () => {
    const scaled = plantedRows().map((r, i) =>
      i === 0 ? { ...r, embedding: r.embedding.map((x) => x * 4) } : r,
    );
    expect(projectTo2D(scaled).renormalized).toBeGreaterThan(0);
  });
});
