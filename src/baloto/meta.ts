/**
 * Meta-rules for the Súper Balota tournament: what a bettor does *between*
 * systems.
 *
 * The thirteen base rules in `baloto super` each answer "which balls" from the
 * history alone. A player who has watched them for a while does something
 * else: follows whichever system has been winning, averages them, bets
 * against the one on top, or blends the "recent form" systems. Those habits
 * are rules too, and they are entered here so they get a number instead of a
 * feeling.
 *
 * NESTED WALK-FORWARD. A meta-rule at draw L may use only what the base rules
 * *did* on draws before L — their choices on draw k were made from the first k
 * draws, and their hit on draw k is known once draw k is in the past. Nothing
 * from draw L itself leaks in: the record a meta-rule reads at L is the record
 * a bettor would have had the evening before. `scoreSuperRules` then scores
 * the meta-rule exactly as it scores a base rule, against the exact null of
 * what it covered.
 *
 * WHY THIS CANNOT WIN IF THE BASE RULES ARE NOISE. On a fair machine every
 * base rule hits each draw with probability n/16, independently of its past
 * record. "Follow the leader" is then a rule whose choice on draw L is some
 * base rule's choice on draw L, selected by a function of draws < L — and that
 * choice still covers n distinct balls, so it hits with probability exactly
 * n/16. The leader's lead is a random walk the selection is chasing, not a
 * property of the ball. The same holds for every weighted vote: the vote
 * changes *which* n distinct balls are played, never how many, and under
 * exchangeability which balls does not matter. A meta-rule can only beat n/16
 * if some base rule does, and then only by as much as that rule does, less the
 * draws spent discovering it. This file exists to measure that, not to hope.
 *
 * COST. The nested record needs every base rule's choice at every history
 * length from `start` to L − 1. Recomputing that at each L would be O(L²) base
 * calls; `SuperChoiceCache` stores each length once, verifies that it is
 * still looking at the same history, and also serves the base rules
 * themselves (`cached()`), so the tournament evaluates each base rule once per
 * draw whether or not meta-rules are entered.
 */

import type { Draw } from "./dataset.ts";
import { SUPER_POOL } from "./rules.ts";
import type { SuperRule } from "./superball.ts";

export interface MetaOptions {
  /**
   * First history length at which base rules are put on the record. Below it
   * several base rules return placeholders (the HMM plays 1..n under 50 draws),
   * which would charge them hits they did not earn. Default 50.
   */
  start?: number;
  /** Share a cache built by the caller (so the base rules are evaluated once). */
  cache?: SuperChoiceCache;
  /** Temperatures for the Bayesian-average rule. Default {0.5, 1}. */
  betas?: number[];
}

/** Hit or miss of one choice on one draw, with the tournament's own cut and clean-up. */
function hits(choice: number[], tickets: number, truth: number): boolean {
  for (let i = 0; i < Math.min(tickets, choice.length); i++) {
    const b = choice[i]!;
    if (Number.isInteger(b) && b >= 1 && b <= SUPER_POOL && b === truth) return true;
  }
  return false;
}

/**
 * Choices of every base rule, by history length and ticket count, for one
 * history. The cache trusts a `past` only while it is a prefix of the history
 * it has seen so far (checked draw by draw on date and Súper Balota); a
 * different history flushes everything, so a cache can never answer for the
 * wrong draws. Lengths must be requested in ascending order for the base
 * rules' own memoisation (`memo`, `memoFit` in algorithms.ts, the HMM epoch)
 * to stay warm; `record()` fills in ascending order for that reason.
 */
export class SuperChoiceCache {
  /** Fingerprint of the longest history seen: date and Súper Balota per draw. */
  private dates: string[] = [];
  private supers: number[] = [];
  /** choices.get(tickets)[length] = one choice per base rule. */
  private choices = new Map<number, (number[][] | undefined)[]>();
  /** cumulative.get(tickets)[length] = hits of each base rule over draws k ∈ [start, length). */
  private cumulative = new Map<number, (number[] | undefined)[]>();

  constructor(
    readonly base: SuperRule[],
    readonly start = 50,
  ) {}

  /** Flushes the cache when `past` is not a prefix of what has been seen; extends the fingerprint otherwise. */
  private sync(past: Draw[]): void {
    const common = Math.min(past.length, this.supers.length);
    for (let i = 0; i < common; i++) {
      if (past[i]!.super !== this.supers[i] || past[i]!.date !== this.dates[i]) {
        this.dates = [];
        this.supers = [];
        this.choices.clear();
        this.cumulative.clear();
        break;
      }
    }
    for (let i = this.supers.length; i < past.length; i++) {
      this.supers.push(past[i]!.super);
      this.dates.push(past[i]!.date);
    }
  }

  /**
   * What every base rule plays on the draw after `past`, computed once per
   * (length, tickets). Every length from `start` up to `past.length` is filled
   * first, in ascending order: the base rules' own memoisation refits at the
   * first length it sees in an epoch, so a strictly ascending sequence of
   * calls is what keeps their answers identical to a plain tournament's.
   */
  choicesAt(past: Draw[], tickets: number): number[][] {
    this.sync(past);
    let byLength = this.choices.get(tickets);
    if (!byLength) {
      byLength = [];
      this.choices.set(tickets, byLength);
    }
    const L = past.length;
    if (L >= this.start) {
      for (let k = this.start; k < L; k++) {
        if (!byLength[k]) byLength[k] = this.base.map((rule) => rule.choose(past.slice(0, k), tickets).slice(0, tickets));
      }
    }
    const hit = byLength[L];
    if (hit) return hit;
    const fresh = this.base.map((rule) => rule.choose(past, tickets).slice(0, tickets));
    byLength[L] = fresh;
    return fresh;
  }

  /**
   * Cumulative hits of every base rule over the draws k ∈ [start, past.length),
   * each scored with the choice made from the first k draws: the record a
   * bettor would hold the evening before the draw that follows `past`. Also
   * returns how many draws that record spans.
   */
  record(past: Draw[], tickets: number): { hits: number[]; trials: number } {
    this.sync(past);
    let byLength = this.cumulative.get(tickets);
    if (!byLength) {
      byLength = [];
      this.cumulative.set(tickets, byLength);
    }
    const L = past.length;
    const zero = () => this.base.map(() => 0);
    if (L <= this.start) return { hits: zero(), trials: 0 };
    // Find the longest prefix already summed, then extend it in ascending order.
    let k = L;
    while (k > this.start && !byLength[k]) k--;
    let acc = k > this.start ? byLength[k]!.slice() : zero();
    if (k <= this.start) {
      k = this.start;
      byLength[k] = acc.slice();
    }
    for (; k < L; k++) {
      const choices = this.choicesAt(past.slice(0, k), tickets);
      const truth = past[k]!.super;
      acc = acc.map((h, r) => h + (hits(choices[r]!, tickets, truth) ? 1 : 0));
      byLength[k + 1] = acc;
    }
    return { hits: byLength[L]!.slice(), trials: L - this.start };
  }

  /** The base rules themselves, served through this cache, under their own names. */
  cached(): SuperRule[] {
    return this.base.map((rule, r) => ({
      name: rule.name,
      choose: (past, n) => this.choicesAt(past, n)[r]!,
    }));
  }
}

/** Index of the leading base rule: most cumulative hits, ties to the alphabetically first name. */
export function leaderIndex(base: SuperRule[], record: number[]): number {
  let best = 0;
  for (let r = 1; r < base.length; r++) {
    const d = record[r]! - record[best]!;
    if (d > 0 || (d === 0 && base[r]!.name.localeCompare(base[best]!.name) < 0)) best = r;
  }
  return best;
}

/**
 * `n` distinct legal balls ranked by vote, ties to the lower ball; filled from
 * the lowest unplayed balls if the votes do not reach `n`, so the rule always
 * covers exactly n/16 and is scored for what it covers.
 */
function topVoted(votes: number[], n: number, exclude = new Set<number>()): number[] {
  const byVote = (a: number, b: number) => votes[b - 1]! - votes[a - 1]! || a - b;
  const all = Array.from({ length: SUPER_POOL }, (_, i) => i + 1);
  // Excluded balls go last, so a budget wider than the rest of the pool
  // (n = 16 against a leader who plays everything) is still fully covered.
  const ranked = [...all.filter((b) => !exclude.has(b)).sort(byVote), ...all.filter((b) => exclude.has(b)).sort(byVote)];
  return ranked.slice(0, Math.min(n, SUPER_POOL));
}

/** Adds each rule's first `n` balls to `votes` with its weight. */
function castVotes(choices: number[][], weights: number[], n: number, votes: number[], positional = false): void {
  choices.forEach((choice, r) => {
    const w = weights[r]!;
    if (!(w > 0)) return;
    const seen = new Set<number>();
    for (let i = 0; i < Math.min(n, choice.length); i++) {
      const b = choice[i]!;
      if (!Number.isInteger(b) || b < 1 || b > SUPER_POOL || seen.has(b)) continue;
      seen.add(b);
      votes[b - 1]! += positional ? w * (n - i) : w;
    }
  });
}

/** The four "recent form" base rules, matched by name so the list survives renaming within reason. */
const RECENCY_PATTERNS = [/persist/i, /repeat the last/i, /last 100/i, /cold/i];

/**
 * The meta-rules, over the given base rules, as tournament entries. Every one
 * returns `n` distinct legal balls and reads only the nested record described
 * above. Pass a shared `cache` (and enter `cache.cached()` as the base rules)
 * so the tournament computes each base choice once.
 */
export function metaSuperRules(base: SuperRule[], options: MetaOptions = {}): SuperRule[] {
  const cache = options.cache ?? new SuperChoiceCache(base, options.start ?? 50);
  const betas = options.betas ?? [0.5, 1];
  const fallback = (n: number) => Array.from({ length: Math.min(n, SUPER_POOL) }, (_, i) => i + 1);

  const rules: SuperRule[] = [
    {
      name: "meta: follow the leader",
      choose: (past, n) => {
        if (base.length === 0) return fallback(n);
        const { hits: record } = cache.record(past, n);
        const choices = cache.choicesAt(past, n);
        return topVoted(
          // The leader's own order, as positional votes, so n = 1 plays its first ball.
          choices[leaderIndex(base, record)]!.reduce((v, b, i) => {
            if (Number.isInteger(b) && b >= 1 && b <= SUPER_POOL) v[b - 1] = Math.max(v[b - 1]!, n - i);
            return v;
          }, new Array<number>(SUPER_POOL).fill(0)),
          n,
        );
      },
    },
    ...betas.map(
      (beta): SuperRule => ({
        // Weights exp(β · hits) with the maximum subtracted: identical ranking,
        // no overflow. With hits in the tens the weights are a near-one-hot on
        // the leader, which is what the formula says and is reported as such.
        name: `meta: Bayesian average of rules (β = ${beta})`,
        choose: (past, n) => {
          if (base.length === 0) return fallback(n);
          const { hits: record } = cache.record(past, n);
          const top = Math.max(...record);
          const weights = record.map((h) => Math.exp(beta * (h - top)));
          const votes = new Array<number>(SUPER_POOL).fill(0);
          castVotes(cache.choicesAt(past, n), weights, n, votes, true);
          return topVoted(votes, n);
        },
      }),
    ),
    {
      // The worst rules weighted highest, exp(−(hits − min)), and the leader's
      // balls struck out: the bettor who thinks the hot system is due to cool.
      name: "meta: contrarian to the leader",
      choose: (past, n) => {
        if (base.length === 0) return fallback(n);
        const { hits: record } = cache.record(past, n);
        const choices = cache.choicesAt(past, n);
        const low = Math.min(...record);
        const weights = record.map((h) => Math.exp(-(h - low)));
        const votes = new Array<number>(SUPER_POOL).fill(0);
        castVotes(choices, weights, n, votes, true);
        const leader = new Set(choices[leaderIndex(base, record)]!.slice(0, n));
        return topVoted(votes, n, leader);
      },
    },
  ];

  // Recency ensemble: positional (Borda) votes from persist, repeat, hot-100
  // and cold, each weighted by its own nested hit rate relative to chance
  // (1 before any record exists). Only entered when at least two are present.
  const recency = RECENCY_PATTERNS.map((re) => base.findIndex((r) => re.test(r.name))).filter((i) => i >= 0);
  if (recency.length >= 2) {
    rules.push({
      name: "meta: recency ensemble (persist + repeat + hot-100 + cold)",
      choose: (past, n) => {
        const { hits: record, trials } = cache.record(past, n);
        const choices = cache.choicesAt(past, n);
        const chance = (trials * Math.min(n, SUPER_POOL)) / SUPER_POOL;
        const weights = base.map((_, r) =>
          recency.includes(r) ? (trials > 0 && chance > 0 ? record[r]! / chance : 1) : 0,
        );
        const votes = new Array<number>(SUPER_POOL).fill(0);
        castVotes(choices, weights, n, votes, true);
        return topVoted(votes, n);
      },
    });
  }

  return rules;
}
