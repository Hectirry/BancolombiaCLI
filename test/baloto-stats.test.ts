import { expect, test, describe } from "bun:test";
import { analyse, chiSquare, frequencies } from "../src/baloto/stats.ts";
import { backtest, defaultStrategies } from "../src/baloto/backtest.ts";
import { makeRng, monteCarloPValue, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_POOL, MAIN_PICK, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

/** A synthetic history of genuinely fair draws. */
function fairHistory(count: number, seed = 1): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: 1 + randInt(rng, SUPER_POOL),
  }));
}

/** The same, but with a machine that always spits out the number 7. */
function riggedHistory(count: number, seed = 1): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => {
    const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer).filter((n) => n !== 7);
    return {
      date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
      game: "baloto" as const,
      main: [7, ...main.slice(0, MAIN_PICK - 1)].sort((a, b) => a - b),
      super: 1 + randInt(rng, SUPER_POOL),
    };
  });
}

describe("sampling", () => {
  test("sampleDistinct returns k distinct, ascending numbers in range", () => {
    const rng = makeRng(42);
    const buffer = new Int32Array(MAIN_POOL);
    for (let i = 0; i < 200; i++) {
      const draw = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
      expect(draw).toHaveLength(MAIN_PICK);
      expect(new Set(draw).size).toBe(MAIN_PICK);
      expect([...draw].sort((a, b) => a - b)).toEqual(draw);
      expect(Math.min(...draw)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...draw)).toBeLessThanOrEqual(MAIN_POOL);
    }
  });

  test("the generator is reproducible from a seed", () => {
    expect(makeRng(7)()).toBe(makeRng(7)());
  });

  test("a Monte Carlo p-value is never exactly zero", () => {
    expect(monteCarloPValue(999, [1, 2, 3])).toBeGreaterThan(0);
    expect(monteCarloPValue(0, [1, 2, 3])).toBeCloseTo(1, 10);
  });
});

describe("chiSquare", () => {
  test("is zero when every count matches expectation", () => {
    expect(chiSquare([10, 10, 10], 10)).toBe(0);
  });

  test("grows with the deviation", () => {
    expect(chiSquare([12, 8, 10], 10)).toBeGreaterThan(0);
  });
});

describe("frequencies", () => {
  test("counts appearances and reports the current dry spell", () => {
    const draws: Draw[] = [
      { date: "2020-01-01", game: "baloto", main: [1, 2, 3, 4, 5], super: 1 },
      { date: "2020-01-04", game: "baloto", main: [6, 7, 8, 9, 10], super: 2 },
      { date: "2020-01-08", game: "baloto", main: [1, 11, 12, 13, 14], super: 3 },
    ];
    const freq = frequencies(draws, MAIN_POOL, (d) => d.main);
    expect(freq[0]!.count).toBe(2);
    expect(freq[0]!.gap).toBe(0); // number 1 came out in the most recent draw
    expect(freq[1]!.count).toBe(1);
    expect(freq[1]!.gap).toBe(2); // number 2 last appeared two draws ago
  });
});

describe("analyse", () => {
  test("finds nothing wrong with a genuinely fair history", () => {
    const report = analyse(fairHistory(400, 11), 400, 99);
    const flagged = report.tests.filter((t) => t.verdict !== "consistent with chance");
    expect(flagged).toHaveLength(0);
  });

  test("detects a machine that always draws the same number", () => {
    // If the tests could not catch this, they would not be worth running.
    const report = analyse(riggedHistory(400, 11), 400, 99);
    const uniformity = report.tests.find((t) => t.id === "main-uniformity")!;
    expect(uniformity.verdict).toBe("deviates from chance");
    expect(uniformity.pValue).toBeLessThan(0.01);
  });

  test("reports the window it analysed", () => {
    const draws = fairHistory(50, 3);
    const report = analyse(draws, 100, 5);
    expect(report.draws).toBe(50);
    expect(report.from).toBe(draws[0]!.date);
    expect(report.to).toBe(draws.at(-1)!.date);
  });
});

describe("backtest", () => {
  const report = backtest(fairHistory(400, 5), defaultStrategies(50), 50, 3, 123);

  test("scores every draw after the warm-up", () => {
    expect(report.evaluated).toBe(350);
    expect(report.chanceMatches).toBeCloseTo((MAIN_PICK * MAIN_PICK) / MAIN_POOL, 12);
  });

  test("no strategy beats chance on data that is chance by construction", () => {
    for (const result of report.results) {
      expect(Math.abs(result.z)).toBeLessThan(3);
    }
  });

  test("a strategy only ever sees draws before the one it bets on", () => {
    const seen: number[] = [];
    backtest(
      fairHistory(20, 9),
      [
        {
          id: "spy",
          description: "records how much history it was shown",
          pick: (history) => {
            seen.push(history.length);
            return { main: [1, 2, 3, 4, 5], super: 1 };
          },
        },
      ],
      10,
      1,
      1,
    );
    expect(seen).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
});
