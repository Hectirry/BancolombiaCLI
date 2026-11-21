/**
 * Walk-forward backtest of the strategies people actually use.
 *
 * The randomness tests say the draws look fair; this asks the practical
 * question instead. Each strategy sees only the draws before the one it is
 * betting on, exactly as a player would, and is scored on what it actually
 * wins. A strategy with an edge would show more matches per ticket than the
 * 0.581 a random pick earns.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL, PRIZE_TIERS, classify } from "./rules.ts";
import type { Combination } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { makeRng, randInt, sampleDistinct } from "./random.ts";

export interface Strategy {
  id: string;
  description: string;
  /** Pick a ticket knowing only `history` (all draws strictly before the target). */
  pick: (history: Draw[], rng: () => number, buffer: Int32Array) => Combination;
}

export interface StrategyResult {
  id: string;
  description: string;
  tickets: number;
  /** Mean main numbers matched per ticket. */
  meanMatches: number;
  /** Standard error of that mean. */
  standardError: number;
  /**
   * How many standard errors the strategy sits from the theoretical 5×5/43.
   * Anything inside ±2 is indistinguishable from guessing.
   */
  z: number;
  /** Tickets that won something, by tier id. */
  tierHits: Record<string, number>;
  prizesWon: number;
}

export interface BacktestReport {
  /** Draws used for scoring (after the warm-up window). */
  evaluated: number;
  warmup: number;
  /** 5 × 5/43 — matches per ticket under pure chance. */
  chanceMatches: number;
  results: StrategyResult[];
}

function countBy(history: Draw[], window: number): number[] {
  const counts = new Array(MAIN_POOL).fill(0);
  const from = Math.max(0, history.length - window);
  for (let i = from; i < history.length; i++) {
    for (const n of history[i]!.main) counts[n - 1]!++;
  }
  return counts;
}

/** The `k` numbers ranked highest by `score`, ties broken by number. */
function topNumbers(score: number[], k: number, descending: boolean): number[] {
  const order = score
    .map((value, i) => ({ value, number: i + 1 }))
    .sort((a, b) => (descending ? b.value - a.value : a.value - b.value) || a.number - b.number);
  return order.slice(0, k).map((o) => o.number).sort((a, b) => a - b);
}

function gapsSince(history: Draw[]): number[] {
  const gaps = new Array(MAIN_POOL).fill(history.length);
  for (let i = history.length - 1, seen = 0; i >= 0 && seen < MAIN_POOL; i--) {
    for (const n of history[i]!.main) {
      if (gaps[n - 1] === history.length) {
        gaps[n - 1] = history.length - 1 - i;
        seen++;
      }
    }
  }
  return gaps;
}

function mostFrequentSuper(history: Draw[], window: number): number {
  const counts = new Array(SUPER_POOL).fill(0);
  const from = Math.max(0, history.length - window);
  for (let i = from; i < history.length; i++) counts[history[i]!.super - 1]!++;
  return topNumbers(counts, 1, true)[0]!;
}

/** The strategies under test, including the two honest baselines. */
export function defaultStrategies(window = 100): Strategy[] {
  return [
    {
      id: "random",
      description: "A fresh random ticket every draw (the honest baseline)",
      pick: (_h, rng, buf) => ({
        main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buf),
        super: 1 + randInt(rng, SUPER_POOL),
      }),
    },
    {
      id: "hot",
      description: `The 5 most frequent numbers of the last ${window} draws`,
      pick: (h, rng) => ({
        main: topNumbers(countBy(h, window), MAIN_PICK, true),
        super: mostFrequentSuper(h, window),
      }),
    },
    {
      id: "cold",
      description: `The 5 least frequent numbers of the last ${window} draws`,
      pick: (h, rng) => ({
        main: topNumbers(countBy(h, window), MAIN_PICK, false),
        super: 1 + randInt(rng, SUPER_POOL),
      }),
    },
    {
      id: "due",
      description: "The 5 numbers absent for the longest time ('they owe me')",
      pick: (h, rng) => ({
        main: topNumbers(gapsSince(h), MAIN_PICK, true),
        super: 1 + randInt(rng, SUPER_POOL),
      }),
    },
    {
      id: "repeat-last",
      description: "Replay the numbers that just came out",
      pick: (h, rng, buf) =>
        h.length > 0
          ? { main: [...h[h.length - 1]!.main], super: h[h.length - 1]!.super }
          : { main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buf), super: 1 + randInt(rng, SUPER_POOL) },
    },
    {
      id: "birthdays",
      description: "Dates: five numbers from 1..31, the most common human pick",
      pick: (_h, rng, buf) => ({
        main: sampleDistinct(rng, 31, MAIN_PICK, buf),
        super: 1 + randInt(rng, SUPER_POOL),
      }),
    },
    {
      id: "fixed",
      description: "The same ticket forever (1-2-3-4-5 + 6)",
      pick: () => ({ main: [1, 2, 3, 4, 5], super: 6 }),
    },
  ];
}

/**
 * Score every strategy over the draws after `warmup`, replaying history one
 * draw at a time. `repeats` runs the whole backtest several times so that the
 * strategies containing randomness are not judged on a single lucky seed.
 */
export function backtest(
  draws: Draw[],
  strategies: Strategy[] = defaultStrategies(),
  warmup = 100,
  repeats = 20,
  seed = 20260815,
): BacktestReport {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const evaluated = Math.max(0, draws.length - warmup);

  const accumulators = strategies.map(() => ({
    total: 0,
    totalSquares: 0,
    tickets: 0,
    prizesWon: 0,
    tierHits: Object.fromEntries(PRIZE_TIERS.map((t) => [t.id, 0])) as Record<string, number>,
  }));

  // Slice the visible history once per draw and reuse it across strategies —
  // otherwise the backtest is quadratic in the number of strategies too.
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let i = warmup; i < draws.length; i++) {
      const target = draws[i]!;
      const history = draws.slice(0, i);
      const drawnSet = new Set(target.main);

      for (let s = 0; s < strategies.length; s++) {
        const ticket = strategies[s]!.pick(history, rng, buffer);
        let matches = 0;
        for (const n of ticket.main) if (drawnSet.has(n)) matches++;

        const acc = accumulators[s]!;
        acc.total += matches;
        acc.totalSquares += matches * matches;
        acc.tickets++;

        const tier = classify(ticket, { main: target.main, super: target.super });
        if (tier) {
          acc.tierHits[tier.id]!++;
          acc.prizesWon++;
        }
      }
    }
  }

  const results: StrategyResult[] = strategies.map((strategy, s) => {
    const { total, totalSquares, tickets, prizesWon, tierHits } = accumulators[s]!;
    const mean = tickets > 0 ? total / tickets : 0;
    const variance = tickets > 1 ? totalSquares / tickets - mean * mean : 0;
    // Repeats of a deterministic strategy re-score the same draws, so the
    // independent sample size is the number of draws, not the ticket count.
    const independent = Math.max(1, evaluated);
    const standardError = Math.sqrt(Math.max(variance, 0) / independent);
    const chance = (MAIN_PICK * MAIN_PICK) / MAIN_POOL;

    return {
      id: strategy.id,
      description: strategy.description,
      tickets,
      meanMatches: mean,
      standardError,
      z: standardError > 0 ? (mean - chance) / standardError : 0,
      tierHits,
      prizesWon,
    };
  });

  return {
    evaluated,
    warmup,
    chanceMatches: (MAIN_PICK * MAIN_PICK) / MAIN_POOL,
    results,
  };
}
