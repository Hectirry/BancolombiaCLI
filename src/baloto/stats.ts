/**
 * Does the Baloto machine deviate from a fair, memoryless draw?
 *
 * This is the question any "prediction model" depends on: a model can only beat
 * chance if the past constrains the future. Each test below computes a
 * statistic on the real draws, then compares it against the distribution of the
 * same statistic over thousands of simulated fair draws. If the machine were
 * biased — a heavier ball, a number that avoids repeating, a weekday effect —
 * these are the tests that would show it.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { makeRng, monteCarloPValue, sampleDistinct, randInt } from "./random.ts";

export interface TestResult {
  id: string;
  /** What the test would detect if it fired. */
  question: string;
  statistic: number;
  /** Mean of the statistic across fair simulations, for context. */
  expected: number;
  pValue: number;
  /** Human-readable reading of the p-value. */
  verdict: "consistent with chance" | "borderline" | "deviates from chance";
}

export interface NumberFrequency {
  number: number;
  count: number;
  /** Observed minus expected, in standard deviations. */
  z: number;
  /** Draws since this number last appeared. */
  gap: number;
}

export interface StatsReport {
  draws: number;
  from: string;
  to: string;
  simulations: number;
  mainFrequencies: NumberFrequency[];
  superFrequencies: NumberFrequency[];
  tests: TestResult[];
}

function verdictFor(p: number): TestResult["verdict"] {
  if (p < 0.01) return "deviates from chance";
  if (p < 0.05) return "borderline";
  return "consistent with chance";
}

/** Pearson statistic against a uniform expectation. */
export function chiSquare(counts: number[], expected: number): number {
  let sum = 0;
  for (const c of counts) {
    const d = c - expected;
    sum += (d * d) / expected;
  }
  return sum;
}

function tally(draws: Draw[], pool: number, pick: (d: Draw) => number[]): number[] {
  const counts = new Array(pool).fill(0);
  for (const draw of draws) for (const n of pick(draw)) counts[n - 1]!++;
  return counts;
}

/** Frequency table with z-scores and current dry spells. */
export function frequencies(draws: Draw[], pool: number, pick: (d: Draw) => number[]): NumberFrequency[] {
  const counts = tally(draws, pool, pick);
  const perDraw = draws.length > 0 ? pick(draws[0]!).length : 1;
  const p = perDraw / pool;
  const n = draws.length;
  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));

  const lastSeen = new Array(pool).fill(-1);
  draws.forEach((draw, i) => {
    for (const num of pick(draw)) lastSeen[num - 1] = i;
  });

  return counts.map((count, i) => ({
    number: i + 1,
    count,
    z: sd > 0 ? (count - mean) / sd : 0,
    gap: lastSeen[i]! < 0 ? n : n - 1 - lastSeen[i]!,
  }));
}

/** Sum of the five main numbers — the classic "balanced ticket" folklore test. */
function sumStatistic(mains: number[][]): number[] {
  return mains.map((m) => m.reduce((a, b) => a + b, 0));
}

/** Chi-square of a sample against its own simulated bins. */
function binnedChiSquare(values: number[], min: number, max: number, bins: number): number {
  const counts = new Array(bins).fill(0);
  const width = (max - min + 1) / bins;
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width));
    counts[idx]!++;
  }
  return chiSquare(counts, values.length / bins);
}

/** How many numbers two consecutive draws share. */
function overlapStatistic(mains: number[][]): number {
  let total = 0;
  for (let i = 1; i < mains.length; i++) {
    const prev = new Set(mains[i - 1]!);
    for (const n of mains[i]!) if (prev.has(n)) total++;
  }
  return total;
}

/**
 * "Due number" test: if numbers that have been absent for a long time were more
 * likely to come up, the average dry spell of the numbers actually drawn would
 * be longer than chance predicts.
 */
function dueStatistic(mains: number[][], pool: number): number {
  const lastSeen = new Array(pool).fill(-1);
  let total = 0;
  let counted = 0;
  mains.forEach((main, i) => {
    for (const n of main) {
      if (lastSeen[n - 1]! >= 0) {
        total += i - lastSeen[n - 1]!;
        counted++;
      }
    }
    for (const n of main) lastSeen[n - 1] = i;
  });
  return counted > 0 ? total / counted : 0;
}

/** Largest number of draws in which any single pair of numbers co-occurred. */
function maxPairStatistic(mains: number[][], pool: number): number {
  const pairs = new Int32Array(pool * pool);
  let max = 0;
  for (const main of mains) {
    for (let a = 0; a < main.length; a++) {
      for (let b = a + 1; b < main.length; b++) {
        const idx = (main[a]! - 1) * pool + (main[b]! - 1);
        const v = ++pairs[idx]!;
        if (v > max) max = v;
      }
    }
  }
  return max;
}

/** Consecutive numbers within a single draw (e.g. 14-15) — folklore says "rare". */
function consecutiveStatistic(mains: number[][]): number {
  let total = 0;
  for (const main of mains) {
    for (let i = 1; i < main.length; i++) if (main[i]! === main[i - 1]! + 1) total++;
  }
  return total;
}

interface Simulator {
  id: string;
  question: string;
  observed: number;
  /** Statistic over one simulated history of the same length. */
  simulate: (mains: number[][], supers: number[]) => number;
}

/**
 * Run every test against `simulations` synthetic histories of the same size.
 * One simulated history serves all tests, so the cost is linear in the number
 * of simulations rather than in the number of tests.
 */
export function analyse(draws: Draw[], simulations = 10_000, seed = 20260815): StatsReport {
  const mains = draws.map((d) => d.main);
  const supers = draws.map((d) => d.super);
  const n = draws.length;

  const mainExpected = (n * MAIN_PICK) / MAIN_POOL;
  const superExpected = n / SUPER_POOL;
  const sums = sumStatistic(mains);

  const tests: Simulator[] = [
    {
      id: "main-uniformity",
      question: "Is any of the 43 balls drawn more often than the rest?",
      observed: chiSquare(tally(draws, MAIN_POOL, (d) => d.main), mainExpected),
      simulate: (m) => chiSquare(countOf(m, MAIN_POOL), mainExpected),
    },
    {
      id: "super-uniformity",
      question: "Is the Súper Balota machine biased towards some number?",
      observed: chiSquare(tally(draws, SUPER_POOL, (d) => [d.super]), superExpected),
      simulate: (_m, s) => chiSquare(countOf(s.map((x) => [x]), SUPER_POOL), superExpected),
    },
    {
      id: "serial-overlap",
      question: "Do numbers from one draw carry over into the next?",
      observed: overlapStatistic(mains),
      simulate: (m) => overlapStatistic(m),
    },
    {
      id: "due-numbers",
      question: "Are numbers that have been absent for longer more likely to appear?",
      observed: dueStatistic(mains, MAIN_POOL),
      simulate: (m) => dueStatistic(m, MAIN_POOL),
    },
    {
      id: "pair-affinity",
      question: "Do some pairs of numbers travel together more than chance allows?",
      observed: maxPairStatistic(mains, MAIN_POOL),
      simulate: (m) => maxPairStatistic(m, MAIN_POOL),
    },
    {
      id: "sum-shape",
      question: "Is the sum of the five numbers distributed unusually?",
      observed: binnedChiSquare(sums, 15, 205, 10),
      simulate: (m) => binnedChiSquare(sumStatistic(m), 15, 205, 10),
    },
    {
      id: "consecutive-pairs",
      question: "Do consecutive numbers (14-15) come up less often than chance?",
      observed: consecutiveStatistic(mains),
      simulate: (m) => consecutiveStatistic(m),
    },
  ];

  const samples: number[][] = tests.map(() => []);
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  for (let s = 0; s < simulations; s++) {
    const simMains: number[][] = new Array(n);
    const simSupers: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      simMains[i] = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
      simSupers[i] = 1 + randInt(rng, SUPER_POOL);
    }
    for (let t = 0; t < tests.length; t++) {
      samples[t]!.push(tests[t]!.simulate(simMains, simSupers));
    }
  }

  const results: TestResult[] = tests.map((test, i) => {
    const sample = samples[i]!;
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    // Two-sided where the statistic can deviate either way, one-sided for the
    // chi-square style statistics that are large only under an alternative.
    const twoSided = ["serial-overlap", "due-numbers", "consecutive-pairs"].includes(test.id);
    const p = twoSided
      ? twoSidedPValue(test.observed, sample)
      : monteCarloPValue(test.observed, sample);
    return {
      id: test.id,
      question: test.question,
      statistic: test.observed,
      expected: mean,
      pValue: p,
      verdict: verdictFor(p),
    };
  });

  return {
    draws: n,
    from: draws[0]?.date ?? "",
    to: draws[n - 1]?.date ?? "",
    simulations,
    mainFrequencies: frequencies(draws, MAIN_POOL, (d) => d.main),
    superFrequencies: frequencies(draws, SUPER_POOL, (d) => [d.super]),
    tests: results,
  };
}

function countOf(groups: number[][], pool: number): number[] {
  const counts = new Array(pool).fill(0);
  for (const g of groups) for (const n of g) counts[n - 1]!++;
  return counts;
}

/** Monte Carlo p-value for a statistic that can be extreme in either tail. */
function twoSidedPValue(observed: number, sample: number[]): number {
  let below = 0;
  let above = 0;
  for (const v of sample) {
    if (v <= observed) below++;
    if (v >= observed) above++;
  }
  return Math.min(1, (2 * (Math.min(below, above) + 1)) / (sample.length + 1));
}
