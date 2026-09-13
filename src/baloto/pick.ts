/**
 * Choosing a ticket, given that the numbers themselves cannot be predicted.
 *
 * No combination is more likely to come out than another, and nothing in this
 * file pretends otherwise. What it does is pick combinations the crowd avoids,
 * so that on the rare occasion a ticket does win, the prize is split between
 * fewer people. That is a real, measurable improvement in expected value — and
 * the only one available to a player.
 *
 * The search is exhaustive rather than random. Popularity is a product of
 * per-ball weights, so all 962 598 combinations can be ranked directly; an
 * earlier version sampled candidates instead and settled around 0.45× when the
 * best combination meeting the same constraints was 0.35×. Sampling looked like
 * optimisation and was not.
 *
 * Tickets are still randomised — drawn from a pool of near-optimal
 * combinations rather than always returning the single argmin. A rule that
 * always produced the same "best" ticket would stop being unpopular the moment
 * anyone else followed it, and the very top of the ranking is exactly where
 * other people following the same advice will land.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import type { Combination } from "./rules.ts";
import { elementarySymmetric, type BiasModel } from "./bias.ts";
import { makeRng, randInt } from "./random.ts";
import { FEATURES, typicalRanges, type TypicalRange } from "./profile.ts";

/**
 * Structural properties kept inside the range a fair machine usually produces,
 * so an unpopular ticket still looks like a plausible result. This costs
 * nothing statistically — every combination is equally likely either way — but
 * it matters to anyone who has to actually hand the ticket over.
 */
const TYPICAL_FEATURES = ["sum", "spread", "biggest-cluster", "decades", "min-gap"];

export interface PickOptions {
  /** How many tickets to produce. */
  count?: number;
  /**
   * How many of the least-played combinations to choose among. 1 returns the
   * provable minimum every time; larger pools trade a little popularity for
   * unpredictability, which matters because other players read the same advice.
   */
  pool?: number;
  /** Maximum numbers two returned tickets may share. */
  maxOverlap?: number;
  /**
   * Keep only combinations whose shape a fair machine produces routinely, so
   * the ticket does not look constructed. Purely cosmetic — it cannot change
   * any probability — but it does cost popularity, and the report says how much.
   */
  typical?: boolean;
  /** Share of fair draws a "typical" combination must fall within. */
  typicalCoverage?: number;
  seed?: number;
}

export interface PickedTicket {
  ticket: Combination;
  /** Chance a random player holds this ticket, relative to an average ticket. */
  popularityRatio: number;
  /** Position in the full ranking of all 962 598 × 16 tickets. */
  rank: number;
}

export interface PickReport {
  tickets: PickedTicket[];
  /** The least-played ticket that meets the constraints, for reference. */
  floor: number;
  /** The least-played ticket overall, ignoring the typicality constraint. */
  unconstrainedFloor: number;
  /** Combinations that satisfied the constraints. */
  eligible: number;
}

/** Rank every main combination by how often players choose it. */
function rankCombinations(
  model: BiasModel,
  ranges: TypicalRange[],
  limit: number,
): { main: number[]; weight: number }[] {
  const weights = model.main.map((p) => p / (1 - p));

  // Resolve the typicality checks once; doing it inside the loop over a million
  // combinations is what makes the naive version unusable.
  const checks = ranges
    .map((range) => ({ range, feature: FEATURES.find((f) => f.name === range.name) }))
    .filter((c) => c.feature !== undefined)
    .map((c) => ({ low: c.range.low, high: c.range.high, value: c.feature!.value }));

  const best: { main: number[]; weight: number }[] = [];
  let worstKept = Infinity;

  const main = new Array<number>(MAIN_PICK);
  for (let a = 1; a <= MAIN_POOL - 4; a++) {
    const wa = weights[a - 1]!;
    main[0] = a;
    for (let b = a + 1; b <= MAIN_POOL - 3; b++) {
      const wb = wa * weights[b - 1]!;
      main[1] = b;
      for (let c = b + 1; c <= MAIN_POOL - 2; c++) {
        const wc = wb * weights[c - 1]!;
        main[2] = c;
        for (let d = c + 1; d <= MAIN_POOL - 1; d++) {
          const wd = wc * weights[d - 1]!;
          main[3] = d;
          for (let e = d + 1; e <= MAIN_POOL; e++) {
            const weight = wd * weights[e - 1]!;
            if (best.length >= limit && weight >= worstKept) continue;
            main[4] = e;
            if (checks.length > 0) {
              let ok = true;
              for (const check of checks) {
                const value = check.value(main, 1, null);
                if (value < check.low || value > check.high) {
                  ok = false;
                  break;
                }
              }
              if (!ok) continue;
            }
            best.push({ main: [...main], weight });
            if (best.length > limit * 2) {
              best.sort((x, y) => x.weight - y.weight);
              best.length = limit;
              worstKept = best[best.length - 1]!.weight;
            }
          }
        }
      }
    }
  }
  best.sort((x, y) => x.weight - y.weight);
  if (best.length > limit) best.length = limit;
  return best;
}

function overlap(a: number[], b: number[]): number {
  const set = new Set(a);
  return b.filter((n) => set.has(n)).length;
}

/**
 * Produce tickets whose combinations the crowd under-plays.
 *
 * Every combination is ranked, then tickets are drawn from the least-played
 * pool with a diversity constraint, so one unlucky number cannot sink the whole
 * batch and two players following this advice do not end up with the same line.
 */
export function pickTickets(model: BiasModel, options: PickOptions = {}): PickedTicket[] {
  return pickReport(model, options).tickets;
}

/** As `pickTickets`, but also reports what the constraints cost. */
export function pickReport(model: BiasModel, options: PickOptions = {}): PickReport {
  const {
    count = 5,
    pool = 400,
    maxOverlap = 2,
    typical = false,
    typicalCoverage = 0.8,
    seed = Date.now(),
  } = options;

  const rng = makeRng(seed >>> 0);
  const weights = model.main.map((p) => p / (1 - p));
  const normaliser = elementarySymmetric(weights, MAIN_PICK);
  const uniformOdds = 1 / (combinationCount() * SUPER_POOL);

  // The Súper Balota is independent of the five numbers, so its cheapest value
  // is simply the least-played of the sixteen.
  const superOrder = model.super
    .map((p, i) => ({ number: i + 1, p }))
    .sort((x, y) => x.p - y.p);

  const ranges = typical ? typicalRanges(TYPICAL_FEATURES, typicalCoverage) : [];
  const ranked = rankCombinations(model, ranges, Math.max(pool, count * 8));
  const unconstrained = typical ? rankCombinations(model, [], 1) : ranked;

  const ratioOf = (main: number[], superBall: number): number =>
    ((main.reduce((acc, n) => acc * weights[n - 1]!, 1) / normaliser) *
      model.super[superBall - 1]!) /
    uniformOdds;

  // Walk a shuffled pool rather than sampling with replacement, so the search
  // cannot stall on collisions. The least-played combinations are heavily
  // overlapping by construction — they are all drawn from the same dozen high
  // balls — so the diversity rule is relaxed rather than allowed to return
  // fewer tickets than asked for.
  const order = ranked.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  const picked: PickedTicket[] = [];
  for (let limit = maxOverlap; limit <= MAIN_PICK && picked.length < count; limit++) {
    for (const index of order) {
      if (picked.length >= count) break;
      const candidate = ranked[index]!;
      if (picked.some((p) => p.rank === index + 1)) continue;
      if (picked.some((p) => overlap(p.ticket.main, candidate.main) > limit)) continue;

      const superBall = superOrder[randInt(rng, Math.min(3, superOrder.length))]!.number;
      picked.push({
        ticket: { main: candidate.main, super: superBall },
        popularityRatio: ratioOf(candidate.main, superBall),
        rank: index + 1,
      });
    }
  }
  picked.sort((a, b) => a.popularityRatio - b.popularityRatio);

  return {
    tickets: picked,
    floor: ranked.length > 0 ? ratioOf(ranked[0]!.main, superOrder[0]!.number) : 0,
    unconstrainedFloor:
      unconstrained.length > 0 ? ratioOf(unconstrained[0]!.main, superOrder[0]!.number) : 0,
    eligible: ranked.length,
  };
}

function combinationCount(): number {
  let result = 1;
  for (let i = 0; i < MAIN_PICK; i++) result = (result * (MAIN_POOL - i)) / (i + 1);
  return Math.round(result);
}
