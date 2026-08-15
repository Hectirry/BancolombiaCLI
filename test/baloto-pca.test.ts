import { expect, test, describe } from "bun:test";
import {
  comparePcaToFair,
  covariance,
  indicatorMatrix,
  regressWinnerCrowding,
  symmetricEigen,
} from "../src/baloto/pca.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, PRIZE_TIERS, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

describe("symmetricEigen", () => {
  test("diagonalises a matrix with known eigenvalues", () => {
    // [[2,1],[1,2]] has eigenvalues 3 and 1.
    const { values } = symmetricEigen([
      [2, 1],
      [1, 2],
    ]);
    expect(values[0]).toBeCloseTo(3, 10);
    expect(values[1]).toBeCloseTo(1, 10);
  });

  test("returns eigenvalues in descending order", () => {
    const { values } = symmetricEigen([
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ]);
    expect(values[0]).toBeGreaterThan(values[1]!);
    expect(values[1]).toBeGreaterThan(values[2]!);
  });

  test("the eigenvalues sum to the trace", () => {
    const matrix = [
      [5, 2, 1],
      [2, 6, 3],
      [1, 3, 7],
    ];
    const { values } = symmetricEigen(matrix);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(5 + 6 + 7, 8);
  });

  test("eigenvectors actually satisfy A·v = λ·v", () => {
    const matrix = [
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ];
    const { values, vectors } = symmetricEigen(matrix);
    const v = vectors[0]!;
    for (let i = 0; i < 3; i++) {
      const av = matrix[i]!.reduce((acc, value, j) => acc + value * v[j]!, 0);
      expect(av).toBeCloseTo(values[0]! * v[i]!, 8);
    }
  });
});

describe("covariance", () => {
  test("recovers the variance of a single column", () => {
    const cov = covariance([[2], [4], [4], [4], [5], [5], [7], [9]]);
    // Sample variance of that series is 32/7.
    expect(cov[0]![0]).toBeCloseTo(32 / 7, 10);
  });

  test("is symmetric", () => {
    const cov = covariance([
      [1, 2, 3],
      [4, 1, 6],
      [7, 8, 2],
      [2, 5, 9],
    ]);
    expect(cov[0]![1]).toBeCloseTo(cov[1]![0]!, 12);
    expect(cov[0]![2]).toBeCloseTo(cov[2]![0]!, 12);
  });
});

function fairDraws(count: number, seed: number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: 1 + randInt(rng, SUPER_POOL),
  }));
}

describe("indicatorMatrix", () => {
  test("marks exactly the five drawn balls", () => {
    const rows = indicatorMatrix([
      { date: "2020-01-01", game: "baloto", main: [1, 2, 3, 4, 43], super: 1 },
    ]);
    expect(rows[0]).toHaveLength(MAIN_POOL);
    expect(rows[0]!.reduce((a, b) => a + b, 0)).toBe(MAIN_PICK);
    expect(rows[0]![0]).toBe(1);
    expect(rows[0]![42]).toBe(1);
    expect(rows[0]![10]).toBe(0);
  });
});

describe("comparePcaToFair", () => {
  test("finds no latent structure in draws that are fair by construction", () => {
    const report = comparePcaToFair(fairDraws(500, 17), 40, 3, 5);
    expect(report.structureFound).toBe(0);
  });

  test("detects a factor that makes numbers appear together", () => {
    // Half the draws are forced to contain 1..5 as a block: a latent factor.
    const draws = fairDraws(500, 17).map((d, i) =>
      i % 2 === 0 ? { ...d, main: [1, 2, 3, 4, 5] } : d,
    );
    const report = comparePcaToFair(draws, 40, 3, 5);
    expect(report.structureFound).toBeGreaterThan(0);
    expect(report.leadingObserved).toBeGreaterThan(report.leadingExpected);
  });

  test("components are ordered and each stays a valid variance share", () => {
    const report = comparePcaToFair(fairDraws(300, 5), 20, 3, 6);
    for (const component of report.components) {
      expect(component.observed).toBeGreaterThanOrEqual(0);
      expect(component.observed).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < report.components.length; i++) {
      expect(report.components[i]!.observed).toBeLessThanOrEqual(
        report.components[i - 1]!.observed + 1e-12,
      );
    }
  });
});

/** Draws whose winner counts depend on how many low numbers came out. */
function crowdedSeason(count: number, seed: number): Draw[] {
  const base = fairDraws(count, seed);
  return base.map((draw) => {
    const lows = draw.main.filter((n) => n <= 31).length;
    // More birthday-range numbers => a larger share of high-match winners.
    const skilled = 100 + 60 * lows;
    const tiers = PRIZE_TIERS.map((tier) => {
      const winners = ["5", "4+S", "4", "3+S", "3"].includes(tier.id)
        ? skilled
        : tier.id === "1+S"
          ? 5_000
          : 0;
      return { tier: tier.id, winners, prizePerWinner: 1, totalPaid: winners };
    });
    return { ...draw, tiers };
  });
}

describe("regressWinnerCrowding", () => {
  test("recovers a planted relationship between the draw and prize sharing", () => {
    const regression = regressWinnerCrowding(crowdedSeason(400, 23));
    const dateRange = regression.terms.find((t) => t.name === "date-range")!;
    expect(dateRange.beta).toBeGreaterThan(0);
    expect(dateRange.significant).toBe(true);
    expect(regression.rSquared).toBeGreaterThan(0.5);
  });

  test("finds nothing when winner counts carry no signal", () => {
    const flat = fairDraws(400, 31).map((draw) => ({
      ...draw,
      tiers: PRIZE_TIERS.map((tier) => ({
        tier: tier.id,
        winners: tier.id === "1+S" ? 5_000 : 100,
        prizePerWinner: 1,
        totalPaid: tier.id === "1+S" ? 5_000 : 100,
      })),
    }));
    const regression = regressWinnerCrowding(flat);
    expect(regression.terms.every((t) => !t.significant)).toBe(true);
  });

  test("returns nothing usable when no breakdowns are published", () => {
    const regression = regressWinnerCrowding(fairDraws(100, 3));
    expect(regression.observations).toBe(0);
    expect(regression.terms).toHaveLength(0);
  });
});
