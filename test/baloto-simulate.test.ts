import { expect, test, describe } from "bun:test";
import { pairNights, replayBallRules, simulateSeasons, standardBallRules } from "../src/baloto/simulate.ts";
import { nightCoverage } from "../src/baloto/superball.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function fairNights(count: number, seed: number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const draws: Draw[] = [];
  for (let i = 0; i < count; i++) {
    const date = `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
    for (const game of ["baloto", "revancha"] as const) {
      draws.push({ date, game, main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer), super: 1 + randInt(rng, SUPER_POOL) });
    }
  }
  return draws;
}

describe("simulateSeasons", () => {
  test("the simulated hit rate agrees with the exact one, with and without Revancha", () => {
    for (const plan of [
      { tickets: 2, revancha: true },
      { tickets: 3, revancha: false },
      { tickets: 8, revancha: true },
    ]) {
      const r = simulateSeasons({ ...plan, seasons: 2000, nights: 60, seed: 3 });
      const exact = nightCoverage(plan.tickets, plan.revancha);
      expect(r.exactHit).toBeCloseTo(exact.superHit, 12);
      const sd = Math.sqrt((exact.superHit * (1 - exact.superHit)) / (2000 * 60));
      expect(Math.abs(r.simulatedHit - exact.superHit)).toBeLessThan(4 * sd);
      expect(Math.abs(r.simulatedWin - exact.winAnything)).toBeLessThan(0.01);
      expect(r.costPerHit).toBeCloseTo(exact.cost / exact.superHit, 6);
    }
  });

  test("more coverage means an earlier first hit and shorter droughts", () => {
    const two = simulateSeasons({ tickets: 2, revancha: true, seasons: 3000, nights: 100, seed: 5 });
    const four = simulateSeasons({ tickets: 4, revancha: true, seasons: 3000, nights: 100, seed: 5 });
    expect(four.firstHitMedian).toBeLessThanOrEqual(two.firstHitMedian);
    expect(four.longestDroughtMedian).toBeLessThan(two.longestDroughtMedian);
    expect(four.seasonsWithDrought).toBeLessThan(two.seasonsWithDrought);
    expect(four.hitWithinWindow).toBeGreaterThan(two.hitWithinWindow);
  });

  test("sixteen distinct balls hit every night", () => {
    const r = simulateSeasons({ tickets: 16, revancha: false, seasons: 50, nights: 30, seed: 1 });
    expect(r.simulatedHit).toBe(1);
    expect(r.longestDroughtP90).toBe(0);
    expect(r.firstHitMedian).toBe(1);
  });

  test("the same seed reproduces the same summary", () => {
    const a = simulateSeasons({ tickets: 3, revancha: false, seasons: 500, nights: 50, seed: 11 });
    const b = simulateSeasons({ tickets: 3, revancha: false, seasons: 500, nights: 50, seed: 11 });
    expect(a).toEqual(b);
  });
});

describe("replayBallRules", () => {
  const draws = fairNights(600, 9);

  test("pairs only dates that have both draws, in order", () => {
    const nights = pairNights([...draws, { date: "2027-01-01", game: "baloto", main: [1, 2, 3, 4, 5], super: 1 }]);
    expect(nights).toHaveLength(600);
    expect(nights[0]!.date < nights[599]!.date).toBe(true);
  });

  test("every rule plays distinct legal balls and sees only the past", () => {
    const nights = pairNights(draws);
    const baloto = draws.filter((d) => d.game === "baloto");
    for (const rule of standardBallRules()) {
      for (const n of [2, 3, 5]) {
        const balls = rule.choose(baloto.slice(0, 300), n, 300);
        expect(balls).toHaveLength(n);
        expect(new Set(balls).size).toBe(n);
        for (const b of balls) expect(b >= 1 && b <= SUPER_POOL).toBe(true);
      }
    }
    // "repeat the last drawn" with the last two Baloto balls before night 300
    const repeat = standardBallRules().find((r) => r.id === "repeat-last")!;
    const before = baloto.filter((d) => d.date < nights[300]!.date);
    const last = before[before.length - 1]!.super;
    expect(repeat.choose(before, 2, 300)[0]).toBe(last);
  });

  test("on a fair machine every rule sits inside the noise band, with and without Revancha", () => {
    for (const revancha of [true, false]) {
      const rows = replayBallRules(draws, { tickets: 2, revancha });
      expect(rows).toHaveLength(standardBallRules().length);
      for (const r of rows) {
        expect(r.nights).toBe(600);
        expect(r.expected).toBeCloseTo(600 * nightCoverage(2, revancha).superHit, 9);
        expect(Math.abs(r.z)).toBeLessThan(4);
        expect(r.next).toHaveLength(2);
      }
    }
  });

  test("a window replays only the last nights, and counts hits exactly", () => {
    const rows = replayBallRules(draws, { tickets: 2, revancha: true, window: 50 });
    const nights = pairNights(draws).slice(-50);
    const fixed = rows.find((r) => r.id === "fixed-11-13-7")!;
    const byHand = nights.filter((n) => [11, 13].includes(n.baloto.super) || [11, 13].includes(n.revancha.super)).length;
    expect(fixed.nights).toBe(50);
    expect(fixed.hits).toBe(byHand);
    expect(fixed.next).toEqual([11, 13]);
  });
});
