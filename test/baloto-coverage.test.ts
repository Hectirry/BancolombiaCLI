import { expect, test, describe } from "bun:test";
import {
  WINNING_DRAWS_PER_TICKET,
  assignSupers,
  countWinningDraws,
  countWinningDrawsByRanks,
  linearBoundDraws,
  mainHitExact,
  optimiseCoverage,
  overlapProfile,
  pairIntersectionDraws,
  superHitProbability,
  unionBoundDraws,
  winAnythingExact,
} from "../src/baloto/coverage.ts";
import { winAnythingBudget, winAnythingProbability, winAnythingUpperBound } from "../src/baloto/superball.ts";
import { MAIN_COMBINATIONS, MAIN_PICK, MAIN_POOL, SUPER_POOL, TOTAL_COMBINATIONS } from "../src/baloto/rules.ts";
import { makeRng, sampleDistinct } from "../src/baloto/random.ts";

const disjoint = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => Array.from({ length: MAIN_PICK }, (_, j) => i * MAIN_PICK + j + 1));

describe("exact enumeration of winning draws", () => {
  test("one ticket wins on exactly 7 221 of the 962 598 draws", () => {
    expect(WINNING_DRAWS_PER_TICKET).toBe(7_221);
    expect(countWinningDraws([[1, 2, 3, 4, 5]])).toBe(7_221);
    expect(mainHitExact([[3, 17, 22, 38, 43]])).toBeCloseTo(7_221 / 962_598, 15);
  });

  test("three disjoint tickets with distinct Súper Balotas: 3 169 413 / 15 401 568", () => {
    const tickets = disjoint(3).map((main, i) => ({ main, super: i + 1 }));
    expect(countWinningDraws(disjoint(3))).toBe(3 * 7_221);
    expect(winAnythingExact(tickets)).toBeCloseTo(3_169_413 / 15_401_568, 15);
    expect(winAnythingExact(tickets)).toBeCloseTo(winAnythingProbability(3), 15);
    expect(TOTAL_COMBINATIONS).toBe(15_401_568);
  });

  test("the lexicographic scan and the rank table agree on arbitrary overlaps", () => {
    const rng = makeRng(11);
    const buffer = new Int32Array(MAIN_POOL);
    const mains = Array.from({ length: 12 }, () => sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer));
    expect(countWinningDrawsByRanks(mains)).toBe(countWinningDraws(mains));
    expect(countWinningDraws(mains)).toBeLessThan(12 * 7_221);
  });

  test("repeating a Súper Balota wastes it; disjoint main numbers are exclusive", () => {
    const same = disjoint(2).map((main) => ({ main, super: 4 }));
    const distinct = disjoint(2).map((main, i) => ({ main, super: i + 1 }));
    expect(winAnythingExact(same)).toBeLessThan(winAnythingExact(distinct));
    expect(winAnythingExact(distinct)).toBeCloseTo(winAnythingProbability(2), 15);
  });

  test("two tickets sharing one number lose 36 draws, sharing two lose 351", () => {
    expect(pairIntersectionDraws(0)).toBe(0);
    expect(pairIntersectionDraws(1)).toBe(36);
    expect(pairIntersectionDraws(2)).toBe(351);
    expect(pairIntersectionDraws(5)).toBe(7_221);
  });

  test("rejects malformed tickets", () => {
    expect(() => countWinningDraws([[1, 2, 3, 4]])).toThrow();
    expect(() => countWinningDraws([[1, 2, 3, 4, 44]])).toThrow();
    expect(() => countWinningDraws([[1, 1, 3, 4, 5]])).toThrow();
    expect(() => winAnythingExact([{ main: [1, 2, 3, 4, 5], super: 17 }])).toThrow();
  });
});

describe("Súper Balota coverage", () => {
  test("P(SB) is n/16 below sixteen tickets and exactly one from sixteen on", () => {
    expect(superHitProbability(3)).toBeCloseTo(3 / 16, 15);
    for (const n of [16, 17, 20, 40]) expect(superHitProbability(n)).toBe(1);
  });

  test("the balanced assignment covers every ball and never differs by more than one", () => {
    for (const n of [5, 16, 17, 20, 33]) {
      const supers = assignSupers(n);
      const counts = new Map<number, number>();
      for (const s of supers) counts.set(s, (counts.get(s) ?? 0) + 1);
      if (n >= SUPER_POOL) expect(counts.size).toBe(SUPER_POOL);
      else expect(counts.size).toBe(n);
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
  });

  test("a caller's ranking decides which balls come first", () => {
    const order = Array.from({ length: SUPER_POOL }, (_, i) => SUPER_POOL - i);
    expect(assignSupers(3, order)).toEqual([16, 15, 14]);
  });

  test("with sixteen or more tickets P(win anything) is one whatever the main numbers", () => {
    const rng = makeRng(3);
    const buffer = new Int32Array(MAIN_POOL);
    const tickets = assignSupers(18).map((s) => ({ main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer), super: s }));
    expect(winAnythingExact(tickets)).toBe(1);
    for (const n of [16, 17, 20]) expect(optimiseCoverage(n, 1, { iterations: 0 }).winAnythingProbability).toBe(1);
  });
});

describe("optimiseCoverage", () => {
  test("up to eight tickets: disjoint, and exactly on the union bound", () => {
    for (const n of [1, 3, 8]) {
      const plan = optimiseCoverage(n, 5);
      expect(plan.status).toBe("optimal");
      expect(plan.overlap.maxOverlap).toBe(0);
      expect(plan.winningDraws).toBe(unionBoundDraws(n));
      expect(plan.winAnythingProbability).toBeCloseTo(winAnythingProbability(n), 15);
      expect(new Set(plan.tickets.map((t) => t.super)).size).toBe(n);
    }
  });

  test("nine tickets: 64 917 draws, beating every structure that shares two numbers", () => {
    const plan = optimiseCoverage(9, 2);
    expect(plan.winningDraws).toBe(9 * 7_221 - 2 * 36);
    expect(plan.winningDraws).toBe(linearBoundDraws(9));
    expect(plan.status).toBe("optimal");
    expect(plan.overlap.maxOverlap).toBe(1);
    expect(plan.winningDraws).toBeLessThan(unionBoundDraws(9));
    // Eight disjoint tickets plus a ninth sharing two numbers with one of them.
    const overlapTwo = [...disjoint(8), [1, 2, 41, 42, 43]];
    expect(overlapProfile(overlapTwo).maxOverlap).toBe(2);
    expect(countWinningDraws(overlapTwo)).toBe(9 * 7_221 - 351);
    expect(plan.winningDraws).toBeGreaterThan(countWinningDraws(overlapTwo));
    // Random structures with pairwise overlap exactly up to two never do better.
    const rng = makeRng(17);
    const buffer = new Int32Array(MAIN_POOL);
    let tried = 0;
    while (tried < 5) {
      const mains = Array.from({ length: 9 }, () => sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer));
      if (overlapProfile(mains).maxOverlap !== 2) continue;
      tried++;
      expect(countWinningDraws(mains)).toBeLessThanOrEqual(plan.winningDraws);
    }
  });

  test("the plan's own count is the exact enumeration of its tickets", () => {
    for (const n of [9, 13, 20]) {
      const plan = optimiseCoverage(n, 9);
      expect(countWinningDraws(plan.tickets.map((t) => t.main))).toBe(plan.winningDraws);
      expect(plan.mainHitProbability).toBeCloseTo(plan.winningDraws / MAIN_COMBINATIONS, 15);
      expect(plan.winningDraws).toBeLessThan(unionBoundDraws(n));
    }
  });

  test("ten to twenty tickets reach the linear-design bound with overlap at most one", () => {
    for (let n = 10; n <= 20; n++) {
      const plan = optimiseCoverage(n, 1);
      expect(plan.status).toBe("linear-optimal");
      expect(plan.winningDraws).toBe(linearBoundDraws(n));
      expect(plan.overlap.maxOverlap).toBe(1);
      expect(plan.superHitProbability).toBe(Math.min(n, 16) / 16);
    }
  });

  test("the seeded search climbs from random tickets", () => {
    const start = optimiseCoverage(11, 4, { start: "random", iterations: 0 });
    const searched = optimiseCoverage(11, 4, { start: "random", iterations: 1500 });
    expect(searched.iterations).toBeGreaterThan(0);
    expect(searched.winningDraws).toBeGreaterThan(start.winningDraws);
    expect(searched.winningDraws).toBeLessThanOrEqual(linearBoundDraws(11));
  });

  test("the same seed gives the same tickets", () => {
    expect(optimiseCoverage(12, 42).tickets).toEqual(optimiseCoverage(12, 42).tickets);
  });
});

describe("winAnythingBudget", () => {
  test("is exact up to eight tickets and from sixteen, an upper bound in between", () => {
    expect(winAnythingBudget(8).exact).toBe(true);
    expect(winAnythingBudget(9).exact).toBe(false);
    expect(winAnythingBudget(16).exact).toBe(true);
    expect(winAnythingBudget(16).probability).toBe(1);
  });

  test("the bound is strictly above the best arrangement for nine to fifteen tickets", () => {
    for (const n of [9, 12, 15]) {
      const plan = optimiseCoverage(n, 1);
      // The union bound is unattainable past eight tickets; the budget figure
      // is now the exact value of an achievable arrangement, so compare each
      // against what it is.
      expect(plan.winAnythingProbability).toBeLessThan(winAnythingUpperBound(n));
      expect(plan.winAnythingUnionBound).toBeCloseTo(winAnythingUpperBound(n), 15);
      expect(winAnythingBudget(n).exact).toBe(false);
      expect(winAnythingBudget(n).probability).toBeLessThanOrEqual(plan.winAnythingProbability + 1e-12);
    }
  });
});
