/**
 * Could a ball be physically biased — and would we be able to tell?
 *
 * This is the one folk theory about lotteries that has genuinely worked in the
 * past. Biased roulette wheels were profitably exploited in the 19th century,
 * and gravity-pick lottery machines have been found off-balance often enough
 * that operators now rotate several certified ball sets and weigh them. So the
 * question deserves a real test rather than an appeal to "it's random".
 *
 * Two things are measured here, and the second matters more than the first.
 *
 * 1. LOCALISED BIAS. Every earlier test assumed a bias constant across all
 *    952 draws. But ball sets get rotated and retired, so a set that ran heavy
 *    for six months would be diluted into invisibility by eight years of
 *    averaging. This scans every window of the history for any ball running
 *    hot in that window — and takes the *maximum* deviation found anywhere,
 *    compared against the maximum a fair machine produces under the same scan.
 *    Comparing the maximum is what makes the search honest: look at thousands
 *    of window-and-ball combinations and some will always look extreme.
 *
 * 2. POWER. The more important question is not "did we find a bias?" but "how
 *    big would one have to be before we could?". A test that cannot detect the
 *    bias that would matter tells you nothing when it comes back clean. The
 *    power curve puts a number on it, and the answer for Baloto is
 *    uncomfortable in a specific, useful way.
 */

import { MAIN_PICK, MAIN_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { makeRng, randInt } from "./random.ts";

/** Draw five distinct balls where ball `heavy` is `1 + bias` times likelier. */
function biasedDraw(
  rng: () => number,
  heavy: Set<number>,
  bias: number,
  buffer: Float64Array,
): number[] {
  for (let i = 0; i < MAIN_POOL; i++) buffer[i] = heavy.has(i + 1) ? 1 + bias : 1;
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < MAIN_POOL; i++) total += buffer[i]!;

  for (let pick = 0; pick < MAIN_PICK; pick++) {
    let target = rng() * total;
    let chosen = MAIN_POOL - 1;
    for (let i = 0; i < MAIN_POOL; i++) {
      if (buffer[i]! <= 0) continue;
      target -= buffer[i]!;
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    out.push(chosen + 1);
    total -= buffer[chosen]!;
    buffer[chosen] = 0;
  }
  return out.sort((a, b) => a - b);
}

export interface HotSpot {
  number: number;
  windowSize: number;
  from: string;
  to: string;
  count: number;
  expected: number;
  z: number;
}

export interface ScanReport {
  draws: number;
  windowSizes: number[];
  /** Windows × balls examined. */
  comparisons: number;
  /** Largest deviation found anywhere in the real history. */
  observedMaxZ: number;
  /** Largest deviation a fair machine typically produces under the same scan. */
  expectedMaxZ: number;
  /** Value the fair machine exceeds only 5 % of the time. */
  criticalMaxZ: number;
  pValue: number;
  hottest: HotSpot | null;
  biasFound: boolean;
}

/** Largest standardised excess of any ball in any window of the history. */
function maxWindowZ(
  mains: number[][],
  windowSizes: number[],
  dates: string[] | null,
): { z: number; spot: HotSpot | null; comparisons: number } {
  let best = 0;
  let spot: HotSpot | null = null;
  let comparisons = 0;
  const p = MAIN_PICK / MAIN_POOL;

  for (const windowSize of windowSizes) {
    if (mains.length < windowSize) continue;
    const counts = new Int32Array(MAIN_POOL);
    for (let i = 0; i < windowSize; i++) {
      for (const n of mains[i]!) counts[n - 1]!++;
    }
    const expected = windowSize * p;
    const sd = Math.sqrt(windowSize * p * (1 - p));

    for (let start = 0; ; start++) {
      for (let ball = 0; ball < MAIN_POOL; ball++) {
        comparisons++;
        const z = (counts[ball]! - expected) / sd;
        if (Math.abs(z) > best) {
          best = Math.abs(z);
          spot = dates
            ? {
                number: ball + 1,
                windowSize,
                from: dates[start]!,
                to: dates[start + windowSize - 1]!,
                count: counts[ball]!,
                expected,
                z,
              }
            : null;
        }
      }
      if (start + windowSize >= mains.length) break;
      for (const n of mains[start]!) counts[n - 1]!--;
      for (const n of mains[start + windowSize]!) counts[n - 1]!++;
    }
  }
  return { z: best, spot, comparisons };
}

/**
 * Scan the history for a ball running hot in any stretch of it.
 *
 * A bias that came and went with one ball set would be invisible to a test
 * averaged over the whole history; this is the test that would catch it.
 */
export function scanForLocalBias(
  draws: Draw[],
  windowSizes = [50, 100, 200],
  simulations = 400,
  seed = 20260815,
): ScanReport {
  const mains = draws.map((d) => d.main);
  const dates = draws.map((d) => d.date);
  const observed = maxWindowZ(mains, windowSizes, dates);

  const rng = makeRng(seed);
  const buffer = new Float64Array(MAIN_POOL);
  const nullMaxima: number[] = [];
  for (let s = 0; s < simulations; s++) {
    const simulated = Array.from({ length: mains.length }, () =>
      biasedDraw(rng, new Set(), 0, buffer),
    );
    nullMaxima.push(maxWindowZ(simulated, windowSizes, null).z);
  }
  nullMaxima.sort((a, b) => a - b);

  const median = nullMaxima[Math.floor(nullMaxima.length / 2)]!;
  const critical = nullMaxima[Math.floor(0.95 * nullMaxima.length)]!;
  let atLeast = 0;
  for (const value of nullMaxima) if (value >= observed.z) atLeast++;

  return {
    draws: draws.length,
    windowSizes,
    comparisons: observed.comparisons,
    observedMaxZ: observed.z,
    expectedMaxZ: median,
    criticalMaxZ: critical,
    pValue: (atLeast + 1) / (nullMaxima.length + 1),
    hottest: observed.spot,
    biasFound: observed.z > critical,
  };
}

export interface PowerPoint {
  /** How much likelier the affected balls are, e.g. 0.1 = 10 % more often. */
  bias: number;
  /** Chance the whole-history uniformity test notices, at 5 % significance. */
  detectionRate: number;
  /** Typical deviation such a ball would show over the full history. */
  typicalZ: number;
}

/**
 * How large a bias would have to be before this much data could see it.
 *
 * Run after a clean result, this is what turns "we found nothing" into a
 * quantified statement: nothing *of at least this size* is there.
 */
export function biasPowerCurve(
  historyLength: number,
  biases = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5],
  simulations = 300,
  seed = 424242,
): PowerPoint[] {
  const rng = makeRng(seed);
  const buffer = new Float64Array(MAIN_POOL);
  const p = MAIN_PICK / MAIN_POOL;
  const expected = historyLength * p;
  const sd = Math.sqrt(historyLength * p * (1 - p));

  // Critical value for the largest deviation among 43 balls, from fair runs.
  const fairMaxima: number[] = [];
  for (let s = 0; s < simulations; s++) {
    const counts = new Int32Array(MAIN_POOL);
    for (let d = 0; d < historyLength; d++) {
      for (const n of biasedDraw(rng, new Set(), 0, buffer)) counts[n - 1]!++;
    }
    let max = 0;
    for (let b = 0; b < MAIN_POOL; b++) {
      max = Math.max(max, Math.abs((counts[b]! - expected) / sd));
    }
    fairMaxima.push(max);
  }
  fairMaxima.sort((a, b) => a - b);
  const critical = fairMaxima[Math.floor(0.95 * fairMaxima.length)]!;

  // Five heavy balls is the case that matters: it is what a player would need
  // in order to fill a ticket with them.
  const heavy = new Set([7, 17, 23, 31, 41]);
  return biases.map((bias) => {
    let detected = 0;
    let zSum = 0;
    for (let s = 0; s < simulations; s++) {
      const counts = new Int32Array(MAIN_POOL);
      for (let d = 0; d < historyLength; d++) {
        for (const n of biasedDraw(rng, heavy, bias, buffer)) counts[n - 1]!++;
      }
      let max = 0;
      for (let b = 0; b < MAIN_POOL; b++) {
        max = Math.max(max, Math.abs((counts[b]! - expected) / sd));
      }
      if (max > critical) detected++;
      zSum += ([...heavy].reduce((a, n) => a + (counts[n - 1]! - expected) / sd, 0) / heavy.size);
    }
    return {
      bias,
      detectionRate: detected / simulations,
      typicalZ: zSum / simulations,
    };
  });
}

/**
 * The bias that would be needed to make a ticket break even.
 *
 * The jackpot dominates the expected value at a large roll-over, and a ticket
 * made of five biased balls has its jackpot chance multiplied by roughly
 * (1 + bias)^5, so the requirement follows directly from the current return.
 */
export function breakevenBias(jackpotContribution: number, otherContribution: number, ticketPrice: number): number {
  if (jackpotContribution <= 0) return Infinity;
  const required = (ticketPrice - otherContribution) / jackpotContribution;
  return required <= 0 ? 0 : required ** (1 / MAIN_PICK) - 1;
}
