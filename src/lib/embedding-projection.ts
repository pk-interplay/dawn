/**
 * Project 1536-dimensional embeddings down to 2D for the admin constellation.
 *
 * Pure: no Supabase import, no I/O, no clock, no randomness beyond a fixed seed. That
 * is partly good hygiene and partly load-bearing — `src/**` is the only tree CI
 * typechecks and the only one `vitest.config.ts` runs, and this is the most
 * numerically delicate code in the app.
 *
 * ## Algorithm: block power iteration (2-column subspace iteration)
 *
 * Never form the 1536x1536 covariance matrix — 2.36M doubles and O(nd²) to build.
 * Iterate on the centered data matrix X (N x 1536) directly with a 1536 x 2 block V:
 *
 *     U = X · V            (N x 2)
 *     W = Xᵀ · U           (1536 x 2)
 *     re-orthonormalize W by Gram-Schmidt  →  V
 *
 * ~4·N·1536 multiply-adds per iteration; at N=300 that is under 2M ops, so tens of
 * milliseconds for a couple of hundred iterations. Performance is not the problem here.
 * STABILITY is: a projection that looks different on every reload is worse than no
 * projection, because the operator reads motion as meaning.
 *
 * Block iteration rather than power-iterate-then-deflate: no second matrix copy, both
 * components converge together, and orthogonality is maintained exactly instead of
 * accumulating drift.
 *
 * ## Why PCA and not t-SNE/UMAP
 *
 * t-SNE and UMAP are stochastic (so they need a seed anyway, no stability win), have
 * wrong defaults below a few hundred points, and — decisively — **their cluster sizes
 * and inter-cluster distances are not meaningful**. That is precisely the inference an
 * operator will draw off this map ("these two dots are close, so these people are
 * similar"). A chart that invites a false reading is worse than no chart.
 *
 * PCA on unit vectors also happens to be the same eigenproblem as classical MDS on the
 * cosine distances between them, which is what licenses the caption saying screen
 * distance approximates semantic distance.
 */

export interface ProjectionInput {
  id: string;
  embedding: number[];
}

export interface ProjectionResult {
  coords: Map<string, { x: number; y: number }>;
  /** Fraction of total variance captured by each axis. */
  explainedVariance: [number, number];
  /** λ1/λ2. Below ~1.05 the two axes are interchangeable and the map's orientation is arbitrary. */
  axisSeparation: number;
  /** Per-axis standard deviation, for viewport scaling. */
  sigma: [number, number];
  iterations: number;
  converged: boolean;
  /** Rows whose norm was off by more than 1e-3 and had to be re-normalized. */
  renormalized: number;
}

const DIMENSIONS = 1536;
const DEFAULT_MAX_ITERATIONS = 200;
const DEFAULT_TOLERANCE = 1e-9;
/** Fixed, never configurable: a different seed means a different basin, hence a different map. */
const SEED = 0x9e3779b9;
const EPSILON = 1e-12;

/** xorshift32 — deterministic, tiny, and good enough to seed an iteration. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function norm(v: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function emptyResult(coords: Map<string, { x: number; y: number }>): ProjectionResult {
  return {
    coords,
    explainedVariance: [0, 0],
    axisSeparation: 1,
    sigma: [0, 0],
    iterations: 0,
    converged: true,
    renormalized: 0,
  };
}

export function projectTo2D(
  rows: ProjectionInput[],
  opts?: { maxIterations?: number; tolerance?: number },
): ProjectionResult {
  const maxIterations = opts?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = opts?.tolerance ?? DEFAULT_TOLERANCE;

  // 1. Keep only well-formed rows.
  const valid = rows.filter(
    (r) => Array.isArray(r.embedding) && r.embedding.length === DIMENSIONS,
  );

  // 2. Sort by id. Floating-point summation is order-dependent, so without this the
  //    same population in a different row order yields bit-different coordinates and
  //    the map wiggles for no reason at all.
  valid.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = valid.length;
  if (n === 0) return emptyResult(new Map());
  if (n === 1) return emptyResult(new Map([[valid[0].id, { x: 0, y: 0 }]]));

  // 3. Copy into one flat buffer, normalizing any row whose norm drifted.
  //    OpenAI's text-embedding-3-small returns unit vectors; assert rather than assume.
  const X = new Float64Array(n * DIMENSIONS);
  let renormalized = 0;
  for (let i = 0; i < n; i++) {
    const row = valid[i].embedding;
    let sum = 0;
    for (let d = 0; d < DIMENSIONS; d++) sum += row[d] * row[d];
    const len = Math.sqrt(sum);
    if (len > EPSILON && Math.abs(len - 1) > 1e-3) {
      renormalized++;
      for (let d = 0; d < DIMENSIONS; d++) X[i * DIMENSIONS + d] = row[d] / len;
    } else {
      for (let d = 0; d < DIMENSIONS; d++) X[i * DIMENSIONS + d] = row[d];
    }
  }

  // 4. Center. MANDATORY: all embeddings of English prose are strongly correlated, so
  //    without centering PC1 becomes the population-mean direction and the whole cloud
  //    collapses into one blob at the far end of axis 1. This single step is the
  //    difference between a legible map and a smear.
  //
  //    Deliberately NOT whitened: per-dimension variance scaling assumes the dimensions
  //    are independently meaningful units. They are not, and whitening amplifies
  //    low-variance noise dimensions.
  const mean = new Float64Array(DIMENSIONS);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < DIMENSIONS; d++) mean[d] += X[i * DIMENSIONS + d];
  }
  for (let d = 0; d < DIMENSIONS; d++) mean[d] /= n;
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < DIMENSIONS; d++) X[i * DIMENSIONS + d] -= mean[d];
  }

  let totalVariance = 0;
  for (let i = 0; i < n * DIMENSIONS; i++) totalVariance += X[i] * X[i];

  // Rank-0: every vector identical, so centering zeroed everything. Guard explicitly —
  // dividing by a zero norm below would emit NaN, and a NaN coordinate renders as a
  // silently empty SVG, which reads as a loading bug rather than as degenerate data.
  if (totalVariance < EPSILON) {
    return emptyResult(new Map(valid.map((r) => [r.id, { x: 0, y: 0 }])));
  }

  // 5. Deterministic init, then Gram-Schmidt so the seed columns start orthonormal.
  const rng = makeRng(SEED);
  let v1 = new Float64Array(DIMENSIONS);
  let v2 = new Float64Array(DIMENSIONS);
  for (let d = 0; d < DIMENSIONS; d++) {
    v1[d] = rng() - 0.5;
    v2[d] = rng() - 0.5;
  }
  const n1 = norm(v1);
  for (let d = 0; d < DIMENSIONS; d++) v1[d] /= n1;
  const p = dot(v1, v2);
  for (let d = 0; d < DIMENSIONS; d++) v2[d] -= p * v1[d];
  const n2 = norm(v2);
  for (let d = 0; d < DIMENSIONS; d++) v2[d] /= n2;

  const u1 = new Float64Array(n);
  const u2 = new Float64Array(n);
  const w1 = new Float64Array(DIMENSIONS);
  const w2 = new Float64Array(DIMENSIONS);

  let iterations = 0;
  let converged = false;

  for (let it = 0; it < maxIterations; it++) {
    iterations = it + 1;

    // U = X · V
    for (let i = 0; i < n; i++) {
      const base = i * DIMENSIONS;
      let a = 0;
      let b = 0;
      for (let d = 0; d < DIMENSIONS; d++) {
        const x = X[base + d];
        a += x * v1[d];
        b += x * v2[d];
      }
      u1[i] = a;
      u2[i] = b;
    }

    // W = Xᵀ · U
    w1.fill(0);
    w2.fill(0);
    for (let i = 0; i < n; i++) {
      const base = i * DIMENSIONS;
      const a = u1[i];
      const b = u2[i];
      for (let d = 0; d < DIMENSIONS; d++) {
        const x = X[base + d];
        w1[d] += x * a;
        w2[d] += x * b;
      }
    }

    const wn1 = norm(w1);
    if (wn1 < EPSILON) break; // no variance left to extract
    for (let d = 0; d < DIMENSIONS; d++) w1[d] /= wn1;

    const proj = dot(w1, w2);
    for (let d = 0; d < DIMENSIONS; d++) w2[d] -= proj * w1[d];
    const wn2 = norm(w2);
    // Rank-1 data (e.g. N=2, or two distinct points): there is no second component.
    // Keep the existing v2 rather than dividing by ~0, and let the y axis come out flat.
    if (wn2 >= EPSILON) {
      for (let d = 0; d < DIMENSIONS; d++) w2[d] /= wn2;
    }

    // Convergence, sign-insensitive: ±v are the same axis, so a flip between iterations
    // is not a change. min(‖a−b‖, ‖a+b‖) is the distance between the two subspaces.
    let dMinus1 = 0;
    let dPlus1 = 0;
    let dMinus2 = 0;
    let dPlus2 = 0;
    for (let d = 0; d < DIMENSIONS; d++) {
      dMinus1 += (w1[d] - v1[d]) ** 2;
      dPlus1 += (w1[d] + v1[d]) ** 2;
      dMinus2 += (w2[d] - v2[d]) ** 2;
      dPlus2 += (w2[d] + v2[d]) ** 2;
    }
    const delta = Math.max(
      Math.sqrt(Math.min(dMinus1, dPlus1)),
      wn2 >= EPSILON ? Math.sqrt(Math.min(dMinus2, dPlus2)) : 0,
    );

    v1 = Float64Array.from(w1);
    v2 = Float64Array.from(w2);

    if (delta < tolerance) {
      converged = true;
      break;
    }
  }

  // 6. Project, then fix the sign.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * DIMENSIONS;
    let a = 0;
    let b = 0;
    for (let d = 0; d < DIMENSIONS; d++) {
      const x = X[base + d];
      a += x * v1[d];
      b += x * v2[d];
    }
    xs[i] = a;
    ys[i] = b;
  }

  applySignConvention(xs, v1);
  applySignConvention(ys, v2);

  // λᵢ = ‖X·Vᵢ‖². Both axes are orthonormal directions, so this is the variance along each.
  let lambda1 = 0;
  let lambda2 = 0;
  for (let i = 0; i < n; i++) {
    lambda1 += xs[i] * xs[i];
    lambda2 += ys[i] * ys[i];
  }

  const coords = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < n; i++) coords.set(valid[i].id, { x: xs[i], y: ys[i] });

  return {
    coords,
    explainedVariance: [lambda1 / totalVariance, lambda2 / totalVariance],
    axisSeparation: lambda2 > EPSILON ? lambda1 / lambda2 : Infinity,
    sigma: [Math.sqrt(lambda1 / n), Math.sqrt(lambda2 / n)],
    iterations,
    converged,
    renormalized,
  };
}

/**
 * Pin an axis's orientation deterministically.
 *
 * ±v are both valid principal components, and which one an iteration lands on depends
 * on floating-point details — so without this the map mirrors itself between reloads
 * and looks like different data. Three tiers, each a fallback for the previous being
 * measure-zero:
 *
 *   1. Skewness: sign(Σsᵢ³) ≥ 0. Real embedding data is never perfectly symmetric.
 *   2. Largest-magnitude loading is positive. Handles a symmetric score distribution.
 *   3. The first row (lowest id, since rows are id-sorted) projects ≥ 0. Always terminates.
 *
 * Mutates `scores` in place, and flips `basis` alongside so the two stay consistent.
 */
function applySignConvention(scores: Float64Array, basis: Float64Array): void {
  let skew = 0;
  for (let i = 0; i < scores.length; i++) skew += scores[i] ** 3;

  let flip: boolean;
  if (Math.abs(skew) > EPSILON) {
    flip = skew < 0;
  } else {
    let maxAbs = 0;
    let maxAt = 0;
    for (let d = 0; d < basis.length; d++) {
      const a = Math.abs(basis[d]);
      if (a > maxAbs) {
        maxAbs = a;
        maxAt = d;
      }
    }
    if (maxAbs > EPSILON) {
      flip = basis[maxAt] < 0;
    } else {
      flip = scores[0] < 0;
    }
  }

  if (!flip) return;
  for (let i = 0; i < scores.length; i++) scores[i] = -scores[i];
  for (let d = 0; d < basis.length; d++) basis[d] = -basis[d];
}
