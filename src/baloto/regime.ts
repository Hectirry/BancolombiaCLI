/**
 * Regime models for the Súper Balota, and the cross-game dependence check.
 *
 * Two of the OPEN items in the research registry, run properly:
 *
 * 1. A hidden Markov model. If the machine (or the ball set) switched between
 *    a few latent states, each with its own preference over the sixteen balls,
 *    an i.i.d. fit would miss it while a two-state HMM would not. The honest
 *    comparison is by BIC, which charges the HMM for its extra parameters — a
 *    richer model always fits better in raw likelihood. The fitted model also
 *    yields a one-step predictive distribution, which is entered in the Súper
 *    Balota tournament as a rule so it is scored walk-forward like the rest.
 *
 * 2. Baloto and Revancha are drawn the same night, minutes apart. If the two
 *    machines shared a quirk, the pair (Baloto Súper, Revancha Súper) would
 *    not be independent. A Monte Carlo chi-square on the 16×16 table tests
 *    exactly that.
 */

import { SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import type { SuperRule } from "./superball.ts";
import { makeRng, randInt } from "./random.ts";

export interface IidFit {
  logLikelihood: number;
  parameters: number;
  bic: number;
}

export interface HmmFit {
  states: number;
  symbols: number;
  logLikelihood: number;
  parameters: number;
  bic: number;
  /** transition[i][j] = P(state j next | state i now). */
  transition: number[][];
  /** emission[i][k] = P(symbol k+1 | state i). */
  emission: number[][];
  initial: number[];
  /** Filtered state distribution after the last observation. */
  filtered: number[];
  /** Most likely state sequence. */
  viterbi: number[];
  iterations: number;
}

/** Maximum-likelihood i.i.d. categorical fit, with BIC. */
export function fitIid(sequence: number[], symbols: number): IidFit {
  const counts = new Array<number>(symbols).fill(0);
  for (const s of sequence) counts[s - 1]!++;
  let ll = 0;
  for (const c of counts) if (c > 0) ll += c * Math.log(c / sequence.length);
  const parameters = symbols - 1;
  return { logLikelihood: ll, parameters, bic: -2 * ll + parameters * Math.log(sequence.length) };
}

/**
 * Baum–Welch for a discrete HMM with scaled forward–backward. Deterministic
 * given `seed`; several restarts are taken and the best likelihood kept, since
 * EM only finds a local optimum.
 */
export function fitHmm(
  sequence: number[],
  symbols: number,
  states = 2,
  options: { iterations?: number; restarts?: number; seed?: number } = {},
): HmmFit {
  const { iterations = 80, restarts = 4, seed = 20261004 } = options;
  const n = sequence.length;
  const rng = makeRng(seed);
  let best: HmmFit | null = null;

  for (let r = 0; r < restarts; r++) {
    // Random, slightly perturbed-from-uniform start so the states can separate.
    let A = Array.from({ length: states }, () => normalise(Array.from({ length: states }, () => 1 + rng())));
    let B = Array.from({ length: states }, () =>
      normalise(Array.from({ length: symbols }, () => 1 + 0.5 * rng())),
    );
    let pi = normalise(Array.from({ length: states }, () => 1 + rng()));
    let ll = -Infinity;
    let it = 0;

    for (it = 0; it < iterations; it++) {
      // forward
      const alpha: number[][] = [];
      const scale: number[] = [];
      let a0 = pi.map((p, i) => p * B[i]![sequence[0]! - 1]!);
      let c = sum(a0);
      scale.push(c);
      alpha.push(a0.map((v) => v / c));
      for (let t = 1; t < n; t++) {
        const prev = alpha[t - 1]!;
        const cur = new Array<number>(states).fill(0);
        for (let j = 0; j < states; j++) {
          let acc = 0;
          for (let i = 0; i < states; i++) acc += prev[i]! * A[i]![j]!;
          cur[j] = acc * B[j]![sequence[t]! - 1]!;
        }
        c = sum(cur);
        scale.push(c);
        alpha.push(cur.map((v) => v / c));
      }
      const newLl = scale.reduce((acc, s) => acc + Math.log(s), 0);

      // backward
      const beta: number[][] = new Array(n);
      beta[n - 1] = new Array<number>(states).fill(1);
      for (let t = n - 2; t >= 0; t--) {
        const next = beta[t + 1]!;
        const cur = new Array<number>(states).fill(0);
        for (let i = 0; i < states; i++) {
          let acc = 0;
          for (let j = 0; j < states; j++) acc += A[i]![j]! * B[j]![sequence[t + 1]! - 1]! * next[j]!;
          cur[i] = acc / scale[t + 1]!;
        }
        beta[t] = cur;
      }

      // expectations
      const gamma: number[][] = alpha.map((a, t) => normalise(a.map((v, i) => v * beta[t]![i]!)));
      const xiSum = Array.from({ length: states }, () => new Array<number>(states).fill(0));
      for (let t = 0; t < n - 1; t++) {
        let total = 0;
        const local = Array.from({ length: states }, () => new Array<number>(states).fill(0));
        for (let i = 0; i < states; i++) {
          for (let j = 0; j < states; j++) {
            const v = alpha[t]![i]! * A[i]![j]! * B[j]![sequence[t + 1]! - 1]! * beta[t + 1]![j]!;
            local[i]![j] = v;
            total += v;
          }
        }
        if (total > 0) for (let i = 0; i < states; i++) for (let j = 0; j < states; j++) xiSum[i]![j]! += local[i]![j]! / total;
      }

      // maximisation (with a whisper of smoothing so no probability hits zero)
      pi = normalise(gamma[0]!.map((g) => g + 1e-6));
      A = xiSum.map((row) => normalise(row.map((v) => v + 1e-6)));
      B = Array.from({ length: states }, (_, i) => {
        const counts = new Array<number>(symbols).fill(1e-3);
        for (let t = 0; t < n; t++) counts[sequence[t]! - 1]! += gamma[t]![i]!;
        return normalise(counts);
      });

      if (Math.abs(newLl - ll) < 1e-6) {
        ll = newLl;
        break;
      }
      ll = newLl;
    }

    // final forward pass for the filtered distribution and the likelihood of the final parameters
    const { filtered, logLikelihood } = forward(sequence, A, B, pi);
    const parameters = states * (states - 1) + states * (symbols - 1) + (states - 1);
    const fit: HmmFit = {
      states,
      symbols,
      logLikelihood,
      parameters,
      bic: -2 * logLikelihood + parameters * Math.log(n),
      transition: A,
      emission: B,
      initial: pi,
      filtered,
      viterbi: viterbi(sequence, A, B, pi),
      iterations: it,
    };
    if (!best || fit.logLikelihood > best.logLikelihood) best = fit;
  }
  return best!;
}

function forward(sequence: number[], A: number[][], B: number[][], pi: number[]) {
  const states = A.length;
  let alpha = pi.map((p, i) => p * B[i]![sequence[0]! - 1]!);
  let ll = 0;
  let c = sum(alpha);
  ll += Math.log(c);
  alpha = alpha.map((v) => v / c);
  for (let t = 1; t < sequence.length; t++) {
    const cur = new Array<number>(states).fill(0);
    for (let j = 0; j < states; j++) {
      let acc = 0;
      for (let i = 0; i < states; i++) acc += alpha[i]! * A[i]![j]!;
      cur[j] = acc * B[j]![sequence[t]! - 1]!;
    }
    c = sum(cur);
    ll += Math.log(c);
    alpha = cur.map((v) => v / c);
  }
  return { filtered: alpha, logLikelihood: ll };
}

function viterbi(sequence: number[], A: number[][], B: number[][], pi: number[]): number[] {
  const states = A.length;
  const n = sequence.length;
  const delta: number[][] = [pi.map((p, i) => Math.log(p) + Math.log(B[i]![sequence[0]! - 1]!))];
  const back: number[][] = [new Array<number>(states).fill(0)];
  for (let t = 1; t < n; t++) {
    const cur = new Array<number>(states).fill(-Infinity);
    const arg = new Array<number>(states).fill(0);
    for (let j = 0; j < states; j++) {
      for (let i = 0; i < states; i++) {
        const v = delta[t - 1]![i]! + Math.log(A[i]![j]!);
        if (v > cur[j]!) {
          cur[j] = v;
          arg[j] = i;
        }
      }
      cur[j]! += Math.log(B[j]![sequence[t]! - 1]!);
    }
    delta.push(cur);
    back.push(arg);
  }
  const path = new Array<number>(n).fill(0);
  let last = 0;
  for (let i = 1; i < states; i++) if (delta[n - 1]![i]! > delta[n - 1]![last]!) last = i;
  path[n - 1] = last;
  for (let t = n - 1; t > 0; t--) path[t - 1] = back[t]![path[t]!]!;
  return path;
}

/** One-step predictive distribution over symbols from a fitted HMM. */
export function hmmPredictive(fit: HmmFit): number[] {
  const next = new Array<number>(fit.states).fill(0);
  for (let i = 0; i < fit.states; i++) for (let j = 0; j < fit.states; j++) next[j]! += fit.filtered[i]! * fit.transition[i]![j]!;
  const out = new Array<number>(fit.symbols).fill(0);
  for (let j = 0; j < fit.states; j++) for (let k = 0; k < fit.symbols; k++) out[k]! += next[j]! * fit.emission[j]![k]!;
  return out;
}

export interface RegimeEvidence {
  iid: IidFit;
  hmm: HmmFit;
  /** BIC(iid) − BIC(hmm): positive favours regimes, by how many nats. */
  deltaBic: number;
  favoursRegimes: boolean;
  /** How different the two emission distributions are (total variation). */
  stateSeparation: number;
  /** Fraction of draws assigned to each state by Viterbi. */
  occupancy: number[];
}

/** Is a two-state machine a better description of the Súper Balota than a fair one? */
export function regimeEvidence(draws: Draw[], states = 2): RegimeEvidence {
  const seq = draws.map((d) => d.super);
  const iid = fitIid(seq, SUPER_POOL);
  const hmm = fitHmm(seq, SUPER_POOL, states);
  let tv = 0;
  if (states >= 2) for (let k = 0; k < SUPER_POOL; k++) tv += Math.abs(hmm.emission[0]![k]! - hmm.emission[1]![k]!) / 2;
  const occupancy = new Array<number>(states).fill(0);
  for (const s of hmm.viterbi) occupancy[s]!++;
  return {
    iid,
    hmm,
    deltaBic: iid.bic - hmm.bic,
    // A difference under 2 nats is "not worth more than a bare mention" (Kass & Raftery).
    favoursRegimes: iid.bic - hmm.bic > 2,
    stateSeparation: tv,
    occupancy: occupancy.map((o) => o / Math.max(1, seq.length)),
  };
}

/** The HMM's one-step predictive, as a Súper Balota tournament rule. */
export function hmmSuperRule(stride = 25): SuperRule {
  let fittedAt = -1;
  let fit: HmmFit | null = null;
  return {
    name: "hidden Markov (2 states) predictive",
    choose: (past, n) => {
      if (past.length < 50) return Array.from({ length: n }, (_, i) => i + 1);
      const epoch = Math.floor(past.length / stride);
      if (!fit || epoch !== fittedAt) {
        fittedAt = epoch;
        fit = fitHmm(past.map((d) => d.super), SUPER_POOL, 2, { iterations: 40, restarts: 2 });
      }
      // Re-filter on the full past so the prediction uses the latest draws
      // even between refits.
      const { filtered } = forward(past.map((d) => d.super), fit.transition, fit.emission, fit.initial);
      const pred = hmmPredictive({ ...fit, filtered });
      return pred
        .map((p, k) => ({ ball: k + 1, p }))
        .sort((a, b) => b.p - a.p || a.ball - b.ball)
        .slice(0, n)
        .map((x) => x.ball);
    },
  };
}

export interface CrossGameDependence {
  pairs: number;
  chiSquare: number;
  /** Monte Carlo p-value under independence (fixed marginals). */
  pValue: number;
  /** How often the two Súper Balotas coincided, against 1/16. */
  sameSuper: number;
  sameSuperExpected: number;
  sameSuperPValue: number;
}

/** Is the Revancha Súper Balota independent of the Baloto one drawn minutes earlier? */
export function crossGameDependence(
  baloto: Draw[],
  revancha: Draw[],
  simulations = 2000,
  seed = 20261004,
): CrossGameDependence {
  const byDate = new Map(revancha.map((d) => [d.date, d.super]));
  const pairs: [number, number][] = [];
  for (const d of baloto) {
    const r = byDate.get(d.date);
    if (r !== undefined) pairs.push([d.super, r]);
  }
  const n = pairs.length;
  const table = (ps: [number, number][]) => {
    const t = Array.from({ length: SUPER_POOL }, () => new Array<number>(SUPER_POOL).fill(0));
    for (const [a, b] of ps) t[a - 1]![b - 1]!++;
    return t;
  };
  const chi = (ps: [number, number][]) => {
    const t = table(ps);
    const rows = t.map((r) => sum(r));
    const cols = Array.from({ length: SUPER_POOL }, (_, j) => t.reduce((acc, r) => acc + r[j]!, 0));
    let x = 0;
    for (let i = 0; i < SUPER_POOL; i++) {
      for (let j = 0; j < SUPER_POOL; j++) {
        const e = (rows[i]! * cols[j]!) / n;
        if (e > 0) x += (t[i]![j]! - e) ** 2 / e;
      }
    }
    return x;
  };
  const observed = chi(pairs);
  const same = pairs.filter(([a, b]) => a === b).length;
  // Permutation null: shuffle the Revancha column, which keeps both marginals.
  const rng = makeRng(seed);
  const col = pairs.map((p) => p[1]);
  let ge = 0;
  let sameGe = 0;
  for (let s = 0; s < simulations; s++) {
    for (let i = col.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      [col[i], col[j]] = [col[j]!, col[i]!];
    }
    const shuffled = pairs.map(([a], i) => [a, col[i]!] as [number, number]);
    if (chi(shuffled) >= observed) ge++;
    if (shuffled.filter(([a, b]) => a === b).length >= same) sameGe++;
  }
  return {
    pairs: n,
    chiSquare: observed,
    pValue: ge / simulations,
    sameSuper: same,
    sameSuperExpected: n / SUPER_POOL,
    sameSuperPValue: sameGe / simulations,
  };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const normalise = (xs: number[]): number[] => {
  const s = sum(xs);
  return s > 0 ? xs.map((x) => x / s) : xs.map(() => 1 / xs.length);
};
