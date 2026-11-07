import { expect, test, describe } from "bun:test";
import {
  binomialTails,
  currentMissRun,
  longestMissRun,
  postmortem,
  replayRules,
  simulateMax,
} from "../src/baloto/postmortem.ts";
import { standardSuperRules, type SuperRule } from "../src/baloto/superball.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function history(count: number, seed: number, rigSuper?: (i: number, rng: () => number) => number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: rigSuper ? rigSuper(i, rng) : 1 + randInt(rng, SUPER_POOL),
  }));
}

/** Fourteen fixed rules, each a different triple, overlapping the way real rules do. */
function fourteenFixedRules(): SuperRule[] {
  return Array.from({ length: 14 }, (_, r) => ({
    name: `fixed ${r}`,
    choose: (_: Draw[], n: number) => [1 + ((3 * r) % 16), 1 + ((3 * r + 1) % 16), 1 + ((3 * r + 2) % 16)].slice(0, n),
  }));
}

describe("binomialTails", () => {
  test("two hits in twelve nights at 3/16 is the model's ordinary outcome", () => {
    const { atMost, atLeast } = binomialTails(2, 12, 3 / 16);
    expect(atMost).toBeCloseTo(0.60291, 4);
    expect(atLeast).toBeCloseTo(0.68802, 4);
    // Both tails include the observed value, so they overlap by P(X = 2).
    expect(atMost + atLeast - 1).toBeCloseTo(0.29093, 4);
  });

  test("a drought is a product of per-night misses", () => {
    expect(binomialTails(0, 10, 3 / 16).atMost).toBeCloseTo((13 / 16) ** 10, 12);
    expect(binomialTails(0, 3, 3 / 16).atMost).toBeCloseTo((13 / 16) ** 3, 12);
  });
});

describe("miss runs", () => {
  test("longest and current runs are counted from the hit series", () => {
    const hit = [true, true, false, false, false, false, true, false, false];
    expect(longestMissRun(hit)).toBe(4);
    expect(currentMissRun(hit)).toBe(2);
    expect(currentMissRun([false, false, true])).toBe(0);
    expect(longestMissRun([])).toBe(0);
  });
});

describe("replayRules", () => {
  const draws = history(60, 11);

  test("counts hits night by night with each rule seeing only the past", () => {
    const seen: number[] = [];
    const spy: SuperRule = {
      name: "spy",
      choose: (past, n) => {
        seen.push(past.length);
        return [past.length % 16 === 0 ? 16 : past.length % 16].slice(0, n);
      },
    };
    const [row] = replayRules(draws, [spy], 12, 3);
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => 48 + i));
    expect(row!.played).toHaveLength(12);
    expect(row!.hit).toHaveLength(12);
    expect(row!.hits).toBe(row!.hit.filter(Boolean).length);
    // One ball a night: the expectation is 12/16, whatever the rule names.
    expect(row!.expected).toBeCloseTo(12 / 16, 12);
  });

  test("duplicates and out-of-range balls lower the expectation, as in the tournament", () => {
    const sloppy: SuperRule = { name: "sloppy", choose: () => [4, 4, 99, 0, 7] };
    const [row] = replayRules(draws, [sloppy], 10, 3);
    expect(row!.played.every((p) => p.length === 1)).toBe(true); // slice(0, 3) = [4, 4, 99] → {4}
    expect(row!.expected).toBeCloseTo(10 / 16, 12);
  });

  test("the exact tails are those of the Poisson-binomial over the plays", () => {
    const rules = standardSuperRules(1);
    const rows = replayRules(draws, rules, 12, 3);
    for (const row of rows) {
      expect(row.pAtLeast).toBeGreaterThan(0);
      expect(row.pAtLeast).toBeLessThanOrEqual(1);
      expect(row.pAtMost).toBeGreaterThan(0);
      expect(row.pAtMost).toBeLessThanOrEqual(1);
      // A rule that always plays three distinct balls has the plain binomial tails.
      if (row.played.every((p) => p.length === 3)) {
        const { atLeast, atMost } = binomialTails(row.hits, 12, 3 / 16);
        expect(row.pAtLeast).toBeCloseTo(atLeast, 10);
        expect(row.pAtMost).toBeCloseTo(atMost, 10);
      }
    }
  });
});

describe("simulateMax: the maximum of correlated rules on a fair machine", () => {
  test("fourteen rules over twelve fair nights beat four hits more than 30 % of the time", () => {
    const plays = fourteenFixedRules().map((rule) => Array.from({ length: 12 }, () => rule.choose([], 3)));
    const { distribution } = simulateMax(plays, 40_000, 3);
    const tail = (k: number) => distribution.slice(k).reduce((a, b) => a + b, 0);
    expect(distribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // The expected count for any one rule is 2.25; the best of fourteen is
    // routinely at five, which is why "rule X would have hit five times" is
    // not a finding.
    expect(tail(5)).toBeGreaterThan(0.3);
    expect(tail(4)).toBeGreaterThan(0.85);
    const expectedMax = distribution.reduce((a, p, k) => a + p * k, 0);
    expect(expectedMax).toBeGreaterThan(4);
  });

  test("is deterministic for a seed and reports the live rule's longest drought", () => {
    const plays = fourteenFixedRules().map((rule) => Array.from({ length: 12 }, () => rule.choose([], 3)));
    const a = simulateMax(plays, 5_000, 9, 0);
    const b = simulateMax(plays, 5_000, 9, 0);
    expect(a).toEqual(b);
    expect(a.longestRun.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    // Twelve straight misses: (13/16)^12 = 8.3 %, give or take Monte Carlo.
    expect(a.longestRun[12]!).toBeGreaterThan(0.05);
    expect(a.longestRun[12]!).toBeLessThan(0.12);
  });
});

describe("postmortem", () => {
  test("on a fair machine the live rule's window is inside its own forecast and nothing clears the tournament", () => {
    const draws = history(520, 21);
    const rules = standardSuperRules(1);
    const pm = postmortem(draws, rules, { draws: 12, sims: 5_000, seed: 2, warmup: 400 });
    expect(pm.window).toHaveLength(12);
    expect(pm.expectedPerRule).toBeCloseTo(12 * 3 / 16, 12);
    expect(pm.model).not.toBeNull();
    expect(pm.model!.name).toBe("highest posterior (hot)");
    expect(pm.model!.perNightMiss).toBeCloseTo(13 / 16, 12);
    expect(pm.model!.drought.pCurrent).toBeCloseTo((13 / 16) ** pm.model!.drought.current, 10);
    expect(pm.max.observed).toBe(Math.max(...pm.rules.map((r) => r.hits)));
    expect(pm.max.rules.length).toBeGreaterThan(0);
    expect(pm.max.pAtLeast).toBeGreaterThan(0);
    expect(pm.tournament).not.toBeNull();
    expect(pm.tournament!.every((t) => !t.beatsChance)).toBe(true);
    expect(pm.threshold).toBeGreaterThan(2.5);
  });

  test("a loaded ball separates the rule that plays it, in the window and in the tournament", () => {
    // Ball 4 half the time, otherwise fair.
    const draws = history(600, 33, (_, rng) => (rng() < 0.5 ? 4 : 1 + randInt(rng, SUPER_POOL)));
    const plays4: SuperRule = { name: "always 4", choose: (_, n) => [4, 9, 14].slice(0, n) };
    const rules = [...fourteenFixedRules().filter((r) => !r.choose([], 3).includes(4)), plays4];
    const pm = postmortem(draws, rules, { draws: 60, sims: 20_000, seed: 5, liveRule: "always 4", warmup: 400 });
    const row = pm.rules.find((r) => r.name === "always 4")!;
    // ≈ 0.5 + 0.5·3/16 ≈ 59 % a night against 18.75 %.
    expect(row.hits).toBeGreaterThan(25);
    expect(row.pAtLeast).toBeLessThan(1e-4);
    expect(pm.max.rules).toEqual(["always 4"]);
    expect(pm.max.pAtLeast).toBeLessThan(0.001);
    const verdict = pm.tournament!.find((t) => t.name === "always 4")!;
    expect(verdict.beatsChance).toBe(true);
    expect(verdict.z).toBeGreaterThan(pm.threshold);
    // Rules that avoid ball 4 may separate *downwards* (they hit 0.5·3/16 a
    // night); the only rule that clears the threshold upwards is the one
    // playing the loaded ball.
    expect(pm.tournament!.filter((t) => t.beatsChance && t.z > 0).map((t) => t.name)).toEqual(["always 4"]);
  });

  test("tournament can be skipped and a missing live rule yields no model row", () => {
    const draws = history(100, 4);
    const pm = postmortem(draws, fourteenFixedRules(), { draws: 12, sims: 1_000, tournament: false, liveRule: "nobody" });
    expect(pm.tournament).toBeNull();
    expect(pm.model).toBeNull();
    expect(pm.rules).toHaveLength(14);
  });
});
