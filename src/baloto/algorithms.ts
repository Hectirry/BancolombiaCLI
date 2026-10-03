/**
 * Algorithms people propose for *predicting* the winning numbers, scored the
 * only way that means anything: walk-forward, each one seeing nothing but the
 * draws before the one it bets on, against the 5·5/43 = 0.581 matches per
 * ticket that a blind guess earns.
 *
 * The suite already knows the folk systems (`backtest.ts`: hot, cold, due,
 * repeat, birthdays). This file holds the ones that sound like statistics —
 * Markov transitions, pairwise affinity, nearest-neighbour recall, the delta
 * system, a per-ball logistic regression on lag features, and a periodogram —
 * so that "but have you tried machine learning?" has a measured answer rather
 * than an argued one. Every strategy here plugs into `backtest()`.
 *
 * The periodicity question also gets a proper test of its own: Fisher's
 * g-statistic on each ball's indicator series, with the threshold corrected
 * for looking at all forty-three balls at once.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import type { Combination } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import type { Strategy } from "./backtest.ts";
import type { SuperRule } from "./superball.ts";

const chance = (MAIN_PICK * MAIN_PICK) / MAIN_POOL;

/** Indices 1..pool ranked by `score`, best first (or worst first). */
function rank(pool: number, score: (n: number) => number, ascending = false): number[] {
  const rows: { n: number; s: number }[] = [];
  for (let n = 1; n <= pool; n++) rows.push({ n, s: score(n) });
  // Ties are broken by number so that a strategy is deterministic given history.
  rows.sort((a, b) => (ascending ? a.s - b.s : b.s - a.s) || a.n - b.n);
  return rows.map((r) => r.n);
}

const topMain = (score: (n: number) => number, ascending = false): number[] =>
  rank(MAIN_POOL, score, ascending).slice(0, MAIN_PICK).sort((a, b) => a - b);

/**
 * Strategies receive a fresh `history` slice every call and the backtest
 * repeats itself for the random strategies' sake, so a deterministic strategy
 * that does real work caches its answer by history length.
 */
function memo<T>(compute: (history: Draw[]) => T): (history: Draw[]) => T {
  let lastLength = -1;
  let lastValue: T | undefined;
  return (history) => {
    if (history.length !== lastLength || lastValue === undefined) {
      lastLength = history.length;
      lastValue = compute(history);
    }
    return lastValue;
  };
}

/**
 * For models that are expensive to fit and change slowly — a regression over
 * the whole history, a spectrum — refit every `stride` draws and reuse the fit
 * in between. The *prediction* still uses the latest history.
 */
function memoFit<M>(fit: (history: Draw[]) => M, stride = 25): (history: Draw[]) => M {
  let fittedAt = -1;
  let model: M | undefined;
  return (history) => {
    const epoch = Math.floor(history.length / stride);
    if (model === undefined || epoch !== fittedAt) {
      fittedAt = epoch;
      model = fit(history);
    }
    return model;
  };
}

// ---------------------------------------------------------------------------
// Markov transitions: which numbers tend to follow the ones just drawn?
// ---------------------------------------------------------------------------

function transitionScores(history: Draw[]): number[] {
  const score = new Array<number>(MAIN_POOL + 1).fill(0);
  if (history.length < 2) return score;
  const last = history[history.length - 1]!.main;
  const lastSet = new Set(last);
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!.main;
    let overlap = 0;
    for (const n of prev) if (lastSet.has(n)) overlap++;
    if (overlap === 0) continue;
    // Weight the following draw by how much its predecessor resembled now.
    for (const n of history[i]!.main) score[n]! += overlap;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Pairwise affinity: numbers that keep appearing together.
// ---------------------------------------------------------------------------

function pairCounts(history: Draw[]): Float64Array {
  const counts = new Float64Array((MAIN_POOL + 1) * (MAIN_POOL + 1));
  for (const d of history) {
    for (let a = 0; a < d.main.length; a++) {
      for (let b = a + 1; b < d.main.length; b++) {
        const x = d.main[a]!;
        const y = d.main[b]!;
        counts[x * (MAIN_POOL + 1) + y]!++;
        counts[y * (MAIN_POOL + 1) + x]!++;
      }
    }
  }
  return counts;
}

/** Greedy: start from the most frequent number, add whatever pairs best with the set. */
function affinityTicket(history: Draw[]): number[] {
  const pairs = pairCounts(history);
  const freq = new Array<number>(MAIN_POOL + 1).fill(0);
  for (const d of history) for (const n of d.main) freq[n]!++;
  const chosen: number[] = [rank(MAIN_POOL, (n) => freq[n]!)[0]!];
  while (chosen.length < MAIN_PICK) {
    let best = -1;
    let bestScore = -1;
    for (let n = 1; n <= MAIN_POOL; n++) {
      if (chosen.includes(n)) continue;
      let s = 0;
      for (const c of chosen) s += pairs[c * (MAIN_POOL + 1) + n]!;
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    chosen.push(best);
  }
  return chosen.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Nearest neighbours: find past draws most like the last one; play what came next.
// ---------------------------------------------------------------------------

function neighbourScores(history: Draw[], k = 25): number[] {
  const score = new Array<number>(MAIN_POOL + 1).fill(0);
  if (history.length < 2) return score;
  const last = history[history.length - 1]!;
  const lastSet = new Set(last.main);
  const sims: { i: number; sim: number }[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    const d = history[i]!;
    let overlap = 0;
    for (const n of d.main) if (lastSet.has(n)) overlap++;
    // Sum plus spread: two draws with the same numbers *and* a similar sum are closer.
    const sumGap = Math.abs(sum(d.main) - sum(last.main)) / (MAIN_POOL * MAIN_PICK);
    sims.push({ i, sim: overlap - sumGap });
  }
  sims.sort((a, b) => b.sim - a.sim || b.i - a.i);
  for (const { i } of sims.slice(0, k)) for (const n of history[i + 1]!.main) score[n]!++;
  return score;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// The delta system: sample the gaps between sorted numbers from history.
// ---------------------------------------------------------------------------

function deltaTicket(history: Draw[], rng: () => number): number[] {
  if (history.length === 0) return [1, 2, 3, 4, 5];
  // Pool every observed delta sequence and draw one; then jitter the start so
  // the ticket is not literally a past draw.
  const d = history[Math.floor(rng() * history.length)]!.main;
  const deltas = [d[0]!];
  for (let i = 1; i < d.length; i++) deltas.push(d[i]! - d[i - 1]!);
  for (let attempt = 0; attempt < 50; attempt++) {
    const start = Math.max(1, Math.min(MAIN_POOL, deltas[0]! + Math.floor(rng() * 7) - 3));
    const ticket = [start];
    for (let i = 1; i < deltas.length; i++) ticket.push(ticket[i - 1]! + deltas[i]!);
    if (ticket[ticket.length - 1]! <= MAIN_POOL) return ticket;
  }
  return [...d];
}

// ---------------------------------------------------------------------------
// Logistic regression per ball on lag features — the "machine learning" entry.
// ---------------------------------------------------------------------------

export interface LagFeatures {
  /** Draws since the ball last appeared, capped and scaled. */
  gap: number;
  /** Frequency over the last 10, 50 and 200 draws, relative to 5/43. */
  f10: number;
  f50: number;
  f200: number;
  /** 1 when the ball was in the previous draw. */
  last: number;
}

const FEATURE_NAMES = ["gap", "f10", "f50", "f200", "last"] as const;
const FEATURE_COUNT = FEATURE_NAMES.length + 1; // + intercept

/**
 * Feature rows for every draw index in [from, to): the row for index t
 * describes each ball using only draws before t. Built in one pass with
 * running counters, so the whole history costs O(draws × pool), not squared.
 */
function featureRows(
  history: Draw[],
  from: number,
  to: number,
  pool: number,
  pick: (d: Draw) => number[],
): Float64Array[] {
  const rows: Float64Array[] = [];
  if (to <= from || history.length === 0) return rows;
  const base = pick(history[0]!).length / pool;
  const lastSeen = new Array<number>(pool + 1).fill(-1);
  const c10 = new Array<number>(pool + 1).fill(0);
  const c50 = new Array<number>(pool + 1).fill(0);
  const c200 = new Array<number>(pool + 1).fill(0);
  const bump = (i: number, delta: number, target: number[], window: number) => {
    // Add draw i to the window counter, and drop the draw leaving the window.
    for (const n of pick(history[i]!)) target[n]! += delta;
    const leaving = i - window;
    if (leaving >= 0 && delta > 0) for (const n of pick(history[leaving]!)) target[n]!--;
  };
  for (let i = 0; i < to; i++) {
    if (i >= from) {
      const out = new Float64Array(pool * FEATURE_COUNT);
      const lastDraw = i > 0 ? new Set(pick(history[i - 1]!)) : new Set<number>();
      for (let n = 1; n <= pool; n++) {
        const o = (n - 1) * FEATURE_COUNT;
        out[o] = 1;
        out[o + 1] = Math.min(i - 1 - lastSeen[n]!, 60) / 60;
        out[o + 2] = c10[n]! / (Math.min(10, i) * base) - 1;
        out[o + 3] = c50[n]! / (Math.min(50, i) * base) - 1;
        out[o + 4] = c200[n]! / (Math.min(200, i) * base) - 1;
        out[o + 5] = lastDraw.has(n) ? 1 : 0;
      }
      rows.push(out);
    }
    if (i < history.length) {
      for (const n of pick(history[i]!)) lastSeen[n] = i;
      bump(i, 1, c10, 10);
      bump(i, 1, c50, 50);
      bump(i, 1, c200, 200);
    }
  }
  return rows;
}

export interface LogisticModel {
  weights: number[];
  observations: number;
}

/**
 * Ridge-regularised logistic regression, shared across balls: one weight per
 * feature, trained on every (draw, ball) pair in the history. Gradient descent
 * with a handful of passes is plenty for six parameters.
 */
export function fitLogistic(
  history: Draw[],
  pool = MAIN_POOL,
  pick: (d: Draw) => number[] = (d) => d.main,
  options: { ridge?: number; passes?: number; learningRate?: number; minHistory?: number } = {},
): LogisticModel {
  const { ridge = 1e-2, passes = 60, learningRate = 0.5, minHistory = 30 } = options;
  const w = new Array<number>(FEATURE_COUNT).fill(0);
  const xs = featureRows(history, minHistory, history.length, pool, pick);
  const rows = xs.map((x, k) => {
    const y = new Uint8Array(pool);
    for (const n of pick(history[minHistory + k]!)) y[n - 1] = 1;
    return { x, y };
  });
  const total = rows.length * pool;
  if (total === 0) return { weights: w, observations: 0 };
  // Start the intercept at the base rate so the first steps are not wasted.
  w[0] = Math.log(pick(history[0]!).length / pool / (1 - pick(history[0]!).length / pool));
  const grad = new Array<number>(FEATURE_COUNT).fill(0);
  for (let pass = 0; pass < passes; pass++) {
    grad.fill(0);
    for (const { x, y } of rows) {
      for (let n = 0; n < pool; n++) {
        const o = n * FEATURE_COUNT;
        let z = 0;
        for (let f = 0; f < FEATURE_COUNT; f++) z += w[f]! * x[o + f]!;
        const p = 1 / (1 + Math.exp(-z));
        const err = p - y[n]!;
        for (let f = 0; f < FEATURE_COUNT; f++) grad[f]! += err * x[o + f]!;
      }
    }
    for (let f = 0; f < FEATURE_COUNT; f++) {
      const penalty = f === 0 ? 0 : ridge * w[f]!;
      w[f]! -= learningRate * (grad[f]! / total + penalty);
    }
  }
  return { weights: w, observations: rows.length };
}

/** Predicted probability for every ball on the draw after `history`. */
export function logisticScores(
  model: LogisticModel,
  history: Draw[],
  pool = MAIN_POOL,
  pick: (d: Draw) => number[] = (d) => d.main,
): number[] {
  const scores = new Array<number>(pool + 1).fill(0);
  if (history.length === 0) return scores;
  const x = featureRows(history, history.length, history.length + 1, pool, pick)[0]!;
  for (let n = 1; n <= pool; n++) {
    const o = (n - 1) * FEATURE_COUNT;
    let z = 0;
    for (let f = 0; f < FEATURE_COUNT; f++) z += model.weights[f]! * x[o + f]!;
    scores[n] = 1 / (1 + Math.exp(-z));
  }
  return scores;
}

/** Human-readable coefficients, for the report. */
export function describeLogistic(model: LogisticModel): { feature: string; weight: number }[] {
  return ["intercept", ...FEATURE_NAMES].map((feature, i) => ({ feature, weight: model.weights[i]! }));
}

// ---------------------------------------------------------------------------
// Periodicity: does any ball come and go on a cycle?
// ---------------------------------------------------------------------------

export interface Periodogram {
  ball: number;
  /** Period (in draws) of the strongest frequency component. */
  period: number;
  /** Fisher's g: share of the spectrum held by that component. */
  g: number;
  /** p-value of g under white noise, before correction. */
  pValue: number;
  /** True when it survives the Bonferroni correction over all balls. */
  significant: boolean;
  /** Predicted value of the cycle at the next draw, in standard deviations. */
  nextPhase: number;
}

/**
 * Tail probability of the largest normalised periodogram ordinate under white
 * noise. Fisher's exact alternating series is numerically hopeless for the
 * hundreds of ordinates a 900-draw series has (binomials of 10^50 cancelling),
 * so this uses the standard large-m form: the m ordinates are approximately
 * i.i.d. exponential, and P(max/mean > x) = 1 − (1 − e^{−x})^m with x = g·m.
 */
export function fisherGPValue(g: number, m: number): number {
  if (m < 1 || g <= 0) return 1;
  const x = g * m;
  // log(1 - e^{-x}) computed without cancellation, then 1 - exp(m * that).
  const logOneMinus = x > 1e-3 ? Math.log1p(-Math.exp(-x)) : Math.log(-Math.expm1(-x));
  const p = -Math.expm1(m * logOneMinus);
  return Math.min(1, Math.max(0, p));
}

export function periodograms(
  history: Draw[],
  pool = MAIN_POOL,
  pick: (d: Draw) => number[] = (d) => d.main,
  alpha = 0.05,
): Periodogram[] {
  const n = history.length;
  const m = Math.floor((n - 1) / 2);
  const out: Periodogram[] = [];
  if (m < 2) return out;
  const threshold = alpha / pool;
  for (let ball = 1; ball <= pool; ball++) {
    const x = new Float64Array(n);
    let mean = 0;
    for (let t = 0; t < n; t++) {
      x[t] = pick(history[t]!).includes(ball) ? 1 : 0;
      mean += x[t]!;
    }
    mean /= n;
    let variance = 0;
    for (let t = 0; t < n; t++) variance += (x[t]! - mean) ** 2;
    variance /= n;
    let best = 0;
    let bestK = 1;
    let bestRe = 0;
    let bestIm = 0;
    let total = 0;
    for (let k = 1; k <= m; k++) {
      let re = 0;
      let im = 0;
      const omega = (2 * Math.PI * k) / n;
      for (let t = 0; t < n; t++) {
        const c = x[t]! - mean;
        re += c * Math.cos(omega * t);
        im -= c * Math.sin(omega * t);
      }
      const power = re * re + im * im;
      total += power;
      if (power > best) {
        best = power;
        bestK = k;
        bestRe = re;
        bestIm = im;
      }
    }
    const g = total > 0 ? best / total : 0;
    const pValue = fisherGPValue(g, m);
    // Project the dominant sinusoid one step ahead.
    const omega = (2 * Math.PI * bestK) / n;
    const amp = (2 / n) * Math.sqrt(bestRe * bestRe + bestIm * bestIm);
    const phase = Math.atan2(-bestIm, bestRe);
    const next = amp * Math.cos(omega * n + phase);
    out.push({
      ball,
      period: n / bestK,
      g,
      pValue,
      significant: pValue < threshold,
      nextPhase: variance > 0 ? next / Math.sqrt(variance) : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The strategies, for `backtest()`.
// ---------------------------------------------------------------------------

export function algorithmStrategies(): Strategy[] {
  const markov = memo((h) => topMain((n) => transitionScores(h)[n]!));
  const affinity = memo(affinityTicket);
  const neighbours = memo((h) => topMain((n) => neighbourScores(h)[n]!));
  const logisticFit = memoFit((h) => fitLogistic(h));
  const logistic = memo((h) => {
    const scores = logisticScores(logisticFit(h), h);
    return topMain((n) => scores[n]!);
  });
  // The spectrum of a 900-draw series barely moves draw to draw; refit on a stride.
  const spectrum = memoFit((h) => periodograms(h));
  const periodic = memo((h) => {
    const next = new Array<number>(MAIN_POOL + 1).fill(0);
    for (const p of spectrum(h)) next[p.ball] = p.nextPhase;
    return topMain((n) => next[n]!);
  });
  const ensemble = memo((h) => {
    const votes = new Array<number>(MAIN_POOL + 1).fill(0);
    for (const n of markov(h)) votes[n]!++;
    for (const n of affinity(h)) votes[n]!++;
    for (const n of neighbours(h)) votes[n]!++;
    for (const n of logistic(h)) votes[n]!++;
    for (const n of periodic(h)) votes[n]!++;
    return topMain((n) => votes[n]!);
  });
  const superBall = (h: Draw[]): number => (h.length > 0 ? h[h.length - 1]!.super : 1);

  const wrap = (main: (h: Draw[]) => number[]) => (h: Draw[]): Combination => ({
    main: h.length > 0 ? main(h) : [1, 2, 3, 4, 5],
    super: superBall(h),
  });

  return [
    {
      id: "markov",
      description: "Numbers that most often followed the ones just drawn",
      pick: (h) => wrap(markov)(h),
    },
    {
      id: "affinity",
      description: "Greedy set of numbers that co-occur most often",
      pick: (h) => wrap(affinity)(h),
    },
    {
      id: "neighbours",
      description: "What followed the 25 past draws most like the last one",
      pick: (h) => wrap(neighbours)(h),
    },
    {
      id: "delta",
      description: "The 'delta system': replay a past gap pattern from a new start",
      pick: (h, rng) => ({ main: h.length > 0 ? deltaTicket(h, rng) : [1, 2, 3, 4, 5], super: superBall(h) }),
    },
    {
      id: "logistic",
      description: "Logistic regression per ball on gap, recent frequency and last-draw features",
      pick: (h) => wrap(logistic)(h),
    },
    {
      id: "periodic",
      description: "Each ball's dominant cycle, projected one draw ahead",
      pick: (h) => wrap(periodic)(h),
    },
    {
      id: "ensemble",
      description: "Majority vote of markov, affinity, neighbours, logistic and periodic",
      pick: (h) => wrap(ensemble)(h),
    },
  ];
}

/** The same two "statistical" ideas, as Súper Balota rules for its tournament. */
export function algorithmSuperRules(): SuperRule[] {
  const pickSuper = (d: Draw) => [d.super];
  const logisticFit = memoFit((h: Draw[]) => fitLogistic(h, SUPER_POOL, pickSuper));
  const logistic = memo((h: Draw[]) => logisticScores(logisticFit(h), h, SUPER_POOL, pickSuper));
  const spectrum = memoFit((h: Draw[]) => periodograms(h, SUPER_POOL, pickSuper));
  const periodic = memo((h: Draw[]) => {
    const next = new Array<number>(SUPER_POOL + 1).fill(0);
    for (const p of spectrum(h)) next[p.ball] = p.nextPhase;
    return next;
  });
  return [
    {
      name: "logistic on lag features",
      choose: (past, n) => rank(SUPER_POOL, (b) => logistic(past)[b]!).slice(0, n),
    },
    {
      name: "dominant cycle, one step ahead",
      choose: (past, n) => rank(SUPER_POOL, (b) => periodic(past)[b]!).slice(0, n),
    },
  ];
}

export { chance as CHANCE_MATCHES };
