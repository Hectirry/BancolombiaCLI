/**
 * Coverage: how much of the sample space N tickets span, exactly, and the
 * arrangement of main numbers that spans the most.
 *
 * This is the main-number half of the hit objective stated in CLAUDE.md. A
 * ticket wins something when its Súper Balota matches (any number of main
 * matches) or when it matches at least three of the five main numbers. Over N
 * tickets, "win anything" is therefore the union of two events on two
 * independent machines:
 *
 *   A = some ticket carries the drawn Súper Balota   (super machine only)
 *   B = some ticket has ≥ 3 main matches             (main machine only)
 *
 *   P(win anything) = 1 − (1 − P(A)) · (1 − P(B))
 *
 * P(A) is exactly d/16 where d is the number of *distinct* Súper Balotas on
 * the tickets, so d = min(N, 16) is optimal and P(A) = 1 from sixteen tickets
 * on. P(B) is |∪ Tᵢ| / C(43,5) where Tᵢ is the set of 7 221 draws on which
 * ticket i has ≥ 3 matches. The union bound |∪ Tᵢ| ≤ 7 221·N is attained
 * exactly when the Tᵢ are pairwise disjoint, and Tᵢ ∩ Tⱼ ≠ ∅ iff the two
 * tickets share a number (a 5-ball draw cannot hold three balls of each of two
 * disjoint tickets). Hence:
 *
 *   N ≤ 8 : disjoint tickets exist (5·8 = 40 ≤ 43) and are the exact optimum.
 *   N ≥ 9 : 5N > 43 forces shared numbers, the bound is strict, and the
 *           question becomes how little the Tᵢ can overlap.
 *
 * Two tickets sharing exactly one number x have |Tᵢ ∩ Tⱼ| = 36: the draw must
 * contain x plus two of the other four of each (6·6). Sharing two numbers costs
 * 351 — far more than the 72 of two separate single overlaps. So the good
 * designs are *linear* (any two tickets share at most one number), and in a
 * linear design no draw can hit three tickets (3·3 − 3 > 5 balls), so
 * inclusion–exclusion stops at pairs and
 *
 *   |∪ Tᵢ| = 7 221·N − 36 · Σₓ C(dₓ, 2)
 *
 * with dₓ the number of tickets containing x. Σₓ C(dₓ,2) is convex in the
 * degrees, so balanced degrees (every dₓ ∈ {q, q+1}, q = ⌊5N/43⌋) give the
 * best linear design, `linearBound`. For N = 9 that is also the global
 * optimum (two shared numbers are unavoidable; one pair sharing both costs
 * 351, two pairs sharing one each cost 72). For 10 ≤ N ≤ 20 the search below
 * reaches the linear bound every time; that it is the global optimum is
 * conjectured, not proved — the status field says which.
 *
 * Nothing here is a payout criterion: coverage counts outcomes, never pesos.
 */

import { makeRng, randInt } from "./random.ts";
import { MAIN_COMBINATIONS, MAIN_PICK, MAIN_POOL, SUPER_POOL, choose, type Combination } from "./rules.ts";

/** Draws (out of 962 598) on which one ticket has at least three matches: 7 221. */
export const WINNING_DRAWS_PER_TICKET = (() => {
  let ways = 0;
  for (let k = 3; k <= MAIN_PICK; k++) ways += choose(MAIN_PICK, k) * choose(MAIN_POOL - MAIN_PICK, MAIN_PICK - k);
  return ways;
})();

/** Draws hitting two tickets that share exactly one number: 1 · C(4,2) · C(4,2). */
export const PAIR_OVERLAP_ONE_SHARED_DRAWS = 36;

const LO_BITS = 22;

/** Bit masks of a set of numbers in 1..43, split in two 32-bit words. */
function masks(numbers: number[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const n of numbers) {
    const bit = n - 1;
    if (bit < LO_BITS) lo |= 1 << bit;
    else hi |= 1 << (bit - LO_BITS);
  }
  return [lo >>> 0, hi >>> 0];
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function validateMain(main: number[]): void {
  if (main.length !== MAIN_PICK) throw new Error(`A ticket needs ${MAIN_PICK} main numbers, got ${main.length}.`);
  const seen = new Set<number>();
  for (const n of main) {
    if (!Number.isInteger(n) || n < 1 || n > MAIN_POOL) throw new Error(`Main number out of range: ${n}.`);
    if (seen.has(n)) throw new Error(`Repeated main number: ${n}.`);
    seen.add(n);
  }
}

/**
 * Exact count of the 5-subsets of 1..43 on which at least one of the tickets
 * matches three or more numbers — the size of ∪ Tᵢ. Lexicographic walk over
 * all C(43,5) = 962 598 draws, each tested against every ticket with two
 * popcounts. Under a second for twenty tickets.
 */
export function countWinningDraws(mains: number[][]): number {
  if (mains.length === 0) return 0;
  for (const m of mains) validateMain(m);
  const n = mains.length;
  const tlo = new Int32Array(n);
  const thi = new Int32Array(n);
  mains.forEach((m, i) => {
    const [lo, hi] = masks(m);
    tlo[i] = lo;
    thi[i] = hi;
  });
  const loBit = new Int32Array(MAIN_POOL);
  const hiBit = new Int32Array(MAIN_POOL);
  for (let b = 0; b < MAIN_POOL; b++) {
    if (b < LO_BITS) loBit[b] = 1 << b;
    else hiBit[b] = 1 << (b - LO_BITS);
  }
  let count = 0;
  const last = MAIN_POOL - 1;
  for (let a = 0; a <= last - 4; a++) {
    const la = loBit[a]!;
    const ha = hiBit[a]!;
    for (let b = a + 1; b <= last - 3; b++) {
      const lb = la | loBit[b]!;
      const hb = ha | hiBit[b]!;
      for (let c = b + 1; c <= last - 2; c++) {
        const lc = lb | loBit[c]!;
        const hc = hb | hiBit[c]!;
        for (let d = c + 1; d <= last - 1; d++) {
          const ld = lc | loBit[d]!;
          const hd = hc | hiBit[d]!;
          for (let e = d + 1; e <= last; e++) {
            const le = ld | loBit[e]!;
            const he = hd | hiBit[e]!;
            for (let i = 0; i < n; i++) {
              if (popcount(le & tlo[i]!) + popcount(he & thi[i]!) >= 3) {
                count++;
                break;
              }
            }
          }
        }
      }
    }
  }
  return count;
}

/** Exact probability that at least one ticket matches ≥ 3 main numbers. */
export function mainHitExact(mains: number[][]): number {
  return countWinningDraws(mains) / MAIN_COMBINATIONS;
}

/** Number of distinct Súper Balotas carried, i.e. 16 · P(some ticket matches it). */
export function distinctSupers(tickets: Pick<Combination, "super">[]): number {
  const seen = new Set<number>();
  for (const t of tickets) {
    if (!Number.isInteger(t.super) || t.super < 1 || t.super > SUPER_POOL) {
      throw new Error(`Súper Balota out of range: ${t.super}.`);
    }
    seen.add(t.super);
  }
  return seen.size;
}

/**
 * Exact probability that at least one of the given tickets wins anything,
 * on a fair machine. Equivalent to enumerating all 15 401 568 outcomes: the
 * draw wins on 962 598·d outcomes through the Súper Balota plus (16 − d)·|∪Tᵢ|
 * through the main numbers alone, with d the distinct Súper Balotas carried.
 */
export function winAnythingExact(tickets: Combination[]): number {
  if (tickets.length === 0) return 0;
  const d = distinctSupers(tickets);
  const mainP = mainHitExact(tickets.map((t) => t.main));
  return 1 - (1 - d / SUPER_POOL) * (1 - mainP);
}

/** |Tᵢ ∩ Tⱼ| for two tickets sharing exactly `shared` numbers, by enumeration. */
export function pairIntersectionDraws(shared: number): number {
  if (shared < 0 || shared > MAIN_PICK) throw new Error("shared must be in 0..5");
  const a = [1, 2, 3, 4, 5];
  const b = [...a.slice(0, shared), ...Array.from({ length: MAIN_PICK - shared }, (_, i) => 6 + i)];
  // |A ∪ B| = |A| + |B| − |A ∩ B| for the sets of winning draws.
  return 2 * WINNING_DRAWS_PER_TICKET - countWinningDraws([a, b]);
}

/** P(some ticket matches the Súper Balota) with n tickets on distinct balls. */
export function superHitProbability(n: number): number {
  return Math.min(n, SUPER_POOL) / SUPER_POOL;
}

/**
 * Balanced assignment of Súper Balotas to n tickets: ticket i takes
 * `order[i mod 16]`, so every ball appears ⌊n/16⌋ or ⌈n/16⌉ times.
 *
 * Why balanced. P(≥ k tickets match the Súper Balota) = #{balls with
 * multiplicity ≥ k} / 16. Any assignment that covers all sixteen balls has
 * P(≥ 1) = 1 — that is the stated objective and it is reached at n = 16. Among
 * those, the balanced one is lexicographically optimal for every k: with
 * n = 16q + r, all balls have multiplicity ≥ q, and the r units left over can
 * lift at most r balls to q + 1, which is exactly what it does. Below sixteen
 * it is simply "distinct balls", P = n/16.
 */
export function assignSupers(n: number, order?: number[]): number[] {
  const seq = order && order.length >= Math.min(n, SUPER_POOL) ? order : Array.from({ length: SUPER_POOL }, (_, i) => i + 1);
  return Array.from({ length: n }, (_, i) => seq[i % SUPER_POOL]!);
}

/** Union bound on |∪ Tᵢ|: 7 221·n, capped at the whole space. */
export function unionBoundDraws(n: number): number {
  return Math.min(MAIN_COMBINATIONS, n * WINNING_DRAWS_PER_TICKET);
}

/** Degrees of a balanced design: how many numbers appear in q+1 and q tickets. */
export function balancedDegrees(n: number): { q: number; high: number } {
  const slots = n * MAIN_PICK;
  const q = Math.floor(slots / MAIN_POOL);
  return { q, high: slots - q * MAIN_POOL };
}

/**
 * Largest |∪ Tᵢ| any *linear* design (two tickets share ≤ 1 number) can reach:
 * 7 221·n − 36·Σₓ C(dₓ,2) with balanced degrees. Equal to the union bound for
 * n ≤ 8, the proven optimum for n = 9, and the target of the search beyond.
 */
export function linearBoundDraws(n: number): number {
  const { q, high } = balancedDegrees(n);
  const pairs = high * choose(q + 1, 2) + (MAIN_POOL - high) * choose(q, 2);
  return Math.max(0, n * WINNING_DRAWS_PER_TICKET - PAIR_OVERLAP_ONE_SHARED_DRAWS * pairs);
}

// ---------------------------------------------------------------------------
// Incremental coverage state: ranks of the 7 221 winning draws of each ticket
// in the combinatorial number system, counted in a multiplicity table over all
// 962 598 draws. Replacing one ticket costs 2 × 7 221 updates, which is what
// makes a seeded local search over thousands of moves take seconds.

const BINOM: number[][] = Array.from({ length: MAIN_POOL + 1 }, (_, n) =>
  Array.from({ length: MAIN_PICK + 1 }, (_, k) => choose(n, k)),
);

/** Rank of a sorted 5-subset of 0..42 in 0..962 597. */
function rankOf(s: number[]): number {
  return BINOM[s[0]!]![1]! + BINOM[s[1]!]![2]! + BINOM[s[2]!]![3]! + BINOM[s[3]!]![4]! + BINOM[s[4]!]![5]!;
}

/** Fill `out` with the ranks of every draw on which `main` (1-based) has ≥ 3 matches. */
function winningRanks(main: number[], out: Int32Array): void {
  const t = main.map((n) => n - 1).sort((a, b) => a - b);
  const inTicket = new Uint8Array(MAIN_POOL);
  for (const x of t) inTicket[x] = 1;
  const others: number[] = [];
  for (let x = 0; x < MAIN_POOL; x++) if (!inTicket[x]) others.push(x);
  const draw = [0, 0, 0, 0, 0];
  let w = 0;
  const emit = () => {
    draw.sort((a, b) => a - b);
    out[w++] = rankOf(draw);
  };
  // Five of five.
  for (let i = 0; i < 5; i++) draw[i] = t[i]!;
  emit();
  // Four of five plus one outsider.
  for (let skip = 0; skip < 5; skip++) {
    for (const o of others) {
      let p = 0;
      for (let i = 0; i < 5; i++) if (i !== skip) draw[p++] = t[i]!;
      draw[4] = o;
      emit();
    }
  }
  // Three of five plus two outsiders.
  for (let s1 = 0; s1 < 4; s1++) {
    for (let s2 = s1 + 1; s2 < 5; s2++) {
      for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++) {
          let p = 0;
          for (let k = 0; k < 5; k++) if (k !== s1 && k !== s2) draw[p++] = t[k]!;
          draw[3] = others[i]!;
          draw[4] = others[j]!;
          emit();
        }
      }
    }
  }
}

class CoverageState {
  private readonly multiplicity = new Uint8Array(MAIN_COMBINATIONS);
  private readonly ranks: Int32Array[] = [];
  covered = 0;

  constructor(public readonly mains: number[][]) {
    for (const m of mains) {
      const r = new Int32Array(WINNING_DRAWS_PER_TICKET);
      winningRanks(m, r);
      this.ranks.push(r);
      this.add(r);
    }
  }

  private add(r: Int32Array): void {
    const mult = this.multiplicity;
    for (let i = 0; i < r.length; i++) {
      const k = r[i]!;
      if (mult[k]! === 0) this.covered++;
      mult[k]!++;
    }
  }

  private remove(r: Int32Array): void {
    const mult = this.multiplicity;
    for (let i = 0; i < r.length; i++) {
      const k = r[i]!;
      mult[k]!--;
      if (mult[k]! === 0) this.covered--;
    }
  }

  /** Replace ticket i; returns the new covered count. */
  replace(i: number, main: number[]): number {
    const old = this.ranks[i]!;
    this.remove(old);
    const r = new Int32Array(WINNING_DRAWS_PER_TICKET);
    winningRanks(main, r);
    this.ranks[i] = r;
    this.mains[i] = main;
    this.add(r);
    return this.covered;
  }
}

/** Exact |∪ Tᵢ| through the rank table — same number as `countWinningDraws`. */
export function countWinningDrawsByRanks(mains: number[][]): number {
  for (const m of mains) validateMain(m);
  return new CoverageState(mains.map((m) => [...m])).covered;
}

// ---------------------------------------------------------------------------
// Constructions and search.

function shuffled(rng: () => number, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** n ≤ 8: a random partition of the 43 numbers into n disjoint tickets. */
function disjointTickets(n: number, rng: () => number): number[][] {
  const pool = shuffled(rng, MAIN_POOL);
  return Array.from({ length: n }, (_, i) => pool.slice(i * MAIN_PICK, (i + 1) * MAIN_PICK).sort((a, b) => a - b));
}

/**
 * Greedy linear design with balanced degrees: numbers carry a capacity of q or
 * q+1 tickets; each ticket takes five numbers of highest remaining capacity
 * that do not make it share a second number with an earlier ticket. Random
 * tie-breaks and restarts; null if no attempt closes.
 */
function greedyLinearDesign(n: number, rng: () => number, attempts = 200): number[][] | null {
  const { q, high } = balancedDegrees(n);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const order = shuffled(rng, MAIN_POOL);
    const capacity = new Int32Array(MAIN_POOL + 1);
    order.forEach((x, i) => (capacity[x] = i < high ? q + 1 : q));
    const holders: number[][] = Array.from({ length: MAIN_POOL + 1 }, () => []);
    const tickets: number[][] = [];
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const ticket: number[] = [];
      const touched = new Set<number>(); // earlier tickets this one already shares with
      for (let p = 0; p < MAIN_PICK; p++) {
        let best: number[] = [];
        let bestCap = 0;
        for (let x = 1; x <= MAIN_POOL; x++) {
          const cap = capacity[x]!;
          if (cap <= 0 || ticket.includes(x)) continue;
          if (holders[x]!.some((j) => touched.has(j))) continue;
          if (cap > bestCap) {
            bestCap = cap;
            best = [x];
          } else if (cap === bestCap) best.push(x);
        }
        if (best.length === 0) {
          ok = false;
          break;
        }
        const x = best[randInt(rng, best.length)]!;
        ticket.push(x);
        capacity[x]!--;
        for (const j of holders[x]!) touched.add(j);
        holders[x]!.push(i);
      }
      if (ok) tickets.push(ticket.sort((a, b) => a - b));
    }
    if (ok) return tickets;
  }
  return null;
}

/** Random tickets, any overlap — the fallback start when the greedy fails. */
function randomTickets(n: number, rng: () => number): number[][] {
  return Array.from({ length: n }, () => shuffled(rng, MAIN_POOL).slice(0, MAIN_PICK).sort((a, b) => a - b));
}

export interface OverlapProfile {
  /** Largest number of main numbers two tickets share. */
  maxOverlap: number;
  /** Pairs of tickets sharing at least one main number. */
  overlappingPairs: number;
}

export function overlapProfile(mains: number[][]): OverlapProfile {
  let maxOverlap = 0;
  let overlappingPairs = 0;
  for (let i = 0; i < mains.length; i++) {
    const a = new Set(mains[i]!);
    for (let j = i + 1; j < mains.length; j++) {
      let s = 0;
      for (const x of mains[j]!) if (a.has(x)) s++;
      if (s > 0) overlappingPairs++;
      if (s > maxOverlap) maxOverlap = s;
    }
  }
  return { maxOverlap, overlappingPairs };
}

export type CoverageStatus =
  /** Reaches a bound no arrangement can beat (union bound, or the n = 9 argument). */
  | "optimal"
  /** Reaches the exact optimum among linear designs; global optimum conjectured. */
  | "linear-optimal"
  /** The best the seeded search found; below the linear bound. */
  | "best-found";

export interface CoveragePlan {
  tickets: Combination[];
  /** |∪ Tᵢ|: draws out of 962 598 on which some ticket has ≥ 3 main matches. */
  winningDraws: number;
  /** winningDraws / 962 598. */
  mainHitProbability: number;
  /** min(n,16)/16 — the Súper Balota half of the objective. */
  superHitProbability: number;
  /** Exact P(win anything) for exactly these tickets. */
  winAnythingProbability: number;
  /** Union bound on the main half, n·7 221/962 598, capped at one. */
  mainUnionBound: number;
  /** Union bound on P(win anything): what n·7 221/962 598 would give if it held. */
  winAnythingUnionBound: number;
  /** Best any linear design can do, as a probability. */
  linearBound: number;
  overlap: OverlapProfile;
  status: CoverageStatus;
  /** Local-search moves actually evaluated. */
  iterations: number;
}

export interface CoverageOptions {
  /** Cap on local-search moves once the construction is in place. */
  iterations?: number;
  /** Order in which Súper Balotas are assigned (e.g. the posterior ranking). */
  superOrder?: number[];
  /**
   * Where the search starts: the greedy linear design (default), or random
   * tickets of any overlap — which is how the search itself is tested, since
   * the greedy construction already reaches the linear bound for n ≤ 20.
   */
  start?: "greedy" | "random";
  /**
   * Keep searching after the linear bound is reached, so a run can look for
   * a non-linear arrangement that beats it. None has been found; the default
   * stops at the bound.
   */
  exhaustive?: boolean;
}

function statusFor(n: number, draws: number): CoverageStatus {
  if (draws >= unionBoundDraws(n)) return "optimal";
  const linear = linearBoundDraws(n);
  if (draws >= linear) return n === 9 ? "optimal" : "linear-optimal";
  return "best-found";
}

/**
 * The best arrangement of n tickets for winning anything on a fair machine:
 * balanced distinct Súper Balotas, and main numbers that are disjoint (n ≤ 8,
 * proven optimal) or form a minimal-overlap linear design (n ≥ 9), polished by
 * a seeded simulated-annealing search on the exact coverage count. The search
 * stops as soon as the linear bound is reached, since nothing linear beats it.
 */
export function optimiseCoverage(n: number, seed = 1, options: CoverageOptions = {}): CoveragePlan {
  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer.");
  const rng = makeRng(seed);
  const maxIterations = options.iterations ?? 4000;
  let iterations = 0;

  let mains: number[][];
  if (options.start === "random") {
    mains = randomTickets(n, rng);
  } else if (n <= Math.floor(MAIN_POOL / MAIN_PICK)) {
    mains = disjointTickets(n, rng);
  } else {
    mains = greedyLinearDesign(n, rng) ?? randomTickets(n, rng);
  }

  const state = new CoverageState(mains.map((m) => [...m]));
  const target = options.exhaustive ? Number.POSITIVE_INFINITY : linearBoundDraws(n);
  let best = state.covered;
  let bestMains = state.mains.map((m) => [...m]);

  if (best < target && maxIterations > 0) {
    const t0 = 30;
    const t1 = 0.3;
    for (let it = 0; it < maxIterations && best < target; it++) {
      iterations++;
      const temperature = t0 * Math.pow(t1 / t0, it / maxIterations);
      const i = randInt(rng, n);
      const current = state.mains[i]!;
      const p = randInt(rng, MAIN_PICK);
      let x = 1 + randInt(rng, MAIN_POOL);
      while (current.includes(x)) x = 1 + randInt(rng, MAIN_POOL);
      const candidate = [...current];
      candidate[p] = x;
      candidate.sort((a, b) => a - b);
      const before = state.covered;
      const after = state.replace(i, candidate);
      const delta = after - before;
      if (delta >= 0 || rng() < Math.exp(delta / temperature)) {
        if (after > best) {
          best = after;
          bestMains = state.mains.map((m) => [...m]);
        }
      } else {
        state.replace(i, current);
      }
    }
  }

  const supers = assignSupers(n, options.superOrder);
  const tickets: Combination[] = bestMains.map((main, i) => ({ main: [...main].sort((a, b) => a - b), super: supers[i]! }));
  const mainP = best / MAIN_COMBINATIONS;
  const superP = superHitProbability(n);
  const mainUnion = unionBoundDraws(n) / MAIN_COMBINATIONS;
  return {
    tickets,
    winningDraws: best,
    mainHitProbability: mainP,
    superHitProbability: superP,
    winAnythingProbability: 1 - (1 - superP) * (1 - mainP),
    mainUnionBound: mainUnion,
    winAnythingUnionBound: 1 - (1 - superP) * (1 - mainUnion),
    linearBound: target / MAIN_COMBINATIONS,
    overlap: overlapProfile(bestMains),
    status: statusFor(n, best),
    iterations,
  };
}
