import { expect, test, describe } from "bun:test";
import { planSuperCoverage, scoreSuperRules, superPosterior } from "../src/baloto/superball.ts";
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

  test("ranks by posterior mean when a ball is genuinely distinguishable", () => {
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const plan = planSuperCoverage(rigged, 1);
    expect(plan.balls[0]).toBe(4);
    expect(plan.rule).toBe("posterior");
  });

  test("a loaded ball outranks an unplayed one — the objective comes first", () => {
    // Ball 4 is loaded *and* the most played. Hitting it is likelier, so the
    // crowd tiebreak must not be allowed to overrule that.
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const crowdLovesFour = Array.from({ length: SUPER_POOL }, (_, i) => (i === 3 ? 0.4 : 0.04));
    const plan = planSuperCoverage(rigged, 1, { superWeights: crowdLovesFour });
    expect(plan.balls[0]).toBe(4);
    expect(plan.rule).toBe("posterior");
  });

  test("with nothing distinguishable, prefers the balls fewest people play", () => {
    const crowd = Array.from({ length: SUPER_POOL }, (_, i) => (i + 1) / 136);
    const plan = planSuperCoverage(draws, 3, { superWeights: crowd });
    expect(plan.rule).toBe("least-played");
    expect(plan.balls).toEqual([1, 2, 3]);
    expect(plan.crowding).toBeLessThan(1);
    // and it costs nothing on the stated objective
    expect(plan.hitProbability).toBeCloseTo(3 / SUPER_POOL, 12);
  });

  test("says so when it had no basis for the order at all", () => {
    expect(planSuperCoverage(draws, 3).rule).toBe("arbitrary");
    expect(planSuperCoverage(draws, 3).crowding).toBe(1);
  });

  test("still accepts a bare prior strength, as it used to", () => {
    expect(planSuperCoverage(draws, 3, 500).hitProbability).toBeCloseTo(3 / SUPER_POOL, 12);
  });

  test("reports how flat the posterior is", () => {
    // On a fair machine the best-to-worst spread stays small.
    expect(planSuperCoverage(draws, 3).spreadPoints).toBeLessThan(5);
    expect(planSuperCoverage(draws, 3).distinguishable).toHaveLength(0);
  });
});

describe("scoreSuperRules", () => {
  const draws = history(900, 5);
  const rules = [
    { name: "fixed", choose: (_: Draw[], n: number) => [1, 2, 3].slice(0, n) },
    { name: "hottest", choose: (past: Draw[], n: number) =>
        superPosterior(past).sort((a, b) => b.mean - a.mean).slice(0, n).map((p) => p.ball) },
    { name: "coldest", choose: (past: Draw[], n: number) =>
        superPosterior(past).sort((a, b) => a.mean - b.mean).slice(0, n).map((p) => p.ball) },
  ];

  test("no rule beats chance on a fair machine", () => {
    const scores = scoreSuperRules(draws, rules, 3, 400);
    expect(scores.every((s) => !s.beatsChance)).toBe(true);
    for (const s of scores) expect(s.rate).toBeCloseTo(3 / SUPER_POOL, 1);
  });

  test("scores every rule over the same draws", () => {
    const scores = scoreSuperRules(draws, rules, 3, 400);
    expect(scores).toHaveLength(rules.length);
    expect(new Set(scores.map((s) => s.draws)).size).toBe(1);
    expect(scores[0]!.draws).toBe(500);
  });

  test("catches a rule that really does know something", () => {
    // Ball 4 in a third of draws, and a rule that plays it.
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const [cheat] = scoreSuperRules(rigged, [
      { name: "plays 4", choose: () => [4] },
    ], 1, 300);
    expect(cheat!.beatsChance).toBe(true);
    expect(cheat!.rate).toBeGreaterThan(0.25);
  });

  test("the multiple-comparison threshold widens with the field", () => {
    // The same rule, entered once against entered twenty times.
    const one = { name: "fixed", choose: (_: Draw[], n: number) => [1, 2, 3].slice(0, n) };
    const alone = scoreSuperRules(draws, [one], 3, 400)[0]!;
    const crowded = scoreSuperRules(draws, Array.from({ length: 20 }, (_, i) => ({
      ...one, name: `fixed-${i}`,
    })), 3, 400)[0]!;
    expect(crowded.z).toBeCloseTo(alone.z, 10);
    expect(crowded.beatsChance || !alone.beatsChance).toBe(true);
  });
});
