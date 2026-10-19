/**
 * Structural profile of the real draws against a simulated fair machine.
 *
 * The tests in `stats.ts` ask seven aggregate questions. This asks a much wider
 * one: take every structural property a person might notice in a result — the
 * sum, how spread out the numbers are, how many are even, how many decades they
 * touch, how many carried over from the previous draw — and check each of them
 * against millions of draws from a machine known to be fair.
 *
 * If Baloto had a fingerprint, this is where it would show. Two things keep the
 * exercise honest:
 *
 *  - each feature is tested twice, once on its average and once on the shape of
 *    its whole distribution, because a bias can move one without the other;
 *  - the p-values are corrected for multiple comparisons. Testing twenty
 *    features and reporting the best one is how people "discover" patterns in
 *    noise; Holm's correction is what stops that.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { makeRng, randInt, sampleDistinct } from "./random.ts";

/** A property of a single draw, possibly relative to the one before it. */
export interface DrawFeature {
  name: string;
  description: string;
  value: (main: number[], superBall: number, previous: number[] | null) => number;
  /** Bin width used when comparing whole distributions. */
  binWidth?: number;
}

const PRIMES = new Set([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43]);

const decadeOf = (n: number): number => Math.min(4, Math.floor(n / 10));

function gaps(main: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < main.length; i++) out.push(main[i]! - main[i - 1]!);
  return out;
}

/** Every structural property compared against the fair machine. */
export const FEATURES: DrawFeature[] = [
  {
    name: "sum",
    description: "Sum of the five numbers",
    value: (m) => m.reduce((a, b) => a + b, 0),
    binWidth: 10,
  },
  {
    name: "spread",
    description: "Distance from the lowest to the highest number",
    value: (m) => m[m.length - 1]! - m[0]!,
    binWidth: 4,
  },
  {
    name: "lowest",
    description: "The smallest number drawn",
    value: (m) => m[0]!,
    binWidth: 2,
  },
  {
    name: "highest",
    description: "The largest number drawn",
    value: (m) => m[m.length - 1]!,
    binWidth: 2,
  },
  {
    name: "evens",
    description: "How many of the five are even",
    value: (m) => m.filter((n) => n % 2 === 0).length,
  },
  {
    name: "low-half",
    description: "How many are 21 or below",
    value: (m) => m.filter((n) => n <= 21).length,
  },
  {
    name: "date-range",
    description: "How many are 31 or below (the birthday range)",
    value: (m) => m.filter((n) => n <= 31).length,
  },
  {
    name: "consecutive",
    description: "Adjacent pairs such as 14-15",
    value: (m) => gaps(m).filter((g) => g === 1).length,
  },
  {
    name: "max-gap",
    description: "Largest hole between two neighbouring numbers",
    value: (m) => Math.max(...gaps(m)),
    binWidth: 3,
  },
  {
    name: "min-gap",
    description: "Smallest hole between two neighbouring numbers",
    value: (m) => Math.min(...gaps(m)),
    binWidth: 2,
  },
  {
    name: "decades",
    description: "How many different tens-blocks the numbers touch",
    value: (m) => new Set(m.map(decadeOf)).size,
  },
  {
    name: "biggest-cluster",
    description: "Most numbers falling inside one tens-block",
    value: (m) => {
      const counts = new Map<number, number>();
      for (const n of m) counts.set(decadeOf(n), (counts.get(decadeOf(n)) ?? 0) + 1);
      return Math.max(...counts.values());
    },
  },
  {
    name: "primes",
    description: "How many are prime numbers",
    value: (m) => m.filter((n) => PRIMES.has(n)).length,
  },
  {
    name: "multiples-of-5",
    description: "How many are multiples of five",
    value: (m) => m.filter((n) => n % 5 === 0).length,
  },
  {
    name: "last-digits",
    description: "How many different final digits appear",
    value: (m) => new Set(m.map((n) => n % 10)).size,
  },
  {
    name: "dispersion",
    description: "Standard deviation of the five numbers",
    value: (m) => {
      const mean = m.reduce((a, b) => a + b, 0) / m.length;
      return Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / m.length);
    },
    binWidth: 1.5,
  },
  {
    name: "super-balota",
    description: "Value of the Súper Balota",
    value: (_m, s) => s,
  },
  {
    name: "carry-over",
    description: "Numbers repeated from the previous draw",
    value: (m, _s, previous) => (previous ? m.filter((n) => previous.includes(n)).length : 0),
  },
  {
    name: "near-miss",
    description: "Numbers landing next to one from the previous draw",
    value: (m, _s, previous) =>
      previous ? m.filter((n) => previous.some((p) => Math.abs(p - n) === 1)).length : 0,
  },
];

export interface FeatureComparison {
  name: string;
  description: string;
  /** Average across the real draws. */
  observed: number;
  /** Average a fair machine produces. */
  expected: number;
  /** How many standard errors apart those two averages are. */
  z: number;
  /** p-value for the average being different. */
  meanPValue: number;
  /** p-value for the whole distribution having a different shape. */
  shapePValue: number;
  /** Smaller of the two, after correcting for how many features were tested. */
  adjustedPValue: number;
  significant: boolean;
}

export interface ProfileReport {
  draws: number;
  simulatedDraws: number;
  histories: number;
  features: FeatureComparison[];
  /** Features still significant after the multiple-comparison correction. */
  patternsFound: number;
  /** Features that would have looked significant without the correction. */
  falseLeads: number;
}

/** Standard normal tail probability, two-sided. */
function normalTwoSided(z: number): number {
  // Abramowitz & Stegun 7.1.26 for erf.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.max(Math.min(1 - y, 1), Number.MIN_VALUE);
}

/** Holm–Bonferroni: control the chance of *any* false discovery. */
function holmAdjust(pValues: number[]): number[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array(pValues.length).fill(0);
  let running = 0;
  order.forEach((entry, rank) => {
    running = Math.max(running, (pValues.length - rank) * entry.p);
    adjusted[entry.i] = Math.min(1, running);
  });
  return adjusted;
}

function binIndex(value: number, min: number, width: number): number {
  return Math.floor((value - min) / width);
}

/**
 * Compare the real draws against a simulated fair machine, feature by feature.
 *
 * `simulatedDraws` sets how precisely the fair machine's own behaviour is
 * pinned down; `histories` is how many synthetic seasons are used to work out
 * how much a distribution's shape wobbles by chance alone.
 */
export function profileDraws(
  draws: Draw[],
  simulatedDraws = 400_000,
  histories = 2_000,
  seed = 20260815,
): ProfileReport {
  const n = draws.length;
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);

  // A large pool of draws from a machine that is fair by construction.
  const poolMain: number[][] = new Array(simulatedDraws);
  const poolSuper = new Int32Array(simulatedDraws);
  for (let i = 0; i < simulatedDraws; i++) {
    poolMain[i] = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
    poolSuper[i] = 1 + randInt(rng, SUPER_POOL);
  }

  const comparisons: FeatureComparison[] = [];
  const meanPs: number[] = [];
  const shapePs: number[] = [];

  for (const feature of FEATURES) {
    // Feature values for the fair machine and for the real draws.
    const simValues = new Float64Array(simulatedDraws);
    for (let i = 0; i < simulatedDraws; i++) {
      simValues[i] = feature.value(poolMain[i]!, poolSuper[i]!, i > 0 ? poolMain[i - 1]! : null);
    }
    const realValues = draws.map((d, i) =>
      feature.value(d.main, d.super, i > 0 ? draws[i - 1]!.main : null),
    );

    let simSum = 0;
    for (let i = 0; i < simulatedDraws; i++) simSum += simValues[i]!;
    const simMean = simSum / simulatedDraws;
    let simVar = 0;
    for (let i = 0; i < simulatedDraws; i++) simVar += (simValues[i]! - simMean) ** 2;
    simVar /= simulatedDraws;

    const realMean = realValues.reduce((a, b) => a + b, 0) / n;
    const standardError = Math.sqrt(simVar / n);
    const z = standardError > 0 ? (realMean - simMean) / standardError : 0;
    const meanP = normalTwoSided(z);

    // Shape test: bin both distributions and compare with a chi-square whose
    // null distribution comes from synthetic seasons of the same length.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < simulatedDraws; i++) {
      if (simValues[i]! < min) min = simValues[i]!;
      if (simValues[i]! > max) max = simValues[i]!;
    }
    for (const v of realValues) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const width = feature.binWidth ?? 1;
    const bins = Math.max(2, Math.min(40, binIndex(max, min, width) + 1));
    const expectedProbabilities = new Float64Array(bins);
    for (let i = 0; i < simulatedDraws; i++) {
      expectedProbabilities[Math.min(bins - 1, binIndex(simValues[i]!, min, width))]!++;
    }
    for (let b = 0; b < bins; b++) expectedProbabilities[b]! /= simulatedDraws;

    const chiSquareOf = (counts: Float64Array): number => {
      let stat = 0;
      for (let b = 0; b < bins; b++) {
        const expected = expectedProbabilities[b]! * n;
        // Bins a fair machine essentially never visits carry no information.
        if (expected < 5) continue;
        stat += (counts[b]! - expected) ** 2 / expected;
      }
      return stat;
    };

    const realCounts = new Float64Array(bins);
    for (const v of realValues) realCounts[Math.min(bins - 1, binIndex(v, min, width))]!++;
    const realStat = chiSquareOf(realCounts);

    let atLeastAsExtreme = 0;
    const sample = new Float64Array(bins);
    for (let h = 0; h < histories; h++) {
      sample.fill(0);
      for (let i = 0; i < n; i++) {
        const value = simValues[randInt(rng, simulatedDraws)]!;
        sample[Math.min(bins - 1, binIndex(value, min, width))]!++;
      }
      if (chiSquareOf(sample) >= realStat) atLeastAsExtreme++;
    }
    const shapeP = (atLeastAsExtreme + 1) / (histories + 1);

    meanPs.push(meanP);
    shapePs.push(shapeP);
    comparisons.push({
      name: feature.name,
      description: feature.description,
      observed: realMean,
      expected: simMean,
      z,
      meanPValue: meanP,
      shapePValue: shapeP,
      adjustedPValue: 1,
      significant: false,
    });
  }

  // Correct across every test that was run — both families together.
  const adjusted = holmAdjust([...meanPs, ...shapePs]);
  comparisons.forEach((comparison, i) => {
    comparison.adjustedPValue = Math.min(adjusted[i]!, adjusted[i + comparisons.length]!);
    comparison.significant = comparison.adjustedPValue < 0.05;
  });

  return {
    draws: n,
    simulatedDraws,
    histories,
    features: comparisons,
    patternsFound: comparisons.filter((c) => c.significant).length,
    falseLeads: comparisons.filter(
      (c) => !c.significant && Math.min(c.meanPValue, c.shapePValue) < 0.05,
    ).length,
  };
}

/**
 * The central range a fair machine keeps a feature inside, used to generate
 * tickets that look like plausible results instead of obvious constructions.
 */
export interface TypicalRange {
  name: string;
  low: number;
  high: number;
}

export function typicalRanges(
  featureNames: string[],
  coverage = 0.8,
  simulatedDraws = 100_000,
  seed = 4242,
): TypicalRange[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const features = FEATURES.filter((f) => featureNames.includes(f.name));
  const values = features.map(() => new Float64Array(simulatedDraws));

  let previous: number[] | null = null;
  for (let i = 0; i < simulatedDraws; i++) {
    const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
    const superBall = 1 + randInt(rng, SUPER_POOL);
    features.forEach((f, k) => {
      values[k]![i] = f.value(main, superBall, previous);
    });
    previous = main;
  }

  const tail = (1 - coverage) / 2;
  return features.map((feature, k) => {
    const sorted = Array.from(values[k]!).sort((a, b) => a - b);
    return {
      name: feature.name,
      low: sorted[Math.floor(tail * sorted.length)]!,
      high: sorted[Math.min(sorted.length - 1, Math.floor((1 - tail) * sorted.length))]!,
    };
  });
}

/** Whether a combination sits inside the fair machine's central range. */
export function looksTypical(main: number[], superBall: number, ranges: TypicalRange[]): boolean {
  for (const range of ranges) {
    const feature = FEATURES.find((f) => f.name === range.name);
    if (!feature) continue;
    const value = feature.value(main, superBall, null);
    if (value < range.low || value > range.high) return false;
  }
  return true;
}
