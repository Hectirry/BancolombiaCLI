/**
 * Principal components, and what they can and cannot answer.
 *
 * Two different questions get asked of the same data here, and keeping them
 * apart is the whole point of this file.
 *
 * 1. UNSUPERVISED — "is there latent structure in the machine?" Principal
 *    component analysis on the 952 × 43 matrix of which balls came out. If some
 *    hidden factor drove the draws (a heavier ball, numbers that travel
 *    together, a seasonal drift), it would show up as a component carrying more
 *    variance than chance allows. Note what this cannot do: PCA is blind to any
 *    outcome, so it can never tell you "which variables influence winning". It
 *    can only say whether the draws have structure at all.
 *
 * 2. SUPERVISED — "which variables influence how much a winning combination is
 *    worth?" This one has a real answer, because there is a real response
 *    variable: how many tickets shared each prize. Regressing that on the
 *    characteristics of the drawn combination shows exactly which properties
 *    make a result crowded.
 *
 * The honest summary the two produce together: nothing predicts *which* numbers
 * come out; several things predict *how many people already had them*.
 */

import { MAIN_POOL, PRIZE_TIERS } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { FEATURES } from "./profile.ts";
import { makeRng, randInt, sampleDistinct } from "./random.ts";
import { MAIN_PICK, SUPER_POOL } from "./rules.ts";

/** Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations. */
export function symmetricEigen(
  input: number[][],
  sweeps = 100,
): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p]![q]! * a[p]![q]!;
    }
    if (off < 1e-18) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p]![q]!) < 1e-15) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;

        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = cos * akp - sin * akq;
          a[k]![q] = sin * akp + cos * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = cos * apk - sin * aqk;
          a[q]![k] = sin * apk + cos * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = cos * vkp - sin * vkq;
          v[k]![q] = sin * vkp + cos * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y]![y]! - a[x]![x]!);
  return {
    values: order.map((i) => a[i]![i]!),
    vectors: order.map((i) => v.map((row) => row[i]!)),
  };
}

/** Covariance matrix of the columns of `rows`. */
export function covariance(rows: number[][]): number[][] {
  const n = rows.length;
  const k = rows[0]?.length ?? 0;
  const means = new Array(k).fill(0);
  for (const row of rows) for (let j = 0; j < k; j++) means[j]! += row[j]! / n;

  const cov: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const row of rows) {
    for (let i = 0; i < k; i++) {
      const di = row[i]! - means[i]!;
      for (let j = i; j < k; j++) {
        const value = (di * (row[j]! - means[j]!)) / (n - 1);
        cov[i]![j]! += value;
        if (i !== j) cov[j]![i]! += value;
      }
    }
  }
  return cov;
}

/** The 0/1 matrix of which balls appeared in each draw. */
export function indicatorMatrix(draws: Draw[]): number[][] {
  return draws.map((draw) => {
    const row = new Array(MAIN_POOL).fill(0);
    for (const n of draw.main) row[n - 1] = 1;
    return row;
  });
}

export interface ComponentComparison {
  index: number;
  /** Share of total variance carried by this component in the real draws. */
  observed: number;
  /** Median share a fair machine gives the same component. */
  expected: number;
  /** Upper edge of the range a fair machine stays within. */
  upperBound: number;
  /** True when the real component carries more variance than chance allows. */
  exceedsChance: boolean;
}

export interface PcaReport {
  draws: number;
  components: ComponentComparison[];
  /** Components carrying more variance than a fair machine ever produces. */
  structureFound: number;
  /** Variance explained by the leading component, real and simulated. */
  leadingObserved: number;
  leadingExpected: number;
}

/**
 * Compare the eigenvalue spectrum of the real draws against fair machines.
 *
 * Any single sample produces a spread of eigenvalues purely by chance — the
 * largest is always bigger than the average, even in perfectly random data.
 * That is why the comparison is against simulated spectra of the same size
 * rather than against a flat line: the question is not "is the first component
 * larger?" but "is it larger than randomness alone would make it?".
 */
export function comparePcaToFair(
  draws: Draw[],
  histories = 300,
  seed = 20260815,
  report = 8,
): PcaReport {
  const observed = spectrum(indicatorMatrix(draws));

  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const simulated: number[][] = [];
  for (let h = 0; h < histories; h++) {
    const rows = Array.from({ length: draws.length }, () => {
      const row = new Array(MAIN_POOL).fill(0);
      for (const n of sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer)) row[n - 1] = 1;
      return row;
    });
    simulated.push(spectrum(rows));
  }

  const components: ComponentComparison[] = [];
  for (let i = 0; i < Math.min(report, observed.length); i++) {
    const column = simulated.map((s) => s[i]!).sort((a, b) => a - b);
    const median = column[Math.floor(column.length / 2)]!;
    const upper = column[Math.min(column.length - 1, Math.floor(0.975 * column.length))]!;
    components.push({
      index: i + 1,
      observed: observed[i]!,
      expected: median,
      upperBound: upper,
      exceedsChance: observed[i]! > upper,
    });
  }

  return {
    draws: draws.length,
    components,
    structureFound: components.filter((c) => c.exceedsChance).length,
    leadingObserved: components[0]?.observed ?? 0,
    leadingExpected: components[0]?.expected ?? 0,
  };
}

/** Proportion of total variance carried by each principal component. */
function spectrum(rows: number[][]): number[] {
  const { values } = symmetricEigen(covariance(rows));
  const total = values.reduce((a, b) => a + Math.max(b, 0), 0);
  return total > 0 ? values.map((v) => Math.max(v, 0) / total) : values.map(() => 0);
}

// ---------------------------------------------------------------------------
// The supervised half: what makes a winning combination crowded?
// ---------------------------------------------------------------------------

export interface RegressionTerm {
  name: string;
  description: string;
  /** Effect of a one-standard-deviation change, in standard deviations. */
  beta: number;
  standardError: number;
  tStatistic: number;
  significant: boolean;
}

export interface WinnerRegression {
  observations: number;
  /** Share of the variation in crowding the model explains. */
  rSquared: number;
  terms: RegressionTerm[];
}

/**
 * Which properties of the drawn combination predict how crowded the prizes are.
 *
 * The response is the share of winners who matched three or more numbers, out
 * of all winners in that draw. That ratio needs no estimate of how many tickets
 * were sold — it rises purely because the numbers that came out were ones many
 * players had already written down.
 */
export function regressWinnerCrowding(
  draws: Draw[],
  // `low-half` is dropped as collinear with `date-range` (it never reached
  // significance alongside it), and `decades` is included because leaving it
  // out makes `biggest-cluster` look significant when it is only proxying for
  // how many tens-blocks the numbers touch: adding it moves that coefficient
  // from -0.105 (t = -3.14) to +0.019 (t = 0.44).
  featureNames = ["date-range", "sum", "evens", "spread", "decades", "biggest-cluster"],
): WinnerRegression {
  const features = FEATURES.filter((f) => featureNames.includes(f.name));

  const responses: number[] = [];
  const rows: number[][] = [];
  draws.forEach((draw, i) => {
    if (!draw.tiers || draw.tiers.length !== PRIZE_TIERS.length) return;
    const byTier = new Map(draw.tiers.map((t) => [t.tier, t.winners]));
    const total = PRIZE_TIERS.reduce((a, t) => a + (byTier.get(t.id) ?? 0), 0);
    const skilled = ["5", "4+S", "4", "3+S", "3"].reduce((a, id) => a + (byTier.get(id) ?? 0), 0);
    if (total <= 0 || skilled <= 0) return;
    responses.push(Math.log(skilled / total));
    rows.push(features.map((f) => f.value(draw.main, draw.super, i > 0 ? draws[i - 1]!.main : null)));
  });

  const n = responses.length;
  if (n <= features.length + 1) {
    return { observations: n, rSquared: 0, terms: [] };
  }

  // Standardise so the coefficients are directly comparable to each other.
  const k = features.length;
  const means = new Array(k).fill(0);
  const sds = new Array(k).fill(0);
  for (const row of rows) for (let j = 0; j < k; j++) means[j]! += row[j]! / n;
  for (const row of rows) for (let j = 0; j < k; j++) sds[j]! += (row[j]! - means[j]!) ** 2 / n;
  for (let j = 0; j < k; j++) sds[j] = Math.sqrt(sds[j]!) || 1;

  const yMean = responses.reduce((a, b) => a + b, 0) / n;
  const ySd = Math.sqrt(responses.reduce((a, b) => a + (b - yMean) ** 2, 0) / n) || 1;
  const y = responses.map((v) => (v - yMean) / ySd);
  const x = rows.map((row) => [1, ...row.map((v, j) => (v - means[j]!) / sds[j]!)]);

  const p = k + 1;
  const xtx: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      xty[a]! += x[i]![a]! * y[i]!;
      for (let b = 0; b < p; b++) xtx[a]![b]! += x[i]![a]! * x[i]![b]!;
    }
  }

  const inverse = invert(xtx);
  if (!inverse) return { observations: n, rSquared: 0, terms: [] };
  const beta = inverse.map((row) => row.reduce((acc, value, j) => acc + value * xty[j]!, 0));

  let residual = 0;
  let totalSum = 0;
  for (let i = 0; i < n; i++) {
    const fitted = x[i]!.reduce((acc, value, j) => acc + value * beta[j]!, 0);
    residual += (y[i]! - fitted) ** 2;
    totalSum += y[i]! ** 2;
  }
  const sigmaSquared = residual / (n - p);

  return {
    observations: n,
    rSquared: totalSum > 0 ? 1 - residual / totalSum : 0,
    terms: features.map((feature, j) => {
      const standardError = Math.sqrt(sigmaSquared * inverse[j + 1]![j + 1]!);
      const t = standardError > 0 ? beta[j + 1]! / standardError : 0;
      return {
        name: feature.name,
        description: feature.description,
        beta: beta[j + 1]!,
        standardError,
        tStatistic: t,
        // Two-sided 5% with a Bonferroni correction across the terms tested.
        significant: Math.abs(t) > criticalT(features.length),
      };
    }),
  };
}

/** Normal approximation to the Bonferroni-corrected 5 % critical value. */
function criticalT(tests: number): number {
  // Solves Phi^-1(1 - 0.025/tests) closely enough for the sample sizes here.
  const alpha = 0.025 / Math.max(1, tests);
  let low = 0;
  let high = 8;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (normalTail(mid) > alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function normalTail(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return (1 - (x >= 0 ? erf : -erf)) / 2;
}

/** Gauss–Jordan inversion; returns null for a singular matrix. */
function invert(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];

    const divisor = a[col]![col]!;
    for (let j = 0; j < 2 * n; j++) a[col]![j]! /= divisor;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r]![j]! -= factor * a[col]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}

export { SUPER_POOL, randInt };
