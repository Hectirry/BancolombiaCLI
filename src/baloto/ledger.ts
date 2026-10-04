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
import { ECONOMICS, PRIZE_TIERS, SUPER_POOL, classify } from "./rules.ts";
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
  /**
   * True when the same tickets also play the night's other draw (Revancha
   * for a Baloto ticket). The night is then scored against both draws and
   * its exact expectation doubles up: 1 − (1 − k/16)².
   */
  revancha?: boolean;
  /**
   * What the tickets cost, in COP, at the prices in force when they were
   * recorded. Stored rather than recomputed because prices change and a
   * stake is a fact about the night it was placed.
   */
  cost?: number;
}

/** The other draw of the same night. */
export function companionGame(game: Game): Game {
  return game === "baloto" ? "revancha" : "baloto";
}

/** What an entry cost: the recorded figure, or today's prices when it has none. */
export function entryCost(entry: LedgerEntry): number {
  if (typeof entry.cost === "number" && Number.isFinite(entry.cost)) return entry.cost;
  const perTicket = ECONOMICS.ticketPrice + (entry.revancha ? ECONOMICS.revanchaPrice : 0);
  return entry.tickets.length * perTicket;
}

/** Exact P(some ticket hits the Súper Balota in at least one of the night's draws). */
export function entryExpectation(entry: LedgerEntry): number {
  const perDraw = distinctSupers(entry) / SUPER_POOL;
  return 1 - (1 - perDraw) ** (entry.revancha ? 2 : 1);
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

/** The tickets scored against one draw. */
export interface DrawResult {
  draw: Draw;
  /** Main-number matches per ticket. */
  matches: number[];
  /** Index of the ticket that hit the Súper Balota, or −1. */
  superHitTicket: number;
  /** Best paying tier id across the tickets, or null. */
  bestTier: string | null;
}

export interface ScoredEntry extends DrawResult {
  entry: LedgerEntry;
  /** The night's other draw, when the entry played Revancha. */
  companion: DrawResult | null;
  /** True when some ticket hit the Súper Balota in any draw it played. */
  nightSuperHit: boolean;
  /** Exact P(nightSuperHit) for this entry: 1 − (1 − k/16)^draws. */
  expected: number;
  /** True when some ticket won anything in any draw it played. */
  wonAnything: boolean;
}

/** Nights without a Súper Balota hit, read as a bettor reads a drought. */
export interface Streak {
  /** Consecutive scored nights without a hit, counting back from the latest. */
  current: number;
  /** Longest such run in the ledger. */
  longest: number;
  /** P(a run at least as long as `current`) under the model, exact: Π(1 − pᵢ). */
  pCurrent: number;
}

export interface LedgerScore {
  scored: ScoredEntry[];
  pending: LedgerEntry[];
  /** Nights where some ticket hit the Súper Balota in any draw it played. */
  superHits: number;
  /** Σ over nights of the exact per-night hit probability. */
  superExpected: number;
  /**
   * Two-sided exact p-value of `superHits` under the fair null. Each scored
   * draw is a Bernoulli with probability (distinct Súper Balotas)/16, so the
   * hit count is Poisson-binomial; when every entry carries the same number
   * of distinct balls this is the plain binomial. Null only when nothing has
   * been scored yet.
   */
  superPValue: number | null;
  /** The shared per-night expectation behind `superPValue`, or null when nights differ. */
  nightRate: number | null;
  wins: number;
  /** Tickets bought over the scored nights. */
  tickets: number;
  /** Pesos staked over the scored nights. */
  staked: number;
  /** Pesos staked per Súper Balota hit: observed, and what the model implies. */
  stakePerHit: { observed: number | null; expected: number };
  streak: Streak;
}

/**
 * Match recorded recommendations to the draws that followed, and score them.
 *
 * `draws` may hold both games: an entry is matched to its own game on its
 * target date, and, when it played Revancha, to the other game that night as
 * well. A night is pending until every draw it played is in the dataset, so a
 * Revancha night is never half-scored.
 */
export function scoreLedger(ledger: Ledger, draws: Draw[]): LedgerScore {
  const byKey = new Map(draws.map((d) => [`${d.date}:${d.game}`, d]));
  const scored: ScoredEntry[] = [];
  const pending: LedgerEntry[] = [];

  for (const entry of ledger.entries) {
    const draw = byKey.get(`${entry.targetDate}:${entry.game}`);
    const other = entry.revancha ? byKey.get(`${entry.targetDate}:${companionGame(entry.game)}`) : undefined;
    if (!draw || (entry.revancha && !other)) {
      pending.push(entry);
      continue;
    }
    const own = scoreAgainst(entry.tickets, draw);
    const companion = other ? scoreAgainst(entry.tickets, other) : null;
    scored.push({
      entry,
      ...own,
      companion,
      nightSuperHit: own.superHitTicket >= 0 || (companion !== null && companion.superHitTicket >= 0),
      expected: entryExpectation(entry),
      wonAnything: own.bestTier !== null || (companion !== null && companion.bestTier !== null),
    });
  }

  const superHits = scored.filter((s) => s.nightSuperHit).length;
  const probabilities = scored.map((s) => s.expected);
  const superExpected = probabilities.reduce((acc, p) => acc + p, 0);
  // Each night is a Bernoulli with its own exact probability (distinct balls,
  // one or two draws), so the hit count is Poisson-binomial; equal nights
  // reduce to the plain binomial.
  const superPValue = scored.length > 0 ? poissonBinomialTwoSided(superHits, probabilities) : null;
  const rates = new Set(probabilities);
  const nightRate = scored.length > 0 && rates.size === 1 ? [...rates][0]! : null;
  const staked = scored.reduce((acc, s) => acc + entryCost(s.entry), 0);
  return {
    scored,
    pending,
    superHits,
    superExpected,
    superPValue,
    nightRate,
    wins: scored.filter((s) => s.wonAnything).length,
    tickets: scored.reduce((acc, s) => acc + s.entry.tickets.length, 0),
    staked,
    stakePerHit: {
      observed: superHits > 0 ? staked / superHits : null,
      expected: superExpected > 0 ? staked / superExpected : 0,
    },
    streak: droughts(scored),
  };
}

function scoreAgainst(tickets: LedgerTicket[], draw: Draw): DrawResult {
  const tierRank = new Map(PRIZE_TIERS.map((t, i) => [t.id, i]));
  const drawn = new Set(draw.main);
  const matches = tickets.map((t) => t.main.filter((n) => drawn.has(n)).length);
  const superHitTicket = tickets.findIndex((t) => t.super === draw.super);
  let bestTier: string | null = null;
  for (const t of tickets) {
    const tier = classify({ main: t.main, super: t.super }, { main: draw.main, super: draw.super });
    if (tier && (bestTier === null || tierRank.get(tier.id)! < tierRank.get(bestTier)!)) bestTier = tier.id;
  }
  return { draw, matches, superHitTicket, bestTier };
}

/**
 * Runs of nights without a Súper Balota hit. The probability attached to the
 * current run is exact under the model — the product of each night's miss
 * probability — so that a drought is read against what the model itself
 * predicts rather than against a feeling: with three tickets, five straight
 * misses happen 35 % of the time, and ten straight 12.5 %.
 */
function droughts(scored: ScoredEntry[]): Streak {
  let longest = 0;
  let run = 0;
  for (const s of scored) {
    run = s.nightSuperHit ? 0 : run + 1;
    if (run > longest) longest = run;
  }
  const current = run;
  let pCurrent = 1;
  for (const s of scored.slice(scored.length - current)) pCurrent *= 1 - s.expected;
  return { current, longest, pCurrent };
}

function distinctSupers(entry: LedgerEntry): number {
  return Math.min(SUPER_POOL, new Set(entry.tickets.map((t) => t.super)).size);
}

/**
 * Nights needed to tell a hit rate `p0` from `p1` with a two-sided test at
 * `alpha` and the given power (normal approximation to the binomial). This is
 * the question a ledger has to answer before anyone reads a streak into it:
 * 18.75 % against 25 % — a rule worth one more ticket of coverage — needs
 * 327 nights (two years at 156 draws a year); against 21 %, 2 425 nights.
 */
export function nightsToDistinguish(p0: number, p1: number, alpha = 0.05, power = 0.8): number {
  if (p1 === p0) return Infinity;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const n = ((za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1))) / Math.abs(p1 - p0)) ** 2;
  return Math.ceil(n);
}

/**
 * The smallest departure from `p0` that `nights` scored nights could detect
 * at the given power — the honest size of what the ledger can see so far.
 */
export function detectableDeparture(nights: number, p0: number, alpha = 0.05, power = 0.8): number {
  if (nights <= 0) return 1;
  // nightsToDistinguish is decreasing in |p1 − p0| above p0; bisect on it.
  let lo = 0;
  let hi = 1 - p0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (nightsToDistinguish(p0, p0 + mid, alpha, power) > nights) lo = mid;
    else hi = mid;
  }
  return hi;
}

function normalQuantile(p: number): number {
  // Newton on Phi(z) = p, starting from a crude guess.
  let z = p > 0.5 ? 1 : -1;
  for (let i = 0; i < 60; i++) {
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    z += (p - normalCdf(z)) / pdf;
  }
  return z;
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 26.2.17, good to 7.5e-8.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - tail : tail;
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
