/**
 * A model whose only objective is hitting the Súper Balota.
 *
 * Every other picker in this suite optimises *payout* — choose combinations the
 * crowd avoids so a win is shared with fewer people. This one deliberately
 * discards that criterion. The single question here is: which Súper Balota
 * maximises the probability of matching it, and how much can a budget of N
 * tickets raise that probability?
 *
 * The answer has two halves, and they are different in kind.
 *
 * WITHIN ONE TICKET the honest posterior is flat. A Dirichlet posterior over
 * the sixteen balls is reported with credible intervals; on the real history
 * every interval covers 1/16, and a nine-method walk-forward tournament over
 * 861 draws found nothing that beats guessing (best 7.32 % against 6.25 %
 * expected, inside the ±1.65 pt band). So no ball is *established* as likelier.
 *
 * A decision still has to be made, and an earlier version of this file took the
 * highest posterior mean as the tiebreak — "the Bayes action when the evidence
 * is weak but not empty". A walk-forward over 564 draws killed that: ranking by
 * posterior mean hits 20.21 % against 18.75 % expected (z = +0.89), ranking by
 * the *lowest* posterior hits 21.28 % (z = +1.54), a fixed 1-2-3 hits 16.31 %
 * (z = -1.48). Six rules, every one inside noise. Chasing the posterior buys
 * nothing, and it is not harmless: on the real history it put Súper Balota 7
 * first, the single most-played ball in the country.
 *
 * So the ranking is honest about what it is. If a ball is genuinely
 * *distinguishable* — its simultaneous interval excludes 1/16 — the objective
 * can separate it and posterior mean decides. When no ball is distinguishable,
 * which is the case on every history this suite has seen, the objective is
 * exactly indifferent: any N distinct balls hit with probability N/16. The
 * default still ranks by posterior mean, because that is the Bayes action for
 * the stated objective, and the user of this model asked for that objective and
 * nothing else. The "least-played" tiebreak is offered, not imposed: it spends
 * the indifference on the one thing that is measured, at zero cost to the hit
 * probability, but it is a payout criterion and it says so.
 *
 * ACROSS TICKETS the lever is real and exact. Distinct Súper Balotas make the
 * events mutually exclusive, so N tickets hit with probability N/16 — a genuine
 * tripling from 6.25 % to 18.75 % at three tickets, with no assumption about
 * the machine at all.
 */

import { SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";

/**
 * Normal quantile for a simultaneous interval over all sixteen balls:
 * Phi^-1(1 - 0.025/16). Without it, inspecting sixteen posteriors at 95 %
 * flags roughly one ball on a machine that is perfectly fair.
 */
const SIMULTANEOUS_Z = 2.8945;

export interface SuperPosterior {
  ball: number;
  /** Times this Súper Balota has been drawn. */
  count: number;
  /** Posterior mean probability under a Dirichlet prior. */
  mean: number;
  /** Credible interval for that probability, corrected for testing all sixteen. */
  low: number;
  high: number;
  /** True when the interval excludes 1/16 — evidence of a real preference. */
  distinguishable: boolean;
}

/**
 * Posterior over the sixteen Súper Balotas.
 *
 * `priorStrength` is the Dirichlet concentration per ball: 1 is the classic
 * uninformative choice, larger values encode prior confidence that the machine
 * is fair and shrink every estimate towards 1/16.
 */
export function superPosterior(draws: Draw[], priorStrength = 1): SuperPosterior[] {
  const counts = new Array(SUPER_POOL).fill(0);
  for (const draw of draws) counts[draw.super - 1]!++;
  const total = draws.length + priorStrength * SUPER_POOL;
  const uniform = 1 / SUPER_POOL;

  return counts.map((count, i) => {
    const alpha = count + priorStrength;
    const mean = alpha / total;
    // Normal approximation to the Beta(alpha, total-alpha) posterior; the
    // counts here are large enough for it, and it keeps the report readable.
    const sd = Math.sqrt((mean * (1 - mean)) / (total + 1));
    // Sixteen balls are inspected at once, so a plain 95 % interval flags about
    // one of them on a perfectly fair machine. The width is corrected for the
    // simultaneous look (1 - 0.05/16), which is what makes an empty
    // `distinguishable` list mean something.
    const z = SIMULTANEOUS_Z;
    const low = Math.max(0, mean - z * sd);
    const high = mean + z * sd;
    return {
      ball: i + 1,
      count,
      mean,
      low,
      high,
      distinguishable: low > uniform || high < uniform,
    };
  });
}

export interface SuperPlan {
  /** Súper Balotas to play, best first. */
  balls: number[];
  /** Exact probability that one of them matches: tickets / 16. */
  hitProbability: number;
  /** Probability a single ticket hits, for comparison. */
  singleTicket: number;
  /** Balls whose posterior interval excludes 1/16. */
  distinguishable: number[];
  /** Posterior spread between the best and worst ball, in percentage points. */
  spreadPoints: number;
  /** What actually decided the order. */
  rule: "posterior" | "least-played" | "arbitrary";
  /**
   * Expected co-winners on the chosen balls relative to an average ball. Below
   * 1 means fewer people share the prize; it never moves `hitProbability`.
   */
  crowding: number;
}

export interface CoverageOptions {
  /** Dirichlet concentration per ball. */
  priorStrength?: number;
  /**
   * How to order balls the evidence cannot separate. "posterior" is the Bayes
   * action for a pure hit objective — highest posterior mean first, even when
   * the gap is inside noise. "least-played" ignores hit probability (it is
   * identical either way) and prefers the balls fewest people play; it needs
   * `superWeights`. Default "posterior": the objective as stated.
   */
  tiebreak?: "posterior" | "least-played";
  /**
   * σ: probability that a player's Súper Balota is each of the sixteen, from
   * the crowd model. Only consulted when `tiebreak` is "least-played".
   */
  superWeights?: number[];
}

/**
 * The plan for a pure hit-maximising objective: `tickets` *distinct* balls.
 *
 * Distinctness is what makes the arithmetic exact — the events are mutually
 * exclusive, so the probabilities add to tickets/16 whatever the machine is
 * doing. Repeating a ball would waste a ticket.
 *
 * Which distinct balls is a separate question, and on a history where nothing
 * is distinguishable the objective has no opinion at all: every choice is
 * tickets/16. By default the order is still the Bayes action for that
 * objective — highest posterior mean first — because that is what "maximise the
 * hit probability" literally asks for, noise or not. A caller who would rather
 * spend the indifference on something measurable can ask for "least-played",
 * which prefers the balls fewest people play at no cost to the hit probability.
 */
export function planSuperCoverage(
  draws: Draw[],
  tickets = 3,
  options: CoverageOptions | number = {},
): SuperPlan {
  const opts: CoverageOptions =
    typeof options === "number" ? { priorStrength: options } : options;
  const priorStrength = opts.priorStrength ?? 1;
  const posterior = superPosterior(draws, priorStrength);
  const separable = posterior.filter((p) => p.distinguishable);

  const weights = opts.superWeights;
  const usable =
    weights !== undefined &&
    weights.length === SUPER_POOL &&
    weights.every((w) => Number.isFinite(w) && w > 0);

  const tiebreak = opts.tiebreak ?? "posterior";
  let ranked: SuperPosterior[];
  let rule: SuperPlan["rule"];
  if (separable.length > 0 || tiebreak === "posterior") {
    // Either the evidence separates the balls, or the caller wants the Bayes
    // action for a pure hit objective regardless: highest posterior mean first.
    ranked = [...posterior].sort((a, b) => b.mean - a.mean);
    rule = "posterior";
  } else if (usable) {
    ranked = [...posterior].sort((a, b) => weights![a.ball - 1]! - weights![b.ball - 1]!);
    rule = "least-played";
  } else {
    ranked = [...posterior];
    rule = "arbitrary";
  }

  const chosen = ranked.slice(0, Math.min(tickets, SUPER_POOL));
  const mean = usable ? weights!.reduce((a, b) => a + b, 0) / SUPER_POOL : 0;
  const crowding = usable
    ? chosen.reduce((a, p) => a + weights![p.ball - 1]!, 0) / (chosen.length * mean)
    : 1;

  const means = posterior.map((p) => p.mean);
  return {
    balls: chosen.map((p) => p.ball),
    hitProbability: chosen.length / SUPER_POOL,
    singleTicket: 1 / SUPER_POOL,
    distinguishable: separable.map((p) => p.ball),
    spreadPoints: (Math.max(...means) - Math.min(...means)) * 100,
    rule,
    crowding,
  };
}

/** One candidate way of choosing which Súper Balotas to cover. */
export interface SuperRule {
  name: string;
  /** Given the draws before a target, the balls to play. */
  choose: (past: Draw[], tickets: number) => number[];
}

export interface SuperRuleScore {
  name: string;
  hits: number;
  draws: number;
  rate: number;
  /** Standard scores against the tickets/16 null. */
  z: number;
  /** True when |z| clears the Bonferroni threshold for the whole tournament. */
  beatsChance: boolean;
}

/**
 * Walk-forward tournament over candidate rules.
 *
 * The null is not "no skill" in the vague sense: distinct balls hit at exactly
 * tickets/16, so any rule that plays `tickets` distinct balls has that hit rate
 * by construction unless the machine is unfair. This measures the departure and
 * corrects the threshold for however many rules were tried, which is the step
 * that stops a sixteen-way search from manufacturing a winner.
 */
export function scoreSuperRules(
  draws: Draw[],
  rules: SuperRule[],
  tickets = 3,
  warmup = 400,
): SuperRuleScore[] {
  const start = Math.min(warmup, draws.length);
  const trials = draws.length - start;
  const hits = rules.map(() => 0);
  for (let i = start; i < draws.length; i++) {
    const past = draws.slice(0, i);
    const truth = draws[i]!.super;
    rules.forEach((rule, r) => {
      if (rule.choose(past, tickets).includes(truth)) hits[r]!++;
    });
  }
  const base = tickets / SUPER_POOL;
  const sd = trials > 0 ? Math.sqrt((base * (1 - base)) / trials) : Infinity;
  // Two-sided 5 % spread over however many rules were entered.
  const threshold = rules.length > 1 ? bonferroniZ(rules.length) : 1.96;
  return rules.map((rule, r) => {
    const rate = trials > 0 ? hits[r]! / trials : 0;
    const z = (rate - base) / sd;
    return {
      name: rule.name,
      hits: hits[r]!,
      draws: trials,
      rate,
      z,
      beatsChance: Math.abs(z) > threshold,
    };
  });
}

/** Normal quantile for a two-sided 5 % test spread over `k` comparisons. */
function bonferroniZ(k: number): number {
  // Newton on Phi(z) = 1 - 0.025/k, with the usual erf-free normal CDF.
  const target = 1 - 0.025 / k;
  let z = 2;
  for (let i = 0; i < 60; i++) {
    const cdf = normalCdf(z);
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    z += (target - cdf) / pdf;
  }
  return z;
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 26.2.17, good to 7.5e-8 — ample for a threshold.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - tail : tail;
}
