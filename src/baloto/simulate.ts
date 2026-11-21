/**
 * `baloto simulate` — what a level of coverage buys over a season, and what
 * the choice of Súper Balotas is worth on the real history.
 *
 * Two questions, both about the only lever the Súper Balota objective has
 * (coverage, rule 2 in CLAUDE.md), neither about prediction:
 *
 * 1. `simulateSeasons`: play N distinct Súper Balotas a night, with or
 *    without Revancha, through many simulated seasons on a fair machine.
 *    The per-night hit rate is exact and known (N/16, or 1 − (1 − N/16)²);
 *    the simulation adds what a formula does not show at a glance — how long
 *    the first hit takes, how long the worst drought of a season runs, and
 *    how often a drought of a given length appears. A drought that *feels*
 *    like a broken model is usually what the coverage level hands every
 *    season.
 *
 * 2. `replayBallRules`: on the nights that have both draws, apply several
 *    rules for choosing the balls — fixed sets, hottest-so-far, coldest-
 *    so-far, a seeded rotation, repeat-the-last — strictly walk-forward, and
 *    count the hits each would have had. On an exchangeable machine every
 *    rule sits at the same rate; the table shows that, with the longest
 *    drought each one lived through, so that "the balls are wrong" can be
 *    checked against "any balls would have done this".
 */

import type { Draw } from "./dataset.ts";
import { makeRng, randInt, sampleDistinct } from "./random.ts";
import { ECONOMICS, MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import { nightCoverage } from "./superball.ts";

export interface SeasonOptions {
  /** Distinct Súper Balotas (and disjoint main quintets) played each night. */
  tickets: number;
  revancha: boolean;
  /** Seasons simulated. */
  seasons?: number;
  /** Nights per season; 156 is a year at three draws a week. */
  nights?: number;
  /** Drought length whose per-season frequency is reported. */
  droughtOfInterest?: number;
  /** Window for "at least one hit within". */
  window?: number;
  seed?: number;
}

export interface SeasonSummary {
  tickets: number;
  revancha: boolean;
  seasons: number;
  nights: number;
  /** Per-night cost at today's prices. */
  cost: number;
  /** P(Súper Balota hit in a night): exact, and as simulated. */
  exactHit: number;
  simulatedHit: number;
  /** P(win anything in a night): exact, and as simulated. */
  exactWin: number;
  simulatedWin: number;
  /** Night of the first hit: median and 90th percentile (nights + 1 when a season never hits). */
  firstHitMedian: number;
  firstHitP90: number;
  /** P(at least one hit within `window` nights). */
  window: number;
  hitWithinWindow: number;
  /** Longest drought of a season: median and 90th percentile. */
  longestDroughtMedian: number;
  longestDroughtP90: number;
  /** Share of seasons containing a drought of at least `droughtOfInterest` nights. */
  droughtOfInterest: number;
  seasonsWithDrought: number;
  /** Pesos per hit implied by the exact rate. */
  costPerHit: number;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/**
 * Monte Carlo over seasons of a fair machine. Tickets carry balls 1..N and
 * disjoint main quintets (N ≤ 8; beyond that the quintets are sampled with
 * replacement of numbers across tickets, which only affects "win anything").
 */
export function simulateSeasons(options: SeasonOptions): SeasonSummary {
  const tickets = Math.max(1, Math.min(SUPER_POOL, Math.floor(options.tickets)));
  const revancha = options.revancha;
  const seasons = Math.max(1, Math.floor(options.seasons ?? 20_000));
  const nights = Math.max(1, Math.floor(options.nights ?? 156));
  const droughtOfInterest = Math.max(1, Math.floor(options.droughtOfInterest ?? 10));
  const window = Math.max(1, Math.min(nights, Math.floor(options.window ?? 12)));
  const rng = makeRng(options.seed ?? 1);
  const drawsPerNight = revancha ? 2 : 1;
  const buffer = new Int32Array(MAIN_POOL);

  let hitNights = 0;
  let winNights = 0;
  let withinWindow = 0;
  let withDrought = 0;
  const firsts: number[] = [];
  const longest: number[] = [];
  const mains: number[][] = [];

  for (let s = 0; s < seasons; s++) {
    mains.length = 0;
    if (tickets * MAIN_PICK <= MAIN_POOL) {
      const all = sampleDistinct(rng, MAIN_POOL, tickets * MAIN_PICK, buffer);
      for (let k = 0; k < tickets; k++) mains.push(Array.from(all.slice(k * MAIN_PICK, (k + 1) * MAIN_PICK)));
    } else {
      for (let k = 0; k < tickets; k++) mains.push(Array.from(sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer)));
    }
    let first = -1;
    let current = 0;
    let worst = 0;
    for (let t = 0; t < nights; t++) {
      let hit = false;
      let win = false;
      for (let d = 0; d < drawsPerNight; d++) {
        const ball = 1 + randInt(rng, SUPER_POOL);
        const drawn = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
        if (ball <= tickets) {
          hit = true;
          win = true; // any number of main matches pays with the Súper Balota
          continue;
        }
        for (let k = 0; k < tickets && !win; k++) {
          let m = 0;
          for (const n of mains[k]!) if (drawn.includes(n)) m++;
          if (m >= 3) win = true;
        }
      }
      if (hit) {
        hitNights++;
        if (first < 0) first = t + 1;
        current = 0;
      } else {
        current++;
        if (current > worst) worst = current;
      }
      if (win) winNights++;
    }
    firsts.push(first < 0 ? nights + 1 : first);
    longest.push(worst);
    if (first > 0 && first <= window) withinWindow++;
    if (worst >= droughtOfInterest) withDrought++;
  }
  firsts.sort((a, b) => a - b);
  longest.sort((a, b) => a - b);

  const exact = nightCoverage(tickets, revancha);
  const total = seasons * nights;
  return {
    tickets,
    revancha,
    seasons,
    nights,
    cost: exact.cost,
    exactHit: exact.superHit,
    simulatedHit: hitNights / total,
    exactWin: exact.winAnything,
    simulatedWin: winNights / total,
    firstHitMedian: quantile(firsts, 0.5),
    firstHitP90: quantile(firsts, 0.9),
    window,
    hitWithinWindow: withinWindow / seasons,
    longestDroughtMedian: quantile(longest, 0.5),
    longestDroughtP90: quantile(longest, 0.9),
    droughtOfInterest,
    seasonsWithDrought: withDrought / seasons,
    costPerHit: exact.cost / exact.superHit,
  };
}

/** The per-night cost of a plan, exposed for the budget table. */
export function nightCost(tickets: number, revancha: boolean): number {
  return tickets * (ECONOMICS.ticketPrice + (revancha ? ECONOMICS.revanchaPrice : 0));
}

/** A night with both draws, in date order. */
export interface Night {
  date: string;
  baloto: Draw;
  revancha: Draw;
}

/** Pair each date's Baloto draw with its Revancha draw; dates with only one are dropped. */
export function pairNights(draws: Draw[]): Night[] {
  const byDate = new Map<string, { baloto?: Draw; revancha?: Draw }>();
  for (const d of draws) {
    const slot = byDate.get(d.date) ?? {};
    slot[d.game] = d;
    byDate.set(d.date, slot);
  }
  return [...byDate.entries()]
    .filter(([, s]) => s.baloto && s.revancha)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, s]) => ({ date, baloto: s.baloto!, revancha: s.revancha! }));
}

/** A rule for choosing `tickets` distinct balls, seeing only the draws before the night. */
export interface BallRule {
  id: string;
  name: string;
  choose: (history: Draw[], tickets: number, nightIndex: number) => number[];
}

function byCount(history: Draw[], tickets: number, hottest: boolean): number[] {
  const counts = new Array<number>(SUPER_POOL + 1).fill(0);
  for (const d of history) counts[d.super]!++;
  const order = Array.from({ length: SUPER_POOL }, (_, i) => i + 1).sort(
    (a, b) => (hottest ? counts[b]! - counts[a]! : counts[a]! - counts[b]!) || a - b,
  );
  return order.slice(0, tickets);
}

/** The standard field: fixed sets, the two count orders, a rotation and repeat-the-last. */
export function standardBallRules(seed = 7): BallRule[] {
  const rotation = makeRng(seed);
  const buffer = new Int32Array(SUPER_POOL);
  const fixed = (balls: number[]): BallRule => ({
    id: `fixed-${balls.join("-")}`,
    name: `fixed ${balls.join(", ")}`,
    choose: (_h, tickets) => {
      const out = [...balls];
      for (let b = 1; out.length < tickets && b <= SUPER_POOL; b++) if (!out.includes(b)) out.push(b);
      return out.slice(0, tickets);
    },
  });
  return [
    fixed([11, 13, 7]),
    fixed([1, 2, 3]),
    fixed([8, 16, 4]),
    { id: "hottest", name: "most drawn so far", choose: (h, t) => byCount(h, t, true) },
    { id: "coldest", name: "least drawn so far", choose: (h, t) => byCount(h, t, false) },
    {
      id: "rotation",
      name: "random rotation each night",
      choose: (_h, t) => Array.from(sampleDistinct(rotation, SUPER_POOL, t, buffer)),
    },
    {
      id: "repeat-last",
      name: "repeat the last drawn",
      choose: (h, t) => {
        const out: number[] = [];
        for (let i = h.length - 1; i >= 0 && out.length < t; i--) {
          const b = h[i]!.super;
          if (!out.includes(b)) out.push(b);
        }
        for (let b = 1; out.length < t && b <= SUPER_POOL; b++) if (!out.includes(b)) out.push(b);
        return out;
      },
    },
  ];
}

export interface ReplayRow {
  id: string;
  name: string;
  nights: number;
  hits: number;
  rate: number;
  expected: number;
  z: number;
  longestDrought: number;
  /** The balls the rule would play on the night after the last one replayed. */
  next: number[];
}

export interface ReplayOptions {
  tickets: number;
  revancha: boolean;
  /** Replay only the last `window` nights (all when omitted). */
  window?: number;
  rules?: BallRule[];
}

/**
 * Replay ball-choice rules over the real nights, walk-forward: each rule sees
 * the Baloto draws strictly before the night it plays. A night hits when any
 * of its balls is the Súper Balota of the Baloto draw, or of the Revancha
 * draw when `revancha` is set.
 */
export function replayBallRules(draws: Draw[], options: ReplayOptions): ReplayRow[] {
  const tickets = Math.max(1, Math.min(SUPER_POOL, Math.floor(options.tickets)));
  const all = pairNights(draws);
  const start = options.window ? Math.max(0, all.length - Math.floor(options.window)) : 0;
  const balotoDraws = draws.filter((d) => d.game === "baloto").sort((a, b) => a.date.localeCompare(b.date));
  const p = nightCoverage(tickets, options.revancha).superHit;
  const rules = options.rules ?? standardBallRules();
  const played = all.length - start;
  const expected = played * p;
  const sd = Math.sqrt(played * p * (1 - p));

  return rules.map((rule) => {
    let hits = 0;
    let current = 0;
    let longest = 0;
    let cursor = 0;
    for (let i = 0; i < all.length; i++) {
      const night = all[i]!;
      while (cursor < balotoDraws.length && balotoDraws[cursor]!.date < night.date) cursor++;
      const balls = rule.choose(balotoDraws.slice(0, cursor), tickets, i);
      if (i < start) continue;
      const hit =
        balls.includes(night.baloto.super) || (options.revancha && balls.includes(night.revancha.super));
      if (hit) {
        hits++;
        current = 0;
      } else {
        current++;
        if (current > longest) longest = current;
      }
    }
    const next = rule.choose(balotoDraws, tickets, all.length);
    return {
      id: rule.id,
      name: rule.name,
      nights: played,
      hits,
      rate: played > 0 ? hits / played : 0,
      expected,
      z: sd > 0 ? (hits - expected) / sd : 0,
      longestDrought: longest,
      next,
    };
  });
}
