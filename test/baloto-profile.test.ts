import { expect, test, describe } from "bun:test";
import { FEATURES, looksTypical, profileDraws, typicalRanges } from "../src/baloto/profile.ts";
import { pickTickets } from "../src/baloto/pick.ts";
import { uniformModel } from "../src/baloto/bias.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function history(count: number, seed: number, rig?: (main: number[]) => number[]): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => {
    const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
    return {
      date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
      game: "baloto" as const,
      main: rig ? rig(main) : main,
      super: 1 + randInt(rng, SUPER_POOL),
    };
  });
}

describe("draw features", () => {
  const main = [3, 4, 11, 12, 40];

  test("compute what they claim to compute", () => {
    const value = (name: string) =>
      FEATURES.find((f) => f.name === name)!.value(main, 7, [4, 20, 30, 39, 41]);
    expect(value("sum")).toBe(70);
    expect(value("spread")).toBe(37);
    expect(value("lowest")).toBe(3);
    expect(value("highest")).toBe(40);
    expect(value("evens")).toBe(3); // 4, 12, 40
    expect(value("date-range")).toBe(4); // all but 40
    expect(value("consecutive")).toBe(2); // 3-4 and 11-12
    expect(value("min-gap")).toBe(1);
    expect(value("max-gap")).toBe(28); // 12 -> 40
    expect(value("decades")).toBe(3); // 0-9, 10-19, 40+
    expect(value("biggest-cluster")).toBe(2);
    expect(value("primes")).toBe(2); // 3, 11
    expect(value("multiples-of-5")).toBe(1); // 40
    expect(value("super-balota")).toBe(7);
    expect(value("carry-over")).toBe(1); // 4 was in the previous draw
    expect(value("near-miss")).toBe(2); // 3 and 40 sit beside 4 and 39
  });

  test("carry-over is zero when there is no previous draw", () => {
    expect(FEATURES.find((f) => f.name === "carry-over")!.value(main, 7, null)).toBe(0);
  });
});

describe("profileDraws", () => {
  test("finds no pattern in draws that are fair by construction", () => {
    const report = profileDraws(history(900, 21), 20_000, 300, 7);
    expect(report.patternsFound).toBe(0);
  });

  test("detects a machine that never draws high numbers", () => {
    // If this could not be caught, a clean report would mean nothing.
    const rigged = history(900, 21, (main) => main.map((n) => ((n - 1) % 31) + 1))
      .map((d) => ({ ...d, main: [...new Set(d.main)].sort((a, b) => a - b) }))
      .filter((d) => d.main.length === MAIN_PICK);
    const report = profileDraws(rigged, 20_000, 300, 7);
    expect(report.patternsFound).toBeGreaterThan(0);
    const highest = report.features.find((f) => f.name === "highest")!;
    expect(highest.significant).toBe(true);
    expect(highest.observed).toBeLessThan(highest.expected);
  });

  test("reports every feature exactly once", () => {
    const report = profileDraws(history(200, 3), 5_000, 100, 7);
    expect(report.features).toHaveLength(FEATURES.length);
    expect(new Set(report.features.map((f) => f.name)).size).toBe(FEATURES.length);
  });

  test("the correction only ever makes a p-value less impressive", () => {
    const report = profileDraws(history(400, 9), 10_000, 200, 7);
    for (const feature of report.features) {
      expect(feature.adjustedPValue).toBeGreaterThanOrEqual(
        Math.min(feature.meanPValue, feature.shapePValue) - 1e-12,
      );
    }
  });
});

describe("typical combinations", () => {
  const ranges = typicalRanges(["sum", "spread", "biggest-cluster"], 0.8, 20_000, 11);

  test("the central range excludes the obvious extremes", () => {
    expect(looksTypical([1, 2, 3, 4, 5], 1, ranges)).toBe(false);
    expect(looksTypical([39, 40, 41, 42, 43], 1, ranges)).toBe(false);
  });

  test("a spread combination of ordinary size is inside it", () => {
    expect(looksTypical([6, 15, 23, 31, 38], 1, ranges)).toBe(true);
  });

  test("picked tickets can be required to look like plausible results", () => {
    const model = uniformModel();
    // Bias the model so the picker has an unpopular tail to aim at.
    model.main = model.main.map((p, i) => (i < 31 ? p * 1.3 : p));
    const scale = MAIN_PICK / model.main.reduce((a, b) => a + b, 0);
    model.main = model.main.map((p) => p * scale);

    const picks = pickTickets(model, {
      count: 3,
      candidates: 600,
      typical: true,
      seed: 31,
    });
    expect(picks).toHaveLength(3);
    const full = typicalRanges(["sum", "spread", "biggest-cluster", "decades", "min-gap"]);
    for (const { ticket } of picks) {
      expect(looksTypical(ticket.main, ticket.super, full)).toBe(true);
    }
  });
});
