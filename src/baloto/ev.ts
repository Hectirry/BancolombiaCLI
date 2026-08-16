/**
 * What a Baloto ticket is actually worth.
 *
 * Every category of Baloto is pari-mutuel: a fixed share of the night's sales
 * is split between whoever wins it. That has a consequence most players miss —
 * *which* numbers you choose cannot change your odds, but it does change how
 * many people you split with when you win. Picking a combination the crowd
 * avoids is the only lever a player actually controls, and this module prices
 * it.
 *
 * The other lever is patience: the jackpot rolls over, so on a draw with a
 * large accumulated prize the pot contains money that previous draws paid for.
 * `breakevenJackpot` says how large it has to get before a ticket stops being a
 * losing bet in expectation — and `expectedValue` shows why, even then, it
 * rarely is one.
 */

import {
  ECONOMICS,
  JACKPOT_ACCRUAL,
  MAIN_PICK,
  MAIN_POOL,
  PRIZE_TIERS,
  SUPER_POOL,
  afterTax,
  tierProbability,
} from "./rules.ts";
import type { Combination, PrizeTier } from "./rules.ts";
import { matchDistribution, ticketPopularity, type BiasModel } from "./bias.ts";
import { makeRng, randInt } from "./random.ts";

export interface EvOptions {
  /** Accumulated jackpot advertised for the draw, in COP. */
  jackpot: number;
  /** Tickets sold in the draw. Defaults to the median implied by the data. */
  ticketsSold: number;
  /** Ticket price, in COP. */
  ticketPrice?: number;
  /** Apply the 20 % withholding on prizes above 48 UVT. */
  afterTax?: boolean;
  /** Monte Carlo samples per pari-mutuel tier. */
  samples?: number;
  seed?: number;
}

export interface TierValuation {
  tier: string;
  label: string;
  probability: number;
  /** Expected number of tickets sharing this category when you win it. */
  expectedWinners: number;
  /** Expected payout to you, per ticket bought. */
  contribution: number;
}

export interface EvReport {
  ticket: Combination;
  jackpot: number;
  ticketsSold: number;
  ticketPrice: number;
  /** Probability a random player holds this exact ticket, versus 1/15 401 568. */
  popularityRatio: number;
  /** Expected co-winners on the jackpot, versus an average ticket. */
  expectedJackpotSharers: number;
  averageJackpotSharers: number;
  tiers: TierValuation[];
  /** Expected return per ticket, in COP. */
  expectedValue: number;
  /** Expected value divided by price. Below 1 means a losing bet. */
  returnToPlayer: number;
  /** Jackpot at which the ticket would break even, or null if unreachable. */
  breakevenJackpot: number | null;
  taxed: boolean;
}

/**
 * E[1/(1+K)] for K ~ Binomial(n, q): the fraction of a pari-mutuel pot you keep
 * when `n` other tickets are in play and each holds your combination with
 * probability `q`. The closed form is (1 − (1−q)^(n+1)) / ((n+1)q).
 */
export function expectedShare(n: number, q: number): number {
  if (q <= 0 || n <= 0) return 1;
  return (1 - (1 - q) ** (n + 1)) / ((n + 1) * q);
}

/** Probability that a random player's ticket lands in `tier` against `drawn`. */
function tierProbabilityUnderModel(
  tier: PrizeTier,
  drawn: Combination,
  model: BiasModel,
): number {
  const weights = model.main.map((p) => p / (1 - p));
  const drawnSet = new Set(drawn.main);
  const inside = drawn.main.map((n) => weights[n - 1]!);
  const outside: number[] = [];
  for (let n = 1; n <= MAIN_POOL; n++) if (!drawnSet.has(n)) outside.push(weights[n - 1]!);
  const pb = matchDistribution(inside, outside);
  const sigma = model.super[drawn.super - 1]!;
  let mass = 0;
  for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
  return mass * (tier.superMatch ? sigma : 1 - sigma);
}

/**
 * Sample a drawn combination *conditional on* `ticket` winning `tier`, so the
 * crowding of that category can be measured in the situation that matters.
 */
function sampleWinningDraw(
  ticket: Combination,
  tier: PrizeTier,
  rng: () => number,
): Combination {
  const matched = tier.minMain === tier.maxMain
    ? tier.minMain
    : tier.minMain + randInt(rng, tier.maxMain - tier.minMain + 1);

  const mine = [...ticket.main];
  // Choose which of the player's numbers come out.
  for (let i = 0; i < matched; i++) {
    const j = i + randInt(rng, mine.length - i);
    [mine[i], mine[j]] = [mine[j]!, mine[i]!];
  }
  const hit = mine.slice(0, matched);

  const others: number[] = [];
  const own = new Set(ticket.main);
  for (let n = 1; n <= MAIN_POOL; n++) if (!own.has(n)) others.push(n);
  for (let i = 0; i < MAIN_PICK - matched; i++) {
    const j = i + randInt(rng, others.length - i);
    [others[i], others[j]] = [others[j]!, others[i]!];
  }

  const main = [...hit, ...others.slice(0, MAIN_PICK - matched)].sort((a, b) => a - b);
  let superBall = ticket.super;
  if (!tier.superMatch) {
    superBall = 1 + randInt(rng, SUPER_POOL - 1);
    if (superBall >= ticket.super) superBall++;
  }
  return { main, super: superBall };
}

/**
 * Value one ticket for one draw. Jackpot sharing uses the exact binomial
 * formula; the pari-mutuel categories below it are crowded enough that the
 * mean number of co-winners is a good approximation, and are averaged over
 * simulated draws that the ticket actually wins.
 */
export function expectedValue(
  ticket: Combination,
  model: BiasModel,
  options: EvOptions,
): EvReport {
  const {
    jackpot,
    ticketsSold,
    ticketPrice = ECONOMICS.ticketPrice,
    afterTax: applyTax = false,
    samples = 4000,
    seed = 20260815,
  } = options;

  const rng = makeRng(seed);
  const sales = ticketsSold * ticketPrice;
  const net = (prize: number) => (applyTax ? afterTax(prize) : prize);

  const q = ticketPopularity(ticket, model);
  const uniformQ = 1 / (combinations() * SUPER_POOL);

  const tiers: TierValuation[] = [];
  let total = 0;
  let jackpotSlope = 0;

  for (const tier of PRIZE_TIERS) {
    const probability = tierProbability(tier);

    if (tier.kind === "fixed") {
      // The eighth category simply refunds the ticket, whoever else wins it.
      const contribution = probability * net(ticketPrice);
      tiers.push({
        tier: tier.id,
        label: tier.label,
        probability,
        expectedWinners: ticketsSold * probability,
        contribution,
      });
      total += contribution;
      continue;
    }

    if (tier.kind === "jackpot") {
      const share = expectedShare(Math.max(0, ticketsSold - 1), q);
      // The pot receives the regulation's effective accrual, not the nominal
      // 36,744 % — on a long roll-over (any jackpot worth valuing) PAcum has
      // long passed 40 %, so the applicable rate is 32 % (Acuerdo 03/2021).
      const pot = jackpot + JACKPOT_ACCRUAL.late * sales;
      const contribution = probability * net(pot * share);
      // Keep the slope in J so the break-even jackpot can be solved directly.
      jackpotSlope = probability * share * (applyTax ? 1 - 0.2 : 1);
      tiers.push({
        tier: tier.id,
        label: tier.label,
        probability,
        expectedWinners: 1 + Math.max(0, ticketsSold - 1) * q,
        contribution,
      });
      total += contribution;
      continue;
    }

    // Pari-mutuel middle categories: simulate draws this ticket wins and see
    // how crowded the category is in each of them.
    const pot = tier.allocation * sales;
    let sumWinners = 0;
    let sumPayout = 0;
    for (let s = 0; s < samples; s++) {
      const drawn = sampleWinningDraw(ticket, tier, rng);
      const p = tierProbabilityUnderModel(tier, drawn, model);
      const winners = Math.max(1, ticketsSold * p);
      sumWinners += winners;
      sumPayout += net(pot / winners);
    }
    const contribution = probability * (sumPayout / samples);
    tiers.push({
      tier: tier.id,
      label: tier.label,
      probability,
      expectedWinners: sumWinners / samples,
      contribution,
    });
    total += contribution;
  }

  const breakeven = jackpotSlope > 0
    ? (ticketPrice - (total - (tiers[0]?.contribution ?? 0))) / jackpotSlope
      - PRIZE_TIERS[0]!.allocation * sales
    : null;

  return {
    ticket,
    jackpot,
    ticketsSold,
    ticketPrice,
    popularityRatio: q / uniformQ,
    expectedJackpotSharers: Math.max(0, ticketsSold - 1) * q,
    averageJackpotSharers: Math.max(0, ticketsSold - 1) * uniformQ,
    tiers,
    expectedValue: total,
    returnToPlayer: total / ticketPrice,
    breakevenJackpot: breakeven !== null && Number.isFinite(breakeven) ? breakeven : null,
    taxed: applyTax,
  };
}

function combinations(): number {
  let result = 1;
  for (let i = 0; i < MAIN_PICK; i++) result = (result * (MAIN_POOL - i)) / (i + 1);
  return Math.round(result);
}
