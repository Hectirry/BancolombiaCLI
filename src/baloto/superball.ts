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

import { ECONOMICS, MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { betaQuantile, normalQuantile } from "./numeric.ts";

/**
 * Normal quantile for a simultaneous two-sided 5 % look at all sixteen balls:
 * Φ⁻¹(1 − 0.025/16) = 2.9552. Without it, inspecting sixteen posteriors at
 * 95 % flags roughly one ball on a machine that is perfectly fair.
 *
 * Computed, not typed: an earlier version carried 2.8945, which is the
 * quantile of a 6.08 % family-wise level, not 5 %. The number is kept for the
 * report (it is the half-width of the normal approximation in standard
 * deviations); the intervals themselves now come from the exact Beta
 * quantiles at the same per-ball tail, 0.025/16 on each side.
 */
export const SIMULTANEOUS_Z = bonferroniZ(SUPER_POOL);
/** Per-side tail for each ball's credible interval: 0.025/16. */
const SIMULTANEOUS_TAIL = 0.025 / SUPER_POOL;

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
    // The marginal posterior of one ball's probability is Beta(alpha, total −
    // alpha). Its quantiles are exact and cheap, so they are used directly: at
    // ~60 of 974 the posterior is visibly right-skewed (skewness ≈ 0.23) and a
    // normal interval sits about 0.35 sd too low on both ends, holding 99.62 %
    // of the mass instead of the 99.69 % it claims. Sixteen balls are inspected
    // at once, so each side gets 0.025/16 rather than 0.025; that is what makes
    // an empty `distinguishable` list mean something.
    const low = betaQuantile(SIMULTANEOUS_TAIL, alpha, total - alpha);
    const high = betaQuantile(1 - SIMULTANEOUS_TAIL, alpha, total - alpha);
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

/** Binomial coefficient, exact for the small arguments used here. */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Probability one ticket matches at least three of the five main numbers. */
export function atLeastThreeMain(): number {
  const total = choose(MAIN_POOL, MAIN_PICK);
  let ways = 0;
  for (let k = 3; k <= MAIN_PICK; k++) ways += choose(MAIN_PICK, k) * choose(MAIN_POOL - MAIN_PICK, MAIN_PICK - k);
  return ways / total;
}

/** Largest number of tickets whose main numbers can all be pairwise disjoint: ⌊43/5⌋ = 8. */
export const MAX_DISJOINT_TICKETS = Math.floor(MAIN_POOL / MAIN_PICK);

/**
 * Probability that at least one of `tickets` wins *anything*, when they carry
 * distinct Súper Balotas and the main numbers are arranged as well as this
 * module knows how. A prize needs either the Súper Balota or three main
 * matches, and the two machines are independent, so
 *
 *   P(win anything) = 1 − (1 − n/16) · (1 − P(some ticket matches ≥ 3)).
 *
 * Up to eight tickets the main numbers can be pairwise disjoint; two disjoint
 * tickets cannot both reach three matches (that would need six drawn balls),
 * so the events are mutually exclusive, their probabilities add to
 * n · 7 221/962 598, and no arrangement can do better (the union bound is
 * attained). That part is exact and is the optimum.
 *
 * From nine tickets on, 5n > 43 and some number must be shared. Two tickets
 * that share s numbers can both reach three matches in 36 (s = 1), 351
 * (s = 2) or 1 227 (s = 3) of the 962 598 draws — counted by enumeration — so
 * the union bound n · 7 221 is no longer attainable. What is returned here is
 * the exact probability, by enumerating all C(43, 5) draws, of the best
 * arrangement this module constructs (`spreadTickets`): eight disjoint blocks,
 * then each extra ticket on the least-used numbers, never two from the same
 * earlier ticket. For n = 9 that arrangement loses exactly 2 × 36 draws
 * against the union bound, which is the least any arrangement with the
 * minimum of two repeated slots can lose (nine tickets occupy 45 slots over 43
 * numbers; a repeated number costs at least one pair's 36 draws, and with two
 * repeats no three tickets can all reach three matches). A proof that more
 * sharing never helps is not attempted, so from n = 9 on the value is a proven
 * *achievable* figure, not a proven optimum; `winAnythingUpperBound` gives the
 * ceiling nothing can exceed, and the two differ by at most 0.016 points.
 *
 * This is a hit criterion, not a payout one: it says nothing about prize size.
 */
export function winAnythingProbability(tickets: number): number {
  const n = Math.max(0, Math.min(Math.floor(tickets), SUPER_POOL));
  if (n <= MAX_DISJOINT_TICKETS) return combineWinAnything(n, n * atLeastThreeMain());
  return winAnythingOf(spreadTickets(n), n);
}

/** The union (Bonferroni) bound: 1 − (1 − n/16)(1 − n · 7 221/962 598), capped at certainty. */
export function winAnythingUpperBound(tickets: number): number {
  const n = Math.max(0, Math.min(Math.floor(tickets), SUPER_POOL));
  return combineWinAnything(n, Math.min(1, n * atLeastThreeMain()));
}

function combineWinAnything(distinctSupers: number, anyThreeMain: number): number {
  return 1 - (1 - distinctSupers / SUPER_POOL) * (1 - anyThreeMain);
}

/**
 * Exact P(win anything) for concrete tickets: `distinctSupers` distinct Súper
 * Balotas and the given main-number sets, by enumerating every one of the
 * 962 598 possible main draws (about 0.2 s for sixteen tickets).
 */
export function winAnythingOf(mains: number[][], distinctSupers: number): number {
  return combineWinAnything(Math.min(SUPER_POOL, distinctSupers), anyAtLeastThree(mains));
}

/**
 * Exact P(some ticket matches ≥ 3 of the five drawn) over all C(43, 5) draws,
 * for arbitrary (possibly overlapping) tickets. Bitmasks in two 32-bit halves,
 * since 43 numbers do not fit one.
 */
export function anyAtLeastThree(mains: number[][]): number {
  if (mains.length === 0) return 0;
  const masks = mains.map((t) => {
    let lo = 0;
    let hi = 0;
    for (const n of t) {
      if (n <= 32) lo |= 1 << (n - 1);
      else hi |= 1 << (n - 33);
    }
    return [lo >>> 0, hi >>> 0] as const;
  });
  const c = [0, 1, 2, 3, 4];
  let count = 0;
  let total = 0;
  for (;;) {
    total++;
    let lo = 0;
    let hi = 0;
    for (const i of c) {
      if (i < 32) lo |= 1 << i;
      else hi |= 1 << (i - 32);
    }
    for (const [tl, th] of masks) {
      if (popcount((lo & tl) >>> 0) + popcount((hi & th) >>> 0) >= 3) {
        count++;
        break;
      }
    }
    let k = MAIN_PICK - 1;
    while (k >= 0 && c[k] === MAIN_POOL - MAIN_PICK + k) k--;
    if (k < 0) break;
    c[k]!++;
    for (let j = k + 1; j < MAIN_PICK; j++) c[j] = c[j - 1]! + 1;
  }
  return count / total;
}

function popcount(x: number): number {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

/**
 * `n` main-number sets that share as little as the pool allows: eight
 * disjoint blocks of five, then each further ticket takes the five least-used
 * numbers while avoiding two numbers from any one earlier ticket (a pair
 * sharing two numbers costs 351 draws, two pairs sharing one each cost 72).
 * Deterministic; sorted ascending within a ticket.
 */
export function spreadTickets(n: number): number[][] {
  const tickets: number[][] = [];
  const usage = new Array<number>(MAIN_POOL + 1).fill(0);
  for (let t = 0; t < Math.min(n, MAX_DISJOINT_TICKETS); t++) {
    const block = Array.from({ length: MAIN_PICK }, (_, i) => t * MAIN_PICK + i + 1);
    for (const x of block) usage[x]!++;
    tickets.push(block);
  }
  while (tickets.length < n) {
    const chosen: number[] = [];
    const touched = new Set<number>(); // indices of earlier tickets already shared with
    const candidates = Array.from({ length: MAIN_POOL }, (_, i) => i + 1).sort(
      (a, b) => usage[a]! - usage[b]! || a - b,
    );
    // First pass: least-used numbers, at most one per earlier ticket.
    for (const x of candidates) {
      if (chosen.length === MAIN_PICK) break;
      const owners = tickets.map((t, i) => (t.includes(x) ? i : -1)).filter((i) => i >= 0);
      if (owners.some((i) => touched.has(i))) continue;
      chosen.push(x);
      for (const i of owners) touched.add(i);
    }
    // Second pass, only if the pool ran out of such numbers: fill by usage.
    for (const x of candidates) {
      if (chosen.length === MAIN_PICK) break;
      if (!chosen.includes(x)) chosen.push(x);
    }
    for (const x of chosen) usage[x]!++;
    tickets.push(chosen.sort((a, b) => a - b));
  }
  return tickets;
}

/**
 * What a night buys: the same tickets against every draw they take part in.
 *
 * Revancha is a second, complete draw the same night — five of 43 and one of
 * 16 from its own machines — in which the ticket's numbers play again. The two
 * draws are independent (`regime`: 16×16 permutation χ² p = 0.25 over 975
 * nights), so a ticket with Revancha gets two tries at its Súper Balota and
 * hits at least once with probability 1 − (15/16)² = 31/256 instead of 1/16.
 * With `tickets` distinct balls the night hits with 1 − (1 − tickets/16)²:
 * 23.44 % for two tickets with Revancha against 18.75 % for three without —
 * the same $18.000. That is coverage, exactly as rule 2 is coverage: more
 * draws per ticket instead of more tickets per draw, and it needs no
 * assumption about either machine.
 *
 * Per peso, Revancha buys more Súper Balota hit than extra tickets do while
 * 1 − (1 − n/16)² > 1.5n/16, i.e. n(8 − n) > 0: up to seven tickets with
 * Revancha. At eight the two routes tie (75 %); beyond that distinct balls
 * on more tickets win, because a sixteenth ball is a certainty and a second
 * draw never is. Nothing here is about what a hit pays.
 */
export interface NightCoverage {
  tickets: number;
  revancha: boolean;
  /** Draws the tickets take part in that night: 1, or 2 with Revancha. */
  draws: number;
  /** P(some ticket matches the Súper Balota in at least one of the night's draws). */
  superHit: number;
  /** P(some ticket wins anything, in Baloto or in Revancha). */
  winAnything: number;
  /** What the night costs, in COP, at the current prices. */
  cost: number;
}

/**
 * Exact night probabilities for `tickets` tickets carrying distinct Súper
 * Balotas and disjoint main numbers, with or without Revancha.
 */
export function nightCoverage(tickets: number, revancha: boolean): NightCoverage {
  const n = Math.max(0, Math.floor(tickets));
  const draws = revancha ? 2 : 1;
  const superPerDraw = Math.min(n, SUPER_POOL) / SUPER_POOL;
  const winPerDraw = winAnythingProbability(n);
  return {
    tickets: n,
    revancha,
    draws,
    superHit: 1 - (1 - superPerDraw) ** draws,
    winAnything: 1 - (1 - winPerDraw) ** draws,
    cost: n * (ECONOMICS.ticketPrice + (revancha ? ECONOMICS.revanchaPrice : 0)),
  };
}

/**
 * The two ways of spending one budget: as many plain tickets as it buys, or
 * as many tickets with Revancha. Whole tickets only, so each side may leave
 * change; `cost` says how much was actually spent.
 */
export function nightCoverageForBudget(budget: number): { without: NightCoverage; withRevancha: NightCoverage } {
  const plain = Math.floor(budget / ECONOMICS.ticketPrice);
  const doubled = Math.floor(budget / (ECONOMICS.ticketPrice + ECONOMICS.revanchaPrice));
  return { without: nightCoverage(plain, false), withRevancha: nightCoverage(doubled, true) };
}

/** One candidate way of choosing which Súper Balotas to cover. */
export interface SuperRule {
  name: string;
  /** Given the draws before a target, the balls to play. */
  choose: (past: Draw[], tickets: number) => number[];
}

const allBalls = (): number[] => Array.from({ length: SUPER_POOL }, (_, i) => i + 1);
const topBy = (score: (ball: number) => number, n: number, ascending = false): number[] =>
  allBalls()
    .map((ball) => ({ ball, score: score(ball) }))
    .sort((a, b) => (ascending ? a.score - b.score : b.score - a.score))
    .slice(0, n)
    .map((x) => x.ball);

/**
 * The rules the tournament always enters, so the record accumulates instead
 * of being re-derived from scratch each time someone has a new idea. Every
 * folk system that has been proposed for the Súper Balota is here: hot, cold,
 * overdue, recent, Markov successors, a fixed pick, and the crowd's least
 * favourite. When `superWeights` is absent the crowd rule is left out.
 */
export function standardSuperRules(priorStrength = 1, superWeights?: number[]): SuperRule[] {
  // The posterior mean is a count ratio; computing it once per call (not once
  // per ball) keeps the walk-forward tournament linear in the history.
  const means = (past: Draw[]) => superPosterior(past, priorStrength).map((p) => p.mean);
  const rules: SuperRule[] = [
    {
      name: "highest posterior (hot)",
      choose: (past, n) => {
        const m = means(past);
        return topBy((b) => m[b - 1]!, n);
      },
    },
    {
      name: "lowest posterior (cold)",
      choose: (past, n) => {
        const m = means(past);
        return topBy((b) => m[b - 1]!, n, true);
      },
    },
    {
      name: "hot over the last 100",
      choose: (past, n) => {
        const counts = new Array<number>(SUPER_POOL).fill(0);
        for (const d of past.slice(-100)) counts[d.super - 1]!++;
        return topBy((b) => counts[b - 1]!, n);
      },
    },
    {
      name: "most overdue",
      choose: (past, n) => {
        const lastSeen = new Array<number>(SUPER_POOL).fill(-1);
        past.forEach((d, i) => (lastSeen[d.super - 1] = i));
        return topBy((b) => lastSeen[b - 1]!, n, true);
      },
    },
    {
      name: "Markov: successors of the last",
      choose: (past, n) => {
        const last = past[past.length - 1]?.super;
        const counts = new Array<number>(SUPER_POOL).fill(0);
        for (let i = 1; i < past.length; i++) {
          if (past[i - 1]!.super === last) counts[past[i]!.super - 1]!++;
        }
        return topBy((b) => counts[b - 1]!, n);
      },
    },
    {
      name: "avoid the last three drawn",
      choose: (past, n) => {
        const recent = new Set(past.slice(-3).map((d) => d.super));
        return allBalls().filter((b) => !recent.has(b)).slice(0, n);
      },
    },
    {
      name: "repeat the last drawn",
      // Most recent first: a Set keeps first-insertion order, so the slice has
      // to be reversed before it is deduplicated or n = 1 plays the oldest.
      choose: (past, n) => [...new Set(past.slice(-6).reverse().map((d) => d.super))].slice(0, n),
    },
    {
      // Entered 2026-10-03 after a streak review found a ball seen twice or
      // more in the last four repeating 9.6 % of the time against 6.25 %
      // (z = +2.56 before correcting for the ~40 cells inspected, absent in
      // 2018–2021 and in Revancha). Not evidence; scored here so it becomes
      // evidence or dies in public.
      name: "persist: seen twice in the last four",
      choose: (past, n) => {
        const counts = new Array<number>(SUPER_POOL + 1).fill(0);
        for (const d of past.slice(-4)) counts[d.super]!++;
        const persistent = allBalls().filter((b) => counts[b]! >= 2);
        const m = means(past);
        const rest = topBy((b) => m[b - 1]!, SUPER_POOL).filter((b) => !persistent.includes(b));
        return [...persistent, ...rest].slice(0, n);
      },
    },
    {
      name: "fixed 1-2-3",
      choose: (_, n) => allBalls().slice(0, n),
    },
  ];
  if (superWeights && superWeights.length === SUPER_POOL) {
    rules.push({
      name: "least played by the crowd",
      choose: (_, n) => topBy((b) => superWeights[b - 1]!, n, true),
    });
  }
  return rules;
}

export interface SuperRuleScore {
  name: string;
  hits: number;
  draws: number;
  rate: number;
  /**
   * Hits the rule would make on a fair machine: Σ (distinct balls played)/16
   * over the scored draws. Equals draws × tickets/16 for a rule that always
   * plays `tickets` distinct balls.
   */
  expected: number;
  /** Standard score of `hits` against that exact null. */
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
 *
 * The null is taken per draw from what the rule actually played: a rule that
 * returns a repeated ball, or fewer than `tickets` balls, covers d < tickets
 * outcomes and hits with probability d/16 on that draw. Hits are then a sum of
 * independent Bernoullis with mean Σ dᵢ/16 and variance Σ (dᵢ/16)(1 − dᵢ/16),
 * which is what z is measured against. A rule that returns more than `tickets`
 * balls is cut to the first `tickets`: the budget is part of the problem.
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
  const expected = rules.map(() => 0);
  const variance = rules.map(() => 0);
  for (let i = start; i < draws.length; i++) {
    const past = draws.slice(0, i);
    const truth = draws[i]!.super;
    rules.forEach((rule, r) => {
      const played = new Set(
        rule
          .choose(past, tickets)
          .slice(0, tickets)
          .filter((b) => Number.isInteger(b) && b >= 1 && b <= SUPER_POOL),
      );
      const p = played.size / SUPER_POOL;
      expected[r]! += p;
      variance[r]! += p * (1 - p);
      if (played.has(truth)) hits[r]!++;
    });
  }
  // Two-sided 5 % spread over however many rules were entered.
  const threshold = rules.length > 1 ? bonferroniZ(rules.length) : bonferroniZ(1);
  return rules.map((rule, r) => {
    const rate = trials > 0 ? hits[r]! / trials : 0;
    const sd = Math.sqrt(variance[r]!);
    const z = sd > 0 ? (hits[r]! - expected[r]!) / sd : 0;
    return {
      name: rule.name,
      hits: hits[r]!,
      draws: trials,
      rate,
      expected: expected[r]!,
      z,
      beatsChance: Math.abs(z) > threshold,
    };
  });
}

/** Normal quantile for a two-sided 5 % test spread over `k` comparisons: Φ⁻¹(1 − 0.025/k). */
export function bonferroniZ(k: number): number {
  return normalQuantile(1 - 0.025 / Math.max(1, k));
}
