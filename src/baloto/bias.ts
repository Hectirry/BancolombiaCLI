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

/**
 * Exact distribution of how many of `drawn` appear on a random player's ticket.
 *
 * A ticket holds exactly five numbers, so the five slots are *not* independent:
 * sampling without replacement has less spread than independent trials. An
 * earlier version used a Poisson-binomial here, and it over-predicted the
 * high-match categories by a factor of nineteen at the top — precisely the tail
 * the independence assumption inflates.
 *
 * Under weighted sampling of five numbers without replacement, the probability
 * of matching exactly k of the drawn balls is a ratio of elementary symmetric
 * polynomials: choose k from the drawn weights, the rest from the others.
 */
export function matchDistribution(drawnWeights: number[], otherWeights: number[]): number[] {
  const inside = elementarySymmetricAll(drawnWeights, MAIN_PICK);
  const outside = elementarySymmetricAll(otherWeights, MAIN_PICK);
  const dist = new Array(MAIN_PICK + 1).fill(0);
  let total = 0;
  for (let k = 0; k <= MAIN_PICK; k++) {
    dist[k] = (inside[k] ?? 0) * (outside[MAIN_PICK - k] ?? 0);
    total += dist[k]!;
  }
  if (total <= 0) return dist;
  for (let k = 0; k <= MAIN_PICK; k++) dist[k]! /= total;
  return dist;
}

/** All elementary symmetric polynomials e_0..e_k of `weights`. */
export function elementarySymmetricAll(weights: number[], k: number): number[] {
  const e = new Array(k + 1).fill(0);
  e[0] = 1;
  for (const w of weights) {
    for (let j = Math.min(k, e.length - 1); j >= 1; j--) e[j] = e[j]! + e[j - 1]! * w;
  }
  return e;
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

/**
 * Sampling weights and their symmetric polynomials, computed once per candidate
 * model rather than once per draw — the likelihood is evaluated tens of
 * thousands of times during a fit, so this is the difference between a second
 * and a minute.
 */
interface WeightContext {
  weights: number[];
  /** e_0..e_5 over all 43 balls. */
  full: number[];
}

function weightContext(pi: number[]): WeightContext {
  const weights = pi.map((p) => p / (1 - p));
  return { weights, full: elementarySymmetricAll(weights, MAIN_PICK) };
}

/**
 * e_0..e_5 over every ball except the five drawn ones, by deflating the drawn
 * factors out of the full polynomial: if E = Q·(1 + w·x) then q_j = e_j − w·q_{j−1}.
 */
function excludeDrawn(context: WeightContext, drawn: number[]): number[] {
  let e = context.full;
  for (const index of drawn) {
    const w = context.weights[index]!;
    const q = new Array(MAIN_PICK + 1).fill(0);
    q[0] = e[0]!;
    for (let j = 1; j <= MAIN_PICK; j++) q[j] = e[j]! - w * q[j - 1]!;
    e = q;
  }
  return e;
}

/** Tier probabilities for one draw given the current π and σ. */
function tierProbabilities(
  obs: Observation,
  pi: number[],
  sigma: number[],
  context: WeightContext = weightContext(pi),
): { probs: number[]; pb: number[]; sigmaHit: number } {
  const inside = elementarySymmetricAll(
    obs.drawn.map((i) => context.weights[i]!),
    MAIN_PICK,
  );
  const outside = excludeDrawn(context, obs.drawn);
  const pb = new Array(MAIN_PICK + 1).fill(0);
  let total = 0;
  for (let k = 0; k <= MAIN_PICK; k++) {
    pb[k] = Math.max(0, inside[k]! * outside[MAIN_PICK - k]!);
    total += pb[k]!;
  }
  if (total > 0) for (let k = 0; k <= MAIN_PICK; k++) pb[k]! /= total;
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
  const context = weightContext(pi);
  let total = 0;
  for (const obs of observations) {
    const { probs } = tierProbabilities(obs, pi, sigma, context);
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

/**
 * Numerical gradient of the log-likelihood in feature space.
 *
 * The exact match distribution is a ratio of elementary symmetric polynomials,
 * whose analytic derivative is considerably more delicate than the
 * Poisson-binomial's. With only eight parameters to fit, central differences
 * are both simpler and fast enough — and they cannot silently disagree with the
 * likelihood the way a hand-derived gradient can.
 */
function numericalGradient(
  params: number[],
  score: (candidate: number[]) => number,
  step = 1e-4,
): number[] {
  const grad = new Array(params.length).fill(0);
  for (let i = 0; i < params.length; i++) {
    const up = [...params];
    const down = [...params];
    up[i] = up[i]! + step;
    down[i] = down[i]! - step;
    grad[i] = (score(up) - score(down)) / (2 * step);
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

  const scoreMain = (candidate: number[]) =>
    logLikelihood(
      observations,
      probabilities(candidate, mainRows, MAIN_PICK),
      probabilities(phi, superRows, 1),
    );
  const scoreSuper = (candidate: number[]) =>
    logLikelihood(
      observations,
      probabilities(theta, mainRows, MAIN_PICK),
      probabilities(candidate, superRows, 1),
    );

  for (let t = 1; t <= iterations; t++) {
    step(theta, numericalGradient(theta, scoreMain), aMain, t);
    step(phi, numericalGradient(phi, scoreSuper), aSuper, t);
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
