import { expect, test, describe } from "bun:test";
import { analyse, chiSquare, dueStatistic, frequencies } from "../src/baloto/stats.ts";
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

/**
 * A machine with memory of absence: `favoured` of the five numbers come from
 * the ten that have been absent longest ("due") or shortest ("hot"), the rest
 * from the other 33 uniformly.
 */
function memoryHistory(count: number, kind: "due" | "hot", seed = 1, favoured = 2): Draw[] {
  const rng = makeRng(seed);
  const lastSeen = new Array<number>(MAIN_POOL).fill(-1);
  const pick = (from: number[], k: number): number[] => {
    const pool = [...from];
    const out: number[] = [];
    for (let i = 0; i < k; i++) out.push(pool.splice(randInt(rng, pool.length), 1)[0]!);
    return out;
  };
  return Array.from({ length: count }, (_, i) => {
    const byAbsence = Array.from({ length: MAIN_POOL }, (_, k) => k + 1).sort(
      (a, b) => lastSeen[a - 1]! - lastSeen[b - 1]! || a - b,
    );
    const ten = kind === "due" ? byAbsence.slice(0, 10) : byAbsence.slice(-10);
    const rest = byAbsence.filter((n) => !ten.includes(n));
    const main = [...pick(ten, favoured), ...pick(rest, MAIN_PICK - favoured)].sort((a, b) => a - b);
    for (const n of main) lastSeen[n - 1] = i;
    return { date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`, game: "baloto" as const, main, super: 1 + randInt(rng, SUPER_POOL) };
  });
}

describe("due-numbers", () => {
  const mains = (draws: Draw[]) => draws.map((d) => d.main);

  test("the overdue rank of a fair machine averages (pool + 1) / 2", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => dueStatistic(mains(fairHistory(600, seed)), MAIN_POOL));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean - (MAIN_POOL + 1) / 2)).toBeLessThan(0.25);
    // ties share a rank: a history where every draw is the same five numbers
    // ranks them 1–5 with mean 3, whatever the other 38 are doing.
    expect(dueStatistic([[1, 2, 3, 4, 5], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5]], MAIN_POOL)).toBe(3);
    expect(dueStatistic([[1, 2, 3, 4, 5]], MAIN_POOL)).toBe((MAIN_POOL + 1) / 2);
  });

  test("moves up for a machine that favours overdue numbers, down for one that repeats recent ones", () => {
    const due = dueStatistic(mains(memoryHistory(400, "due", 3)), MAIN_POOL);
    const hot = dueStatistic(mains(memoryHistory(400, "hot", 3)), MAIN_POOL);
    expect(due).toBeGreaterThan(23);
    expect(hot).toBeLessThan(21);
    for (const kind of ["due", "hot"] as const) {
      const flagged = analyse(memoryHistory(400, kind, 3), 400, 99).tests.find((t) => t.id === "due-numbers")!;
      expect(flagged.verdict).toBe("deviates from chance");
    }
  });

  test("reads the inside of the history, not only how it begins and ends", () => {
    // The mean gap between appearances, used until 2026-11-16, telescopes to
    // (last − first) per number: two histories with the same opening and the
    // same ending scored the same whatever happened in between. This one must
    // tell them apart.
    const fair = fairHistory(600, 21);
    const rigged = [...fair.slice(0, 100), ...memoryHistory(400, "due", 4), ...fair.slice(500)];
    const meanGap = (rows: number[][]): number => {
      const last = new Array<number>(MAIN_POOL).fill(-1);
      let total = 0;
      let counted = 0;
      rows.forEach((row, i) => {
        for (const n of row) {
          if (last[n - 1]! >= 0) {
            total += i - last[n - 1]!;
            counted++;
          }
          last[n - 1] = i;
        }
      });
      return total / counted;
    };
    // The old statistic cannot see the 400 rigged draws in the middle…
    expect(Math.abs(meanGap(mains(rigged)) - meanGap(mains(fair)))).toBeLessThan(0.03);
    // …the new one does.
    expect(dueStatistic(mains(rigged), MAIN_POOL) - dueStatistic(mains(fair), MAIN_POOL)).toBeGreaterThan(0.5);
    expect(analyse(rigged, 400, 99).tests.find((t) => t.id === "due-numbers")!.verdict).toBe("deviates from chance");
    expect(analyse(fair, 400, 99).tests.find((t) => t.id === "due-numbers")!.verdict).toBe("consistent with chance");
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
