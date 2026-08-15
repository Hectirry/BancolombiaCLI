/**
 * How Colombians actually pick their numbers — estimated from public data.
 *
 * Per-combination sales are not published, but the winner count of each prize
 * category is. That is enough: when a draw comes out full of low numbers, far
 * more tickets match it, because far more players chose low numbers. Across
 * ~800 published breakdowns that signal is strong enough to measure.
 *
 * The model
 * ---------
 * A random player's ticket contains number `i` with probability π_i (Σπ = 5)
 * and Súper Balota `j` with probability σ_j (Σσ = 1); if everyone played
 * quick-picks, π_i = 5/43 and σ_j = 1/16. Treating the five slots as
 * independent makes the number of matches against a drawn combination a
 * Poisson-binomial, so the expected winners per category follow in closed form.
 *
 * Because the number of tickets sold N_d is unknown and profiled out per draw,
 * the likelihood identifies only the *relative* split of winners across
 * categories — which is exactly the bias we are after, and is immune to any
 * error in guessing sales volume.
 *
 * Why features instead of 43 free numbers
 * --------------------------------------
 * Giving every ball its own parameter fits the training draws beautifully and
 * then predicts unseen draws *worse* than assuming no bias at all: 58 free
 * parameters simply absorb noise. Restricting the preferences to a handful of
 * interpretable effects — "is it a possible day of the month", "is it 7" — both
 * generalises and says something a player can act on. `validateBiasModel`
 * re-checks that on held-out draws every time it runs.
 */

import { MAIN_PICK, MAIN_POOL, PRIZE_TIERS, SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";

/** One interpretable driver of how often a number is picked. */
export interface Feature {
  name: string;
  description: string;
  /** Value of the feature for a ball, used as a regressor on the log scale. */
  value: (n: number) => number;
}

/**
 * Candidate reasons a Colombian player writes one number rather than another.
 * These are hypotheses; the fit decides which of them the data supports.
 */
export const MAIN_FEATURES: Feature[] = [
  {
    name: "day-of-month",
    description: "1–31: any number that can be a birthday or an anniversary",
    value: (n) => (n <= 31 ? 1 : 0),
  },
  {
    name: "month",
    description: "1–12: also readable as a month",
    value: (n) => (n <= 12 ? 1 : 0),
  },
  {
    name: "single-digit",
    description: "1–9: the numbers people reach for first",
    value: (n) => (n <= 9 ? 1 : 0),
  },
  {
    name: "magnitude",
    description: "A smooth drift from low to high numbers",
    value: (n) => n / MAIN_POOL,
  },
  {
    name: "lucky-7",
    description: "The number 7 specifically",
    value: (n) => (n === 7 ? 1 : 0),
  },
];

export const SUPER_FEATURES: Feature[] = [
  {
    name: "lucky-7",
    description: "Súper Balota 7",
    value: (n) => (n === 7 ? 1 : 0),
  },
  {
    name: "month",
    description: "Súper Balota 1–12, readable as a month",
    value: (n) => (n <= 12 ? 1 : 0),
  },
  {
    name: "magnitude",
    description: "A smooth drift across the 16 Súper Balotas",
    value: (n) => n / SUPER_POOL,
  },
];

export interface Coefficient {
  name: string;
  description: string;
  /** Fitted log-scale weight; positive means over-picked. */
  value: number;
}

export interface BiasModel {
  /** π: probability that a player's ticket contains each number 1..43. */
  main: number[];
  /** σ: probability that a player's Súper Balota is each number 1..16. */
  super: number[];
  mainCoefficients: Coefficient[];
  superCoefficients: Coefficient[];
  /** Draws that carried a usable prize breakdown. */
  observations: number;
  /** Estimated tickets sold, per draw date. */
  ticketsSold: { date: string; tickets: number }[];
  logLikelihood: number;
  /** Log-likelihood of the "everyone plays quick-picks" null, for comparison. */
  nullLogLikelihood: number;
}

/** Poisson-binomial distribution of the number of successes among `probs`. */
export function poissonBinomial(probs: number[]): number[] {
  const dist = new Array(probs.length + 1).fill(0);
  dist[0] = 1;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!;
    for (let k = i + 1; k > 0; k--) {
      dist[k] = dist[k]! * (1 - p) + dist[k - 1]! * p;
    }
    dist[0] = dist[0]! * (1 - p);
  }
  return dist;
}

/**
 * Elementary symmetric polynomial e_k of `weights` — the normalising constant
 * for "pick k numbers with weights w, without replacement". O(n·k), so the
 * 962 598 combinations never have to be enumerated.
 */
export function elementarySymmetric(weights: number[], k: number): number {
  const e = new Array(k + 1).fill(0);
  e[0] = 1;
  for (const w of weights) {
    for (let j = Math.min(k, e.length - 1); j >= 1; j--) e[j] = e[j]! + e[j - 1]! * w;
  }
  return e[k]!;
}

interface Observation {
  date: string;
  /** Indices (0-based) of the five drawn numbers. */
  drawn: number[];
  /** Index (0-based) of the drawn Súper Balota. */
  superIndex: number;
  /** Winner counts aligned with PRIZE_TIERS. */
  winners: number[];
  totalWinners: number;
}

function toObservations(draws: Draw[]): Observation[] {
  const out: Observation[] = [];
  for (const draw of draws) {
    if (!draw.tiers || draw.tiers.length !== PRIZE_TIERS.length) continue;
    const byTier = new Map(draw.tiers.map((t) => [t.tier, t.winners]));
    const winners = PRIZE_TIERS.map((t) => byTier.get(t.id) ?? 0);
    const totalWinners = winners.reduce((a, b) => a + b, 0);
    // A draw with no winners at all carries no information about preferences.
    if (totalWinners <= 0) continue;
    out.push({
      date: draw.date,
      drawn: draw.main.map((n) => n - 1),
      superIndex: draw.super - 1,
      winners,
      totalWinners,
    });
  }
  return out;
}

/** Tier probabilities for one draw given the current π and σ. */
function tierProbabilities(
  obs: Observation,
  pi: number[],
  sigma: number[],
): { probs: number[]; pb: number[]; sigmaHit: number } {
  const pb = poissonBinomial(obs.drawn.map((i) => pi[i]!));
  const sigmaHit = sigma[obs.superIndex]!;
  const probs = PRIZE_TIERS.map((tier) => {
    let mass = 0;
    for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
    return mass * (tier.superMatch ? sigmaHit : 1 - sigmaHit);
  });
  return { probs, pb, sigmaHit };
}

/**
 * Conditional multinomial log-likelihood, after profiling out the unknown
 * number of tickets sold in each draw.
 */
function logLikelihood(observations: Observation[], pi: number[], sigma: number[]): number {
  let total = 0;
  for (const obs of observations) {
    const { probs } = tierProbabilities(obs, pi, sigma);
    const sum = probs.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue;
    for (let t = 0; t < probs.length; t++) {
      if (obs.winners[t]! > 0) total += obs.winners[t]! * Math.log(Math.max(probs[t]!, 1e-300));
    }
    total -= obs.totalWinners * Math.log(sum);
  }
  return total;
}

/** Design matrix: feature values for every ball in a pool. */
function design(features: Feature[], pool: number): number[][] {
  return Array.from({ length: pool }, (_, i) => features.map((f) => f.value(i + 1)));
}

/** Turn feature weights into probabilities via a softmax over the pool. */
function probabilities(theta: number[], rows: number[][], total: number): number[] {
  const logits = rows.map((row) => row.reduce((acc, x, f) => acc + x * theta[f]!, 0));
  const max = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => (total * v) / sum);
}

/** Gradient of the log-likelihood with respect to π and σ directly. */
function rawGradient(
  observations: Observation[],
  pi: number[],
  sigma: number[],
): { dPi: number[]; dSigma: number[] } {
  const dPi = new Array(MAIN_POOL).fill(0);
  const dSigma = new Array(SUPER_POOL).fill(0);

  for (const obs of observations) {
    const { probs, pb, sigmaHit } = tierProbabilities(obs, pi, sigma);
    const sum = probs.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue;
    // Weight on each tier: observed share minus modelled share.
    const weight = probs.map(
      (p, t) => (p > 0 ? obs.winners[t]! / p : 0) - obs.totalWinners / sum,
    );

    // ∂/∂π: drop each drawn ball in turn and re-convolve the other four.
    for (let m = 0; m < obs.drawn.length; m++) {
      const others = obs.drawn.filter((_, idx) => idx !== m).map((i) => pi[i]!);
      const pbMinus = poissonBinomial(others);
      let grad = 0;
      for (let t = 0; t < PRIZE_TIERS.length; t++) {
        const tier = PRIZE_TIERS[t]!;
        let dMass = 0;
        for (let k = tier.minMain; k <= tier.maxMain; k++) {
          dMass += (pbMinus[k - 1] ?? 0) - (pbMinus[k] ?? 0);
        }
        grad += weight[t]! * dMass * (tier.superMatch ? sigmaHit : 1 - sigmaHit);
      }
      dPi[obs.drawn[m]!] += grad;
    }

    // ∂/∂σ only touches the Súper Balota that actually came out.
    let gradSuper = 0;
    for (let t = 0; t < PRIZE_TIERS.length; t++) {
      const tier = PRIZE_TIERS[t]!;
      let mass = 0;
      for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
      gradSuper += weight[t]! * mass * (tier.superMatch ? 1 : -1);
    }
    dSigma[obs.superIndex] += gradSuper;
  }
  return { dPi, dSigma };
}

/** Chain a probability-space gradient back to the feature weights. */
function featureGradient(
  dProb: number[],
  probs: number[],
  rows: number[][],
  total: number,
  featureCount: number,
): number[] {
  // Softmax Jacobian: ∂p_i/∂logit_m = p_i(δ_im − p_m/total).
  const dot = probs.reduce((acc, p, i) => acc + p * dProb[i]!, 0);
  const dLogit = probs.map((p, i) => p * (dProb[i]! - dot / total));
  const grad = new Array(featureCount).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let f = 0; f < featureCount; f++) grad[f]! += dLogit[i]! * rows[i]![f]!;
  }
  return grad;
}

export interface FitOptions {
  iterations?: number;
  learningRate?: number;
  /** Ridge pull towards "no preference at all". */
  regularisation?: number;
}

const UNIFORM_MAIN = new Array(MAIN_POOL).fill(MAIN_PICK / MAIN_POOL);
const UNIFORM_SUPER = new Array(SUPER_POOL).fill(1 / SUPER_POOL);

/** Fit the preference features by maximum likelihood (Adam). */
export function fitBiasModel(draws: Draw[], options: FitOptions = {}): BiasModel {
  const { iterations = 800, learningRate = 0.02, regularisation = 1e-3 } = options;
  const observations = toObservations(draws);
  const nullLogLikelihood = logLikelihood(observations, UNIFORM_MAIN, UNIFORM_SUPER);

  const mainRows = design(MAIN_FEATURES, MAIN_POOL);
  const superRows = design(SUPER_FEATURES, SUPER_POOL);
  const theta = new Array(MAIN_FEATURES.length).fill(0);
  const phi = new Array(SUPER_FEATURES.length).fill(0);

  if (observations.length === 0) {
    return {
      main: UNIFORM_MAIN,
      super: UNIFORM_SUPER,
      mainCoefficients: MAIN_FEATURES.map((f) => ({ ...f, value: 0 })),
      superCoefficients: SUPER_FEATURES.map((f) => ({ ...f, value: 0 })),
      observations: 0,
      ticketsSold: [],
      logLikelihood: nullLogLikelihood,
      nullLogLikelihood,
    };
  }

  const adam = (size: number) => ({ m: new Array(size).fill(0), v: new Array(size).fill(0) });
  const aMain = adam(theta.length);
  const aSuper = adam(phi.length);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;

  const step = (
    params: number[],
    grads: number[],
    state: { m: number[]; v: number[] },
    t: number,
  ) => {
    for (let i = 0; i < params.length; i++) {
      const g = grads[i]! - regularisation * params[i]!;
      state.m[i] = beta1 * state.m[i]! + (1 - beta1) * g;
      state.v[i] = beta2 * state.v[i]! + (1 - beta2) * g * g;
      const mHat = state.m[i]! / (1 - beta1 ** t);
      const vHat = state.v[i]! / (1 - beta2 ** t);
      params[i] = params[i]! + (learningRate * mHat) / (Math.sqrt(vHat) + eps);
    }
  };

  for (let t = 1; t <= iterations; t++) {
    const pi = probabilities(theta, mainRows, MAIN_PICK);
    const sigma = probabilities(phi, superRows, 1);
    const { dPi, dSigma } = rawGradient(observations, pi, sigma);
    step(theta, featureGradient(dPi, pi, mainRows, MAIN_PICK, theta.length), aMain, t);
    step(phi, featureGradient(dSigma, sigma, superRows, 1, phi.length), aSuper, t);
  }

  const pi = probabilities(theta, mainRows, MAIN_PICK);
  const sigma = probabilities(phi, superRows, 1);

  const ticketsSold = observations.map((obs) => {
    const { probs } = tierProbabilities(obs, pi, sigma);
    const sum = probs.reduce((x, y) => x + y, 0);
    return { date: obs.date, tickets: sum > 0 ? obs.totalWinners / sum : 0 };
  });

  return {
    main: pi,
    super: sigma,
    mainCoefficients: MAIN_FEATURES.map((f, i) => ({
      name: f.name,
      description: f.description,
      value: theta[i]!,
    })),
    superCoefficients: SUPER_FEATURES.map((f, i) => ({
      name: f.name,
      description: f.description,
      value: phi[i]!,
    })),
    observations: observations.length,
    ticketsSold,
    logLikelihood: logLikelihood(observations, pi, sigma),
    nullLogLikelihood,
  };
}

/**
 * Log-likelihood of an arbitrary preference profile on a set of draws. Exposed
 * so alternative hypotheses can be scored against the same data.
 */
export function scoreModel(draws: Draw[], main: number[], superWeights: number[]): number {
  return logLikelihood(toObservations(draws), main, superWeights);
}

/** Number of draws in `draws` that carry a usable prize breakdown. */
export function usableObservations(draws: Draw[]): number {
  return toObservations(draws).length;
}

export interface HoldoutReport {
  trainDraws: number;
  testDraws: number;
  /** Out-of-sample log-likelihood of the fitted preferences. */
  fitted: number;
  /** Out-of-sample log-likelihood of "everyone plays quick-picks". */
  uniform: number;
  /** Improvement per winning ticket in the held-out period. */
  gainPerWinner: number;
  /** True when the fitted preferences genuinely predict unseen draws. */
  generalises: boolean;
}

/**
 * Fit on the earlier draws, score on the later ones — the check that stops this
 * whole exercise from being an elaborate way of memorising noise.
 */
export function validateBiasModel(draws: Draw[], options: FitOptions = {}): HoldoutReport {
  const usable = draws.filter((d) => toObservations([d]).length > 0);
  const split = Math.floor(usable.length / 2);
  const train = usable.slice(0, split);
  const test = usable.slice(split);

  const model = fitBiasModel(train, options);
  const testObservations = toObservations(test);
  const fitted = logLikelihood(testObservations, model.main, model.super);
  const uniform = logLikelihood(testObservations, UNIFORM_MAIN, UNIFORM_SUPER);
  const winners = testObservations.reduce((a, o) => a + o.totalWinners, 0);

  return {
    trainDraws: train.length,
    testDraws: test.length,
    fitted,
    uniform,
    gainPerWinner: winners > 0 ? (fitted - uniform) / winners : 0,
    generalises: fitted > uniform,
  };
}

/** A uniform ("everyone plays random quick-picks") model, for comparisons. */
export function uniformModel(): BiasModel {
  return {
    main: [...UNIFORM_MAIN],
    super: [...UNIFORM_SUPER],
    mainCoefficients: [],
    superCoefficients: [],
    observations: 0,
    ticketsSold: [],
    logLikelihood: 0,
    nullLogLikelihood: 0,
  };
}

/**
 * Probability that one randomly chosen player's ticket is exactly this one.
 *
 * If everyone played quick-picks this would be 1/15 401 568 for every ticket.
 * The ratio between this number and that constant is the whole game: it is how
 * many times more (or fewer) people you expect to split a prize with.
 */
export function ticketPopularity(
  ticket: { main: number[]; super: number },
  model: BiasModel,
): number {
  const weights = model.main.map((p) => p / (1 - p));
  const normaliser = elementarySymmetric(weights, MAIN_PICK);
  let product = 1;
  for (const n of ticket.main) product *= weights[n - 1]!;
  return (product / normaliser) * model.super[ticket.super - 1]!;
}

/** Summary of the fitted preferences, in the terms players think in. */
export interface BiasSummary {
  /** Mean π over numbers 1..31 divided by mean π over 32..43. */
  dateBiasRatio: number;
  /** Most over-picked numbers, most extreme first. */
  overPicked: { number: number; lift: number }[];
  /** Most under-picked numbers. */
  underPicked: { number: number; lift: number }[];
  /** Súper Balota preferences, as lift over 1/16. */
  superLift: { number: number; lift: number }[];
  /** Median estimated tickets sold per draw. */
  medianTickets: number;
}

export function summariseBias(model: BiasModel): BiasSummary {
  const uniform = MAIN_PICK / MAIN_POOL;
  const lifts = model.main.map((p, i) => ({ number: i + 1, lift: p / uniform }));
  const sorted = [...lifts].sort((x, y) => y.lift - x.lift);

  const meanOf = (from: number, to: number) => {
    const slice = model.main.slice(from - 1, to);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };

  const tickets = model.ticketsSold.map((t) => t.tickets).sort((a, b) => a - b);
  const medianTickets = tickets.length > 0 ? tickets[Math.floor(tickets.length / 2)]! : 0;

  return {
    dateBiasRatio: meanOf(1, 31) / meanOf(32, MAIN_POOL),
    overPicked: sorted.slice(0, 8),
    underPicked: sorted.slice(-8).reverse(),
    superLift: model.super
      .map((p, i) => ({ number: i + 1, lift: p * SUPER_POOL }))
      .sort((x, y) => y.lift - x.lift),
    medianTickets,
  };
}
