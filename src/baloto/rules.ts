/**
 * Rules, combinatorics and prize economics of Colombia's Baloto.
 *
 * Format in force since the relaunch of January 2018 ("nuevo Baloto"): five
 * distinct numbers are drawn from a 43-ball machine and one Súper Balota from
 * an independent 16-ball machine. The two machines are independent, so the
 * Súper Balota may repeat one of the five main numbers — the historical data
 * confirms this (101 such draws between 2018 and 2026).
 *
 * Everything a player can reasonably want to override (ticket price, prize
 * allocations, tax) lives here as a named constant, because these are set by
 * the operator and change over time.
 */

/** Size of the main ball pool: numbers 1..43. */
export const MAIN_POOL = 43;
/** How many main numbers are drawn (and picked) per ticket. */
export const MAIN_PICK = 5;
/** Size of the Súper Balota pool: numbers 1..16. */
export const SUPER_POOL = 16;

/**
 * First draw played under the current 5/43 + 1/16 format. Draws before this
 * date used a different game (six balls from 1..45) and must never be mixed
 * into the statistics: they live in a different sample space.
 */
export const FORMAT_START_DATE = "2018-01-03";

/** A single ticket / draw result: five distinct main numbers plus a Súper Balota. */
export interface Combination {
  /** Five distinct numbers in 1..43, always stored ascending. */
  main: number[];
  /** Súper Balota in 1..16. */
  super: number;
}

/** Binomial coefficient. Exact for the small arguments used here. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

/** Number of distinct main-number combinations: C(43,5) = 962 598. */
export const MAIN_COMBINATIONS = choose(MAIN_POOL, MAIN_PICK);
/** Total distinct tickets: C(43,5) × 16 = 15 401 568. */
export const TOTAL_COMBINATIONS = MAIN_COMBINATIONS * SUPER_POOL;

/**
 * Probability that a ticket matches exactly `k` of the five drawn main
 * numbers, under the (correct) hypergeometric model.
 */
export function mainMatchProbability(k: number): number {
  return (
    (choose(MAIN_PICK, k) * choose(MAIN_POOL - MAIN_PICK, MAIN_PICK - k)) /
    MAIN_COMBINATIONS
  );
}

/** How a prize tier pays out. */
export type PrizeKind =
  /** Rolling jackpot: this draw's allocation plus everything accumulated. */
  | "jackpot"
  /** Pari-mutuel: a fixed share of sales split between that tier's winners. */
  | "parimutuel"
  /** Fixed amount per winner (the eighth category refunds the ticket). */
  | "fixed";

export interface PrizeTier {
  /** Stable identifier used in the dataset and on the CLI. */
  id: string;
  /** Label as printed by the operator. */
  label: string;
  /** Inclusive range of main numbers matched. */
  minMain: number;
  maxMain: number;
  /** Whether the Súper Balota must match. */
  superMatch: boolean;
  kind: PrizeKind;
  /**
   * Share of ticket sales allocated to this tier, as published in the game's
   * prize plan. `calibrateAllocations` in `bias.ts` re-estimates these from the
   * observed payouts, so treat them as a prior rather than gospel.
   */
  allocation: number;
}

/**
 * The eight prize categories, most valuable first. Category 8 groups "1 acierto
 * + Súper Balota" with "sólo Súper Balota" and refunds the ticket price.
 */
export const PRIZE_TIERS: PrizeTier[] = [
  { id: "5+S", label: "5 aciertos + Súper Balota", minMain: 5, maxMain: 5, superMatch: true, kind: "jackpot", allocation: 0.3674 },
  { id: "5", label: "5 aciertos", minMain: 5, maxMain: 5, superMatch: false, kind: "parimutuel", allocation: 0.0239 },
  { id: "4+S", label: "4 aciertos + Súper Balota", minMain: 4, maxMain: 4, superMatch: true, kind: "parimutuel", allocation: 0.0048 },
  { id: "4", label: "4 aciertos", minMain: 4, maxMain: 4, superMatch: false, kind: "parimutuel", allocation: 0.0052 },
  { id: "3+S", label: "3 aciertos + Súper Balota", minMain: 3, maxMain: 3, superMatch: true, kind: "parimutuel", allocation: 0.0045 },
  { id: "3", label: "3 aciertos", minMain: 3, maxMain: 3, superMatch: false, kind: "parimutuel", allocation: 0.0148 },
  { id: "2+S", label: "2 aciertos + Súper Balota", minMain: 2, maxMain: 2, superMatch: true, kind: "parimutuel", allocation: 0.0118 },
  { id: "1+S", label: "1 ó 0 aciertos + Súper Balota", minMain: 0, maxMain: 1, superMatch: true, kind: "fixed", allocation: 0.0673 },
];

export const TIER_BY_ID: Record<string, PrizeTier> = Object.fromEntries(
  PRIZE_TIERS.map((t) => [t.id, t]),
);

/** Exact probability of landing in a given tier with a single ticket. */
export function tierProbability(tier: PrizeTier): number {
  let main = 0;
  for (let k = tier.minMain; k <= tier.maxMain; k++) main += mainMatchProbability(k);
  const superP = tier.superMatch ? 1 / SUPER_POOL : 1 - 1 / SUPER_POOL;
  return main * superP;
}

/** Probability of winning *something* — about 1 in 14. */
export function anyPrizeProbability(): number {
  return PRIZE_TIERS.reduce((sum, t) => sum + tierProbability(t), 0);
}

/** Which tier (if any) a ticket lands in against a drawn combination. */
export function classify(ticket: Combination, drawn: Combination): PrizeTier | null {
  const drawnSet = new Set(drawn.main);
  let matches = 0;
  for (const n of ticket.main) if (drawnSet.has(n)) matches++;
  const superHit = ticket.super === drawn.super;
  for (const tier of PRIZE_TIERS) {
    if (matches >= tier.minMain && matches <= tier.maxMain && tier.superMatch === superHit) {
      return tier;
    }
  }
  return null;
}

/**
 * Commercial parameters. Prices include VAT and are the ones advertised by the
 * operator in 2025–2026; override them on the CLI if they move.
 */
export const ECONOMICS = {
  /** Price of one Baloto ticket, in COP. */
  ticketPrice: 6_000,
  /** Extra cost of adding Revancha to the same ticket, in COP. */
  revanchaPrice: 2_100,
  /** Minimum guaranteed jackpot, in COP. */
  minimumJackpot: 4_000_000_000,
} as const;

/**
 * Colombian withholding on lottery prizes: 20 % (art. 404-1 ET) on any single
 * prize above 48 UVT. The UVT is reset every year by the DIAN — 2026 value.
 */
export const TAX = {
  rate: 0.2,
  /** Threshold in UVT above which the withholding applies. */
  thresholdUvt: 48,
  /** DIAN value of one UVT for 2026, in COP. */
  uvt: 52_374,
} as const;

/** Prize threshold in pesos above which the 20 % withholding is applied. */
export function taxThreshold(): number {
  return TAX.thresholdUvt * TAX.uvt;
}

/** Net prize after the 20 % withholding, if it applies. */
export function afterTax(prize: number): number {
  return prize > taxThreshold() ? prize * (1 - TAX.rate) : prize;
}
