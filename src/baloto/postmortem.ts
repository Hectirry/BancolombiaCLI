/**
 * Post-mortem of the Súper Balota recommendation over a recent window.
 *
 * "Why didn't you hit?" has two very different answers and this module keeps
 * them apart.
 *
 * The first is the model's own forecast. Three distinct balls hit with
 * probability exactly 3/16 a night; a miss is the expected outcome (13/16)
 * and a run of misses has an exact probability under the model. Whether the
 * window looks like that forecast is an exact binomial question, answered
 * here with the Poisson-binomial tails so that nights with fewer distinct
 * balls are counted at their own rate.
 *
 * The second is the counterfactual: would another rule have done better?
 * Over a dozen nights some rule always looks better, because a dozen rules
 * were tried on the same dozen outcomes. The honest figure is not "rule X hit
 * five times" but "how often does the *best* of these rules hit five times on
 * a fair machine". That is the maximum of correlated binomials — correlated
 * because the rules share nights and overlap in the balls they play — and it
 * has no closed form worth trusting, so it is simulated: the balls each rule
 * actually played each night are held fixed and only the outcomes are
 * redrawn, which is the exact null under exchangeability (given the past, the
 * next ball is uniform whatever anyone chose to play).
 *
 * Nothing here changes a recommendation. A rule earns that only by clearing
 * the Bonferroni threshold in the full walk-forward tournament, which is
 * reported alongside so the two time scales sit in the same table.
 */

import type { Draw } from "./dataset.ts";
import { poissonBinomialPmf } from "./numeric.ts";
import { makeRng, randInt } from "./random.ts";
import { SUPER_POOL } from "./rules.ts";
import { bonferroniZ, scoreSuperRules, type SuperRule, type SuperRuleScore } from "./superball.ts";

/** One rule replayed over the window: what it played each night and what happened. */
export interface RuleReplay {
  name: string;
  /** Distinct, valid balls the rule played on each night of the window (cut to `tickets`). */
  played: number[][];
  /** Whether the night's Súper Balota was among them. */
  hit: boolean[];
  hits: number;
  /** Σ over nights of (distinct balls played)/16: the exact fair expectation. */
  expected: number;
  /** Exact P(hits ≥ observed) and P(hits ≤ observed) under the fair null for this rule alone. */
  pAtLeast: number;
  pAtMost: number;
}

/** Runs of nights without a hit, with their exact probabilities under the model. */
export interface Drought {
  /** Consecutive misses counting back from the last night of the window. */
  current: number;
  /** Longest run of misses inside the window. */
  longest: number;
  /** Exact P(the last `current` nights all miss) = Π (1 − pᵢ). */
  pCurrent: number;
  /** Monte Carlo P(longest run in a window this size ≥ `longest`). */
  pLongest: number;
}

/** The maximum over the rules, read against chance. */
export interface MaxByChance {
  /** Best hit count in the window and the rule(s) that reached it. */
  observed: number;
  rules: string[];
  /** Monte Carlo P(max over rules ≥ observed) when only the outcomes are redrawn. */
  pAtLeast: number;
  /** Expected maximum under the same null. */
  expectedMax: number;
  /** P(max = k) for k = 0..nights, from the same simulation. */
  distribution: number[];
  sims: number;
}

export interface PostmortemOptions {
  /** Nights to look back over. Default 12. */
  draws?: number;
  /** Tickets (distinct balls) each rule is allowed. Default 3. */
  tickets?: number;
  /** Which rule is the live recommendation; its row is the model's own report. */
  liveRule?: string;
  /** Monte Carlo draws for the maximum. Default 20 000. */
  sims?: number;
  seed?: number;
  /** Warm-up of the full tournament reported beside the window. Default 400. */
  warmup?: number;
  /** Skip the full tournament (tests on short synthetic histories). */
  tournament?: boolean;
}

export interface Postmortem {
  /** The draws scored, oldest first. */
  window: Draw[];
  tickets: number;
  /** The rule tournament replayed night by night, in the order given. */
  rules: RuleReplay[];
  /** The live rule's row, or null when `liveRule` names nothing in `rules`. */
  model: (RuleReplay & { drought: Drought; perNightMiss: number }) | null;
  /** Nights × tickets/16 — what any rule playing `tickets` distinct balls expects. */
  expectedPerRule: number;
  max: MaxByChance;
  /** The same rules over the whole history, when `tournament` is not false. */
  tournament: SuperRuleScore[] | null;
  /** Bonferroni |z| a rule must clear in the full tournament before anything changes. */
  threshold: number;
}

/**
 * Replay `rules` over the last `nights` of `draws`, each night seeing only the
 * draws before it, and count what they would have hit. Plays are cleaned the
 * way the tournament cleans them: cut to `tickets`, deduplicated, out-of-range
 * balls dropped, so a rule that covers fewer outcomes expects less.
 */
export function replayRules(draws: Draw[], rules: SuperRule[], nights: number, tickets = 3): RuleReplay[] {
  const k = Math.max(0, Math.min(nights, draws.length));
  const start = draws.length - k;
  const plays: number[][][] = rules.map(() => []);
  for (let i = start; i < draws.length; i++) {
    const past = draws.slice(0, i);
    rules.forEach((rule, r) => {
      const cleaned = [
        ...new Set(
          rule
            .choose(past, tickets)
            .slice(0, tickets)
            .filter((b) => Number.isInteger(b) && b >= 1 && b <= SUPER_POOL),
        ),
      ];
      plays[r]!.push(cleaned);
    });
  }
  const window = draws.slice(start);
  return rules.map((rule, r) => {
    const played = plays[r]!;
    const hit = played.map((balls, i) => balls.includes(window[i]!.super));
    const probabilities = played.map((balls) => balls.length / SUPER_POOL);
    const hits = hit.filter(Boolean).length;
    const pmf = poissonBinomialPmf(probabilities);
    let pAtLeast = 0;
    for (let j = hits; j < pmf.length; j++) pAtLeast += pmf[j]!;
    let pAtMost = 0;
    for (let j = 0; j <= hits; j++) pAtMost += pmf[j]!;
    return {
      name: rule.name,
      played,
      hit,
      hits,
      expected: probabilities.reduce((a, p) => a + p, 0),
      pAtLeast: Math.min(1, pAtLeast),
      pAtMost: Math.min(1, pAtMost),
    };
  });
}

/** Longest run of `false` in a boolean series. */
export function longestMissRun(hit: boolean[]): number {
  let longest = 0;
  let run = 0;
  for (const h of hit) {
    run = h ? 0 : run + 1;
    if (run > longest) longest = run;
  }
  return longest;
}

/** Misses counting back from the end. */
export function currentMissRun(hit: boolean[]): number {
  let run = 0;
  for (let i = hit.length - 1; i >= 0 && !hit[i]; i--) run++;
  return run;
}

/**
 * Monte Carlo of the maximum hit count over the rules when the plays are held
 * fixed and the `nights` outcomes are redrawn uniformly from 1..16. Also
 * returns, for `liveIndex`, the distribution of its longest miss run, so the
 * model's drought is read against the same null.
 */
export function simulateMax(
  plays: number[][][],
  sims: number,
  seed: number,
  liveIndex = -1,
): { distribution: number[]; longestRun: number[] } {
  const nights = plays[0]?.length ?? 0;
  const distribution = new Array<number>(nights + 1).fill(0);
  const longestRun = new Array<number>(nights + 1).fill(0);
  if (sims <= 0 || plays.length === 0) return { distribution, longestRun };
  // Membership tables: covers[r][night] is a 16-bit mask of the balls played.
  const covers = plays.map((rule) =>
    rule.map((balls) => balls.reduce((mask, b) => mask | (1 << (b - 1)), 0)),
  );
  const rng = makeRng(seed);
  const hits = new Array<number>(plays.length);
  const liveHit: boolean[] = new Array<boolean>(nights).fill(false);
  for (let s = 0; s < sims; s++) {
    hits.fill(0);
    for (let i = 0; i < nights; i++) {
      const bit = 1 << randInt(rng, SUPER_POOL);
      for (let r = 0; r < covers.length; r++) if (covers[r]![i]! & bit) hits[r]!++;
      if (liveIndex >= 0) liveHit[i] = (covers[liveIndex]![i]! & bit) !== 0;
    }
    let max = 0;
    for (const h of hits) if (h > max) max = h;
    distribution[max]!++;
    if (liveIndex >= 0) longestRun[longestMissRun(liveHit)]!++;
  }
  return {
    distribution: distribution.map((n) => n / sims),
    longestRun: longestRun.map((n) => n / sims),
  };
}

/**
 * The whole post-mortem: the model's own forecast against the window, every
 * rule's counterfactual, the maximum against chance, and the full tournament
 * that alone can change anything.
 */
export function postmortem(draws: Draw[], rules: SuperRule[], options: PostmortemOptions = {}): Postmortem {
  const nights = options.draws ?? 12;
  const tickets = options.tickets ?? 3;
  const sims = options.sims ?? 20_000;
  const seed = options.seed ?? 1;
  const liveName = options.liveRule ?? "highest posterior (hot)";

  const replays = replayRules(draws, rules, nights, tickets);
  const window = draws.slice(Math.max(0, draws.length - nights));
  const liveIndex = replays.findIndex((r) => r.name === liveName);

  const { distribution, longestRun } = simulateMax(
    replays.map((r) => r.played),
    sims,
    seed,
    liveIndex,
  );
  const observedMax = replays.reduce((m, r) => Math.max(m, r.hits), 0);
  let pAtLeast = 0;
  for (let k = observedMax; k < distribution.length; k++) pAtLeast += distribution[k]!;
  const expectedMax = distribution.reduce((a, p, k) => a + p * k, 0);

  let model: Postmortem["model"] = null;
  if (liveIndex >= 0) {
    const live = replays[liveIndex]!;
    const current = currentMissRun(live.hit);
    const longest = longestMissRun(live.hit);
    let pCurrent = 1;
    for (let i = live.hit.length - current; i < live.hit.length; i++) {
      pCurrent *= 1 - live.played[i]!.length / SUPER_POOL;
    }
    let pLongest = 0;
    for (let k = longest; k < longestRun.length; k++) pLongest += longestRun[k]!;
    model = {
      ...live,
      perNightMiss: 1 - Math.min(tickets, SUPER_POOL) / SUPER_POOL,
      drought: { current, longest, pCurrent, pLongest: sims > 0 ? pLongest : Number.NaN },
    };
  }

  const tournament =
    options.tournament === false ? null : scoreSuperRules(draws, rules, tickets, options.warmup ?? 400);

  return {
    window,
    tickets,
    rules: replays,
    model,
    expectedPerRule: (window.length * Math.min(tickets, SUPER_POOL)) / SUPER_POOL,
    max: {
      observed: observedMax,
      rules: replays.filter((r) => r.hits === observedMax).map((r) => r.name),
      pAtLeast: sims > 0 ? Math.min(1, pAtLeast) : Number.NaN,
      expectedMax,
      distribution,
      sims,
    },
    tournament,
    threshold: bonferroniZ(rules.length),
  };
}

/**
 * Exact P(X ≤ k) and P(X ≥ k) for X ~ Binomial(n, p): the "is two hits in
 * twelve nights what the model said" question in its plainest form.
 */
export function binomialTails(k: number, n: number, p: number): { atMost: number; atLeast: number } {
  const pmf = poissonBinomialPmf(new Array<number>(n).fill(p));
  let atMost = 0;
  for (let j = 0; j <= Math.min(k, n); j++) atMost += pmf[j]!;
  let atLeast = 0;
  for (let j = Math.max(0, k); j <= n; j++) atLeast += pmf[j]!;
  return { atMost: Math.min(1, atMost), atLeast: Math.min(1, atLeast) };
}
