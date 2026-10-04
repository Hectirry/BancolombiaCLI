/**
 * The recommendation ledger: what the model said, before the draw, on the
 * record — so that scoring is never done from memory and never in hindsight.
 *
 * `baloto super --record` writes the tickets it just produced against the
 * next draw date; `baloto score` matches every recorded entry to the draw
 * that followed and reports the Súper Balota hit rate against its exact
 * expectation (tickets/16), with a binomial p-value. The ledger is the live
 * half of the scoring discipline: the tournament is the past, this is the
 * future as it arrives.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { datasetPath, type Draw, type Game } from "./dataset.ts";
import { PRIZE_TIERS, SUPER_POOL, classify } from "./rules.ts";
import { poissonBinomialPmf } from "./numeric.ts";

export interface LedgerTicket {
  main: number[];
  super: number;
}

export interface LedgerEntry {
  /** ISO timestamp of when the recommendation was made. */
  recordedAt: string;
  /** The draw the tickets were meant for. */
  targetDate: string;
  game: Game;
  tickets: LedgerTicket[];
  /** Which model produced them, e.g. "super/posterior". */
  model: string;
  note?: string;
}

export interface Ledger {
  entries: LedgerEntry[];
}

export function ledgerPath(): string {
  return join(dirname(datasetPath()), "baloto-ledger.json");
}

export async function loadLedger(): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(), "utf8")) as Ledger;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2), "utf8");
}

/** Draw days: Monday (1), Wednesday (3), Saturday (6). */
const DRAW_DAYS = new Set([1, 3, 6]);

/** The first draw date strictly after `date` (YYYY-MM-DD). */
export function nextDrawDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (!DRAW_DAYS.has(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

/**
 * Add an entry. One recommendation per (target, game, model): recording again
 * for the same draw replaces the earlier one, so the ledger holds the last
 * word said before the draw, not every draft.
 */
export function recordRecommendation(ledger: Ledger, entry: LedgerEntry): Ledger {
  const entries = ledger.entries.filter(
    (e) => !(e.targetDate === entry.targetDate && e.game === entry.game && e.model === entry.model),
  );
  entries.push(entry);
  entries.sort((a, b) => a.targetDate.localeCompare(b.targetDate) || a.recordedAt.localeCompare(b.recordedAt));
  return { entries };
}

export interface ScoredEntry {
  entry: LedgerEntry;
  draw: Draw;
  /** Main-number matches per ticket. */
  matches: number[];
  /** Index of the ticket that hit the Súper Balota, or −1. */
  superHitTicket: number;
  /** Best paying tier id across the tickets, or null. */
  bestTier: string | null;
  wonAnything: boolean;
}

export interface LedgerScore {
  scored: ScoredEntry[];
  pending: LedgerEntry[];
  /** Draws where some ticket hit the Súper Balota. */
  superHits: number;
  /** Σ tickets/16 over scored draws — the exact expectation. */
  superExpected: number;
  /**
   * Two-sided exact p-value of `superHits` under the fair null. Each scored
   * draw is a Bernoulli with probability (distinct Súper Balotas)/16, so the
   * hit count is Poisson-binomial; when every entry carries the same number
   * of distinct balls this is the plain binomial. Null only when nothing has
   * been scored yet.
   */
  superPValue: number | null;
  wins: number;
}

/** Match recorded recommendations to the draws that followed, and score them. */
export function scoreLedger(ledger: Ledger, draws: Draw[]): LedgerScore {
  const byKey = new Map(draws.map((d) => [`${d.date}:${d.game}`, d]));
  const scored: ScoredEntry[] = [];
  const pending: LedgerEntry[] = [];
  const tierRank = new Map(PRIZE_TIERS.map((t, i) => [t.id, i]));

  for (const entry of ledger.entries) {
    const draw = byKey.get(`${entry.targetDate}:${entry.game}`);
    if (!draw) {
      pending.push(entry);
      continue;
    }
    const drawn = new Set(draw.main);
    const matches = entry.tickets.map((t) => t.main.filter((n) => drawn.has(n)).length);
    const superHitTicket = entry.tickets.findIndex((t) => t.super === draw.super);
    let bestTier: string | null = null;
    for (const t of entry.tickets) {
      const tier = classify({ main: t.main, super: t.super }, { main: draw.main, super: draw.super });
      if (tier && (bestTier === null || tierRank.get(tier.id)! < tierRank.get(bestTier)!)) bestTier = tier.id;
    }
    scored.push({ entry, draw, matches, superHitTicket, bestTier, wonAnything: bestTier !== null });
  }

  const superHits = scored.filter((s) => s.superHitTicket >= 0).length;
  const probabilities = scored.map((s) => distinctSupers(s.entry) / SUPER_POOL);
  const superExpected = probabilities.reduce((acc, p) => acc + p, 0);
  const superPValue = scored.length > 0 ? poissonBinomialTwoSided(superHits, probabilities) : null;
  return {
    scored,
    pending,
    superHits,
    superExpected,
    superPValue,
    wins: scored.filter((s) => s.wonAnything).length,
  };
}

function distinctSupers(entry: LedgerEntry): number {
  return Math.min(SUPER_POOL, new Set(entry.tickets.map((t) => t.super)).size);
}

/**
 * Exact two-sided binomial p-value, by doubling the smaller tail (both tails
 * include the observed count) and capping at 1.
 *
 * Doubling is one of the two standard conventions for a skewed null. The
 * other — summing every outcome whose probability is at most that of the
 * observed one, as R's `binom.test` does — gives smaller values (0.049
 * against 0.098 for 3 hits in 5 draws at 3/16). Doubling is the conservative
 * one and is what the ledger reports: it never overstates the evidence. An
 * observation at the centre of the distribution has a smaller tail above 1/2,
 * so the doubled value exceeds 1 and the cap returns exactly 1.
 */
export function binomialTwoSided(k: number, n: number, p: number): number {
  return poissonBinomialTwoSided(k, new Array<number>(n).fill(p));
}

/**
 * Exact two-sided p-value of `k` successes among independent Bernoulli trials
 * with the given probabilities (doubling the smaller tail, capped at 1). With
 * equal probabilities it is `binomialTwoSided`.
 */
export function poissonBinomialTwoSided(k: number, probabilities: number[]): number {
  const n = probabilities.length;
  if (n === 0) return 1;
  const pmf = poissonBinomialPmf(probabilities.map((p) => Math.min(1, Math.max(0, p))));
  let upper = 0;
  for (let i = k; i <= n; i++) upper += pmf[i]!;
  let lower = 0;
  for (let i = 0; i <= k; i++) lower += pmf[i]!;
  return Math.min(1, 2 * Math.min(upper, lower));
}
