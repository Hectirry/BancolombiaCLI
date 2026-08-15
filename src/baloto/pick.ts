/**
 * Choosing a ticket, given that the numbers themselves cannot be predicted.
 *
 * No combination is more likely to come out than another, and nothing in this
 * file pretends otherwise. What it does is pick combinations the crowd avoids,
 * so that on the rare occasion a ticket does win, the prize is split between
 * fewer people. That is a real, measurable improvement in expected value — and
 * the only one available to a player.
 *
 * The tickets are also kept diverse and randomised: a rule that always produced
 * the same "optimal" combination would stop being unpopular the moment anyone
 * else used it.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";
import type { Combination } from "./rules.ts";
import { ticketPopularity, type BiasModel } from "./bias.ts";
import { makeRng, randInt } from "./random.ts";

export interface PickOptions {
  /** How many tickets to produce. */
  count?: number;
  /** Candidates generated per ticket before the least popular is kept. */
  candidates?: number;
  /**
   * How hard to lean against the crowd. 0 picks uniformly at random; higher
   * values concentrate on numbers players neglect, at the cost of the tickets
   * looking alike.
   */
  contrarianism?: number;
  /** Maximum numbers two returned tickets may share. */
  maxOverlap?: number;
  seed?: number;
}

export interface PickedTicket {
  ticket: Combination;
  /** Chance a random player holds this ticket, relative to an average ticket. */
  popularityRatio: number;
}

/** Weighted sampling without replacement, used to build candidate tickets. */
function weightedSample(weights: number[], k: number, rng: () => number): number[] {
  const pool = weights.map((w, i) => ({ number: i + 1, weight: w }));
  const chosen: number[] = [];
  let total = pool.reduce((a, p) => a + p.weight, 0);
  for (let i = 0; i < k && pool.length > 0; i++) {
    let target = rng() * total;
    let index = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      target -= pool[j]!.weight;
      if (target <= 0) {
        index = j;
        break;
      }
    }
    chosen.push(pool[index]!.number);
    total -= pool[index]!.weight;
    pool.splice(index, 1);
  }
  return chosen.sort((a, b) => a - b);
}

function overlap(a: number[], b: number[]): number {
  const set = new Set(a);
  return b.filter((n) => set.has(n)).length;
}

/**
 * Produce tickets whose combinations the crowd under-plays.
 *
 * Each ticket is the least popular of `candidates` randomly generated
 * alternatives, which keeps the output unpredictable while still landing deep
 * in the unpopular tail.
 */
export function pickTickets(model: BiasModel, options: PickOptions = {}): PickedTicket[] {
  const {
    count = 5,
    candidates = 400,
    contrarianism = 1.5,
    maxOverlap = 2,
    seed = Date.now(),
  } = options;

  const rng = makeRng(seed >>> 0);
  const uniformMain = MAIN_PICK / MAIN_POOL;
  const uniformSuper = 1 / SUPER_POOL;
  const uniformTicketOdds = 1 / (choose(MAIN_POOL, MAIN_PICK) * SUPER_POOL);

  // Sampling weights: the less a number is played, the likelier we pick it.
  const mainWeights = model.main.map((p) => (uniformMain / p) ** contrarianism);
  const superWeights = model.super.map((p) => (uniformSuper / p) ** contrarianism);

  const picked: PickedTicket[] = [];
  for (let i = 0; i < count; i++) {
    let best: PickedTicket | null = null;
    for (let c = 0; c < candidates; c++) {
      const main = weightedSample(mainWeights, MAIN_PICK, rng);
      const superBall = weightedSample(superWeights, 1, rng)[0] ?? 1 + randInt(rng, SUPER_POOL);
      const ticket: Combination = { main, super: superBall };

      // Keep the set of tickets spread out, so one unlucky number cannot sink
      // the whole batch.
      if (picked.some((p) => overlap(p.ticket.main, main) > maxOverlap)) continue;

      const ratio = ticketPopularity(ticket, model) / uniformTicketOdds;
      if (!best || ratio < best.popularityRatio) best = { ticket, popularityRatio: ratio };
    }
    if (best) picked.push(best);
  }
  return picked;
}

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}
