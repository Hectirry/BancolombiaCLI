import { expect, test, describe } from "bun:test";
import { biasPowerCurve, breakevenBias, scanForLocalBias } from "../src/baloto/physical.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function history(count: number, seed: number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2020-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: 1 + randInt(rng, SUPER_POOL),
  }));
}

describe("scanForLocalBias", () => {
  test("finds nothing in a history that is fair throughout", () => {
    const report = scanForLocalBias(history(400, 13), [50, 100], 60, 7);
    expect(report.biasFound).toBe(false);
    expect(report.pValue).toBeGreaterThan(0.05);
  });

  test("catches a ball that runs hot for part of the history only", () => {
    // A whole-history test would dilute this away; the scan is what sees it.
    const draws = history(400, 13).map((draw, i) =>
      i >= 150 && i < 250 && !draw.main.includes(11)
        ? { ...draw, main: [11, ...draw.main.slice(1)].sort((a, b) => a - b) }
        : draw,
    );
    const report = scanForLocalBias(draws, [50, 100], 60, 7);
    expect(report.biasFound).toBe(true);
    expect(report.hottest?.number).toBe(11);
  });

  test("reports the stretch it found, with dates from the data", () => {
    const draws = history(300, 5);
    const report = scanForLocalBias(draws, [50], 40, 7);
    expect(report.hottest).not.toBeNull();
    expect(report.windowSizes).toEqual([50]);
    expect(draws.some((d) => d.date === report.hottest!.from)).toBe(true);
    expect(draws.some((d) => d.date === report.hottest!.to)).toBe(true);
    expect(report.comparisons).toBeGreaterThan(0);
  });

  test("skips windows longer than the history", () => {
    const report = scanForLocalBias(history(60, 3), [50, 5000], 30, 7);
    expect(Number.isFinite(report.observedMaxZ)).toBe(true);
  });
});

describe("biasPowerCurve", () => {
  const curve = biasPowerCurve(900, [0, 0.2, 0.6], 60, 11);

  test("an unbiased machine is flagged at roughly the test's own error rate", () => {
    expect(curve[0]!.detectionRate).toBeLessThan(0.2);
    expect(Math.abs(curve[0]!.typicalZ)).toBeLessThan(0.6);
  });

  test("bigger biases are easier to see", () => {
    expect(curve[1]!.detectionRate).toBeLessThanOrEqual(curve[2]!.detectionRate);
    expect(curve[2]!.detectionRate).toBeGreaterThan(0.5);
  });

  test("a heavy ball leaves a positive deviation", () => {
    expect(curve[2]!.typicalZ).toBeGreaterThan(curve[0]!.typicalZ);
  });
});

describe("breakevenBias", () => {
  test("no bias is needed when the ticket already breaks even", () => {
    expect(breakevenBias(4_000, 2_000, 6_000)).toBe(0);
  });

  test("solves the fifth root of the required multiplier", () => {
    // Needs the jackpot term to double: 2^(1/5) - 1 ≈ 0.1487.
    expect(breakevenBias(3_000, 0, 6_000)).toBeCloseTo(2 ** 0.2 - 1, 10);
  });

  test("an unwinnable ticket needs an infinite bias", () => {
    expect(breakevenBias(0, 100, 6_000)).toBe(Infinity);
  });
});
