/**
 * Learners that update after every draw.
 *
 * "Learn from the misses" has exact meanings in sequential prediction, and
 * each of them is an algorithm with a guarantee attached. The tournament
 * already held the folk versions (follow the leader, an average of rules);
 * this module enters the ones the theory actually recommends, so that the
 * question "why does the model not learn?" gets a number instead of a shrug.
 *
 * 1. CONTEXT-TREE WEIGHTING (Willems, Shtarkov & Tjalkens, 1995). The
 *    universal predictor of data compression: a Bayesian mixture over every
 *    variable-order Markov model up to a depth, updated one symbol at a time.
 *    Whatever finite memory the sequence has — "13 tends to follow 4", "after
 *    two 7s comes a 2" — CTW's loss falls behind the best such model by only a
 *    logarithmic number of bits per parameter. If the draws have memory, this
 *    finds it; if they have none, its mixture collapses onto the memoryless
 *    estimate and it plays the most frequent balls, every night the same.
 *
 * 2. BAYESIAN ONLINE CHANGE-POINT DETECTION (Adams & MacKay, 2007). A learner
 *    that carries a posterior over *how long the current regime has lasted*
 *    and forgets what came before a change. A machine serviced, a ball set
 *    replaced: the run length collapses and the forecast is rebuilt from the
 *    draws since. On a machine that never changes it behaves like a softly
 *    windowed frequency count.
 *
 * 3. THOMPSON SAMPLING (Thompson, 1933). Draw one plausible machine from the
 *    posterior and play its best balls: probability matching. It is how a
 *    learner keeps exploring while the evidence is thin, and it is the one
 *    rule here whose balls change every night by design.
 *
 * The fourth, tracking the best rule with fixed share, reads the other rules'
 * records and lives in `meta.ts`.
 *
 * None of this can beat N/16 on an exchangeable machine: a learner turns the
 * past into a choice of N distinct balls, and under exchangeability every such
 * choice hits at N/16. What the learners add is the direction of the proof —
 * the tests plant memory, a change of regime and a loaded ball, and each
 * learner must find its own. Finding nothing in the real draws then means
 * something.
 */

import type { Draw } from "./dataset.ts";
import { makeRng } from "./random.ts";
import { SUPER_POOL } from "./rules.ts";
import type { SuperRule } from "./superball.ts";

const LN_HALF = Math.log(0.5);
const logAdd = (a: number, b: number): number =>
  a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));

/** `n` distinct balls, most probable first, ties to the lower ball. */
function topBalls(probs: number[], n: number): number[] {
  return probs
    .map((p, i) => ({ ball: i + 1, p }))
    .sort((a, b) => b.p - a.p || a.ball - b.ball)
    .slice(0, Math.min(n, probs.length))
    .map((x) => x.ball);
}

// ---------------------------------------------------------------------------
// Context-tree weighting
// ---------------------------------------------------------------------------

export interface CtwReport {
  /** One-step predictive distribution over the balls 1..pool. */
  probs: number[];
  /** Code length of the whole sequence under CTW, in nats. */
  codeLength: number;
  /** The same under the memoryless (order-0) Krichevsky–Trofimov estimator. */
  memorylessCodeLength: number;
  /** The same for a coder that knows the balls are equally likely: n · ln(pool). */
  uniformCodeLength: number;
  /**
   * Posterior weight, at the root of the tree, of "there is no memory at all":
   * ½ · P_e(root) / P_w(root). The prior is ½.
   */
  memorylessWeight: number;
}

/**
 * CTW over an alphabet of `pool` symbols with contexts of up to `depth`
 * previous symbols. Estimators are Krichevsky–Trofimov (Dirichlet ½), the
 * weighting is the standard P_w = ½·P_e + ½·∏ P_w(children). Contexts that
 * reach before the first symbol use a reserved start symbol.
 */
export function ctw(sequence: number[], pool = SUPER_POOL, depth = 2): CtwReport {
  const fan = pool + 1; // one extra context value: "before the first symbol"
  const offsets: number[] = [0];
  for (let d = 1; d <= depth; d++) offsets.push(offsets[d - 1]! + fan ** (d - 1));
  const nodes = offsets[depth]! + fan ** depth;
  const counts = new Int32Array(nodes * pool);
  const totals = new Int32Array(nodes);
  const logPe = new Float64Array(nodes);
  const logPw = new Float64Array(nodes);
  const logKids = new Float64Array(nodes);
  const half = pool / 2;
  const path = new Int32Array(depth + 1);

  // Node on the path for each depth, given the symbols before position t.
  const locate = (t: number): void => {
    let code = 0;
    path[0] = 0;
    for (let d = 1; d <= depth; d++) {
      const prev = t - d >= 0 ? sequence[t - d]! - 1 : pool;
      code += prev * fan ** (d - 1);
      path[d] = offsets[d]! + code;
    }
  };

  for (let t = 0; t < sequence.length; t++) {
    const x = sequence[t]! - 1;
    locate(t);
    let delta = 0;
    for (let d = depth; d >= 0; d--) {
      const i = path[d]!;
      logPe[i] = logPe[i]! + Math.log((counts[i * pool + x]! + 0.5) / (totals[i]! + half));
      counts[i * pool + x] = counts[i * pool + x]! + 1;
      totals[i] = totals[i]! + 1;
      let next: number;
      if (d === depth) next = logPe[i]!;
      else {
        logKids[i] = logKids[i]! + delta;
        next = logAdd(LN_HALF + logPe[i]!, LN_HALF + logKids[i]!);
      }
      delta = next - logPw[i]!;
      logPw[i] = next;
    }
  }

  // Predictive: what the root's weighted probability would become for each candidate, over what it is.
  locate(sequence.length);
  const probs: number[] = [];
  for (let x = 0; x < pool; x++) {
    let delta = 0;
    for (let d = depth; d >= 0; d--) {
      const i = path[d]!;
      const pe = logPe[i]! + Math.log((counts[i * pool + x]! + 0.5) / (totals[i]! + half));
      const pw = d === depth ? pe : logAdd(LN_HALF + pe, LN_HALF + logKids[i]! + delta);
      delta = pw - logPw[i]!;
    }
    probs.push(Math.exp(delta));
  }

  return {
    probs,
    codeLength: -logPw[0]!,
    memorylessCodeLength: -logPe[0]!,
    uniformCodeLength: sequence.length * Math.log(pool),
    memorylessWeight: depth === 0 ? 1 : Math.exp(LN_HALF + logPe[0]! - logPw[0]!),
  };
}

// ---------------------------------------------------------------------------
// Bayesian online change-point detection
// ---------------------------------------------------------------------------

export interface ChangePointReport {
  /** One-step predictive distribution over the balls 1..pool. */
  probs: number[];
  /** Posterior mean of how many of the latest draws belong to the current regime. */
  runLength: number;
  /** Posterior probability that the regime changed within the last `window` draws… */
  recentChange: number;
  /** …and what the hazard alone gives for that, with no evidence either way. */
  recentChangePrior: number;
  window: number;
}

/**
 * Adams & MacKay's recursion with a constant hazard and a symmetric
 * Dirichlet-multinomial inside each regime. `hazard` is the prior probability
 * that a regime ends before any given draw: 1/200 expects a change about every
 * fifteen months of draws. It is fixed in advance, not fitted.
 */
export function changePoint(sequence: number[], pool = SUPER_POOL, hazard = 1 / 200, prior = 1, window = 50): ChangePointReport {
  const T = sequence.length;
  // cum[x][t]: occurrences of ball x+1 among the first t draws.
  const cum = Array.from({ length: pool }, () => new Int32Array(T + 1));
  for (let t = 0; t < T; t++) {
    const x = sequence[t]! - 1;
    for (let b = 0; b < pool; b++) cum[b]![t + 1] = cum[b]![t]! + (b === x ? 1 : 0);
  }
  // w[s]: probability that the current regime holds exactly the last s draws, s = 1..t.
  let w = new Float64Array(T + 2);
  let next = new Float64Array(T + 2);
  for (let t = 0; t < T; t++) {
    const row = cum[sequence[t]! - 1]!;
    // A regime that starts with this draw: certain for the first, the hazard afterwards.
    let norm = ((t === 0 ? 1 : hazard) * prior) / (pool * prior);
    next[1] = norm;
    for (let s = 1; s <= t; s++) {
      const p = ((1 - hazard) * w[s]! * (row[t]! - row[t - s]! + prior)) / (s + pool * prior);
      next[s + 1] = p;
      norm += p;
    }
    for (let s = 1; s <= t + 1; s++) next[s] = next[s]! / norm;
    const swap = w;
    w = next;
    next = swap;
  }

  const probs = new Array<number>(pool).fill((T === 0 ? 1 : hazard) / pool);
  let runLength = 0;
  let recentChange = 0;
  for (let s = 1; s <= T; s++) {
    const ws = w[s]!;
    if (ws === 0) continue;
    runLength += s * ws;
    if (s <= window) recentChange += ws;
    const keep = ((1 - hazard) * ws) / (s + pool * prior);
    for (let b = 0; b < pool; b++) probs[b] = probs[b]! + keep * (cum[b]![T]! - cum[b]![T - s]! + prior);
  }
  return {
    probs,
    runLength,
    recentChange,
    recentChangePrior: 1 - (1 - hazard) ** Math.min(window, T),
    window,
  };
}

// ---------------------------------------------------------------------------
// Thompson sampling
// ---------------------------------------------------------------------------

/** A seed that depends on the whole history, so the same past always yields the same sample. */
function historySeed(sequence: number[]): number {
  let h = 2166136261 ^ sequence.length;
  for (const s of sequence) {
    h ^= s;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normal(rng: () => number): number {
  let u = rng();
  while (u <= 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) for shape ≥ 1 (Marsaglia & Tsang). */
function gamma(shape: number, rng: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * One draw from the Dirichlet posterior over the balls' rates: a machine that
 * the evidence considers plausible. Deterministic in the history.
 */
export function thompsonSample(sequence: number[], pool = SUPER_POOL, prior = 1): number[] {
  const counts = new Array<number>(pool).fill(0);
  for (const s of sequence) counts[s - 1]!++;
  const rng = makeRng(historySeed(sequence));
  const draws = counts.map((c) => gamma(c + Math.max(prior, 1), rng));
  const total = draws.reduce((a, b) => a + b, 0);
  return draws.map((g) => g / total);
}

// ---------------------------------------------------------------------------
// Tournament entries
// ---------------------------------------------------------------------------

const supersOf = (past: Draw[]): number[] => past.map((d) => d.super);

/** The three learners as Súper Balota tournament rules. Each plays `n` distinct balls. */
export function onlineSuperRules(): SuperRule[] {
  return [
    {
      name: "universal predictor (context-tree weighting, depth 2)",
      choose: (past, n) => topBalls(ctw(supersOf(past)).probs, n),
    },
    {
      name: "change-point learner (Bayesian online, hazard 1/200)",
      choose: (past, n) => topBalls(changePoint(supersOf(past)).probs, n),
    },
    {
      name: "Thompson sampling from the posterior",
      choose: (past, n) => topBalls(thompsonSample(supersOf(past)), n),
    },
  ];
}
