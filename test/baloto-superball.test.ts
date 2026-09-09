import { expect, test, describe } from "bun:test";
import { planSuperCoverage, superPosterior } from "../src/baloto/superball.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function history(count: number, seed: number, rigSuper?: (i: number) => number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: rigSuper ? rigSuper(i) : 1 + randInt(rng, SUPER_POOL),
  }));
}

describe("superPosterior", () => {
  const post = superPosterior(history(900, 5));

  test("covers all sixteen balls and sums to one", () => {
    expect(post).toHaveLength(SUPER_POOL);
    expect(post.reduce((a, p) => a + p.mean, 0)).toBeCloseTo(1, 10);
  });

  test("finds no distinguishable ball in a fair machine", () => {
    expect(post.every((p) => !p.distinguishable)).toBe(true);
  });

  test("a stronger prior shrinks every estimate towards 1/16", () => {
    const weak = superPosterior(history(900, 5), 1);
    const strong = superPosterior(history(900, 5), 500);
    const spread = (rows: { mean: number }[]) =>
      Math.max(...rows.map((r) => r.mean)) - Math.min(...rows.map((r) => r.mean));
    expect(spread(strong)).toBeLessThan(spread(weak));
  });

  test("detects a genuinely loaded ball", () => {
    // Ball 4 comes up in a third of draws: a bias this size must be caught.
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const loaded = superPosterior(rigged).find((p) => p.ball === 4)!;
    expect(loaded.distinguishable).toBe(true);
    expect(loaded.low).toBeGreaterThan(1 / SUPER_POOL);
  });
});

describe("planSuperCoverage", () => {
  const draws = history(900, 5);

  test("hit probability is exactly tickets/16", () => {
    for (const n of [1, 2, 3, 5, 16]) {
      expect(planSuperCoverage(draws, n).hitProbability).toBeCloseTo(n / SUPER_POOL, 12);
    }
  });

  test("never repeats a ball — a duplicate would waste a ticket", () => {
    const plan = planSuperCoverage(draws, 6);
    expect(new Set(plan.balls).size).toBe(6);
  });

  test("cannot promise more than certainty", () => {
    const plan = planSuperCoverage(draws, 40);
    expect(plan.balls).toHaveLength(SUPER_POOL);
    expect(plan.hitProbability).toBe(1);
  });

  test("ranks by posterior mean, so a loaded ball is picked first", () => {
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    expect(planSuperCoverage(rigged, 1).balls[0]).toBe(4);
  });

  test("reports how flat the posterior is", () => {
    // On a fair machine the best-to-worst spread stays small.
    expect(planSuperCoverage(draws, 3).spreadPoints).toBeLessThan(5);
    expect(planSuperCoverage(draws, 3).distinguishable).toHaveLength(0);
  });
});
