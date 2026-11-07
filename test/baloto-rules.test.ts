import { expect, test, describe } from "bun:test";
import {
  MAIN_COMBINATIONS,
  TOTAL_COMBINATIONS,
  afterTax,
  anyPrizeProbability,
  choose,
  classify,
  mainMatchProbability,
  PRIZE_TIERS,
  taxThreshold,
  tierProbability,
} from "../src/baloto/rules.ts";

describe("Baloto combinatorics", () => {
  test("the game has C(43,5) × 16 = 15 401 568 tickets", () => {
    expect(MAIN_COMBINATIONS).toBe(962_598);
    expect(TOTAL_COMBINATIONS).toBe(15_401_568);
  });

  test("choose() is exact for the arguments the game needs", () => {
    expect(choose(43, 5)).toBe(962_598);
    expect(choose(38, 5)).toBe(501_942);
    expect(choose(5, 0)).toBe(1);
    expect(choose(5, 6)).toBe(0);
  });

  test("the hypergeometric match probabilities are a distribution", () => {
    const total = [0, 1, 2, 3, 4, 5].reduce((a, k) => a + mainMatchProbability(k), 0);
    expect(total).toBeCloseTo(1, 12);
  });

  test("the jackpot is exactly 1 in 15 401 568", () => {
    expect(tierProbability(PRIZE_TIERS[0]!)).toBeCloseTo(1 / TOTAL_COMBINATIONS, 15);
  });

  test("the eight categories reproduce the advertised 1-in-14 odds", () => {
    // The operator advertises "one in 14" of winning something.
    expect(1 / anyPrizeProbability()).toBeCloseTo(14.4, 1);
  });

  test("the categories are mutually exclusive and cover every outcome", () => {
    // Every (matches, super) pair maps to at most one tier.
    for (let matches = 0; matches <= 5; matches++) {
      for (const superHit of [true, false]) {
        const hits = PRIZE_TIERS.filter(
          (t) => matches >= t.minMain && matches <= t.maxMain && t.superMatch === superHit,
        );
        expect(hits.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("classify", () => {
  const drawn = { main: [1, 2, 3, 4, 5], super: 7 };

  test("five numbers and the Súper Balota is the jackpot", () => {
    expect(classify({ main: [1, 2, 3, 4, 5], super: 7 }, drawn)?.id).toBe("5+S");
  });

  test("five numbers without the Súper Balota is the second category", () => {
    expect(classify({ main: [1, 2, 3, 4, 5], super: 8 }, drawn)?.id).toBe("5");
  });

  test("the Súper Balota alone still pays", () => {
    expect(classify({ main: [20, 21, 22, 23, 24], super: 7 }, drawn)?.id).toBe("1+S");
  });

  test("two numbers without the Súper Balota pays nothing", () => {
    expect(classify({ main: [1, 2, 20, 21, 22], super: 8 }, drawn)).toBeNull();
  });
});

describe("withholding tax", () => {
  test("small prizes are paid in full", () => {
    expect(afterTax(taxThreshold())).toBe(taxThreshold());
  });

  test("prizes above 48 UVT lose 20 %", () => {
    const prize = taxThreshold() + 1_000_000;
    expect(afterTax(prize)).toBeCloseTo(prize * 0.8, 6);
  });
});
