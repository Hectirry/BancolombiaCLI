import { expect, test, describe } from "bun:test";
import {
  binomialTwoSided,
  nextDrawDate,
  poissonBinomialTwoSided,
  recordRecommendation,
  scoreLedger,
  type Ledger,
} from "../src/baloto/ledger.ts";
import type { Draw } from "../src/baloto/dataset.ts";

const draw = (date: string, main: number[], sup: number): Draw => ({ date, game: "baloto", main, super: sup });

describe("nextDrawDate", () => {
  test("steps to the next Monday, Wednesday or Saturday", () => {
    expect(nextDrawDate("2026-10-03")).toBe("2026-10-05"); // Sat → Mon
    expect(nextDrawDate("2026-10-05")).toBe("2026-10-07"); // Mon → Wed
    expect(nextDrawDate("2026-10-07")).toBe("2026-10-10"); // Wed → Sat
    expect(nextDrawDate("2026-10-04")).toBe("2026-10-05"); // Sun → Mon
  });
});

describe("recordRecommendation", () => {
  test("keeps the last word per (draw, game, model) and sorts by target", () => {
    let ledger: Ledger = { entries: [] };
    const base = { game: "baloto" as const, model: "super/posterior", tickets: [{ main: [1, 2, 3, 4, 5], super: 1 }] };
    ledger = recordRecommendation(ledger, { ...base, recordedAt: "2026-10-04T10:00:00Z", targetDate: "2026-10-07" });
    ledger = recordRecommendation(ledger, { ...base, recordedAt: "2026-10-04T11:00:00Z", targetDate: "2026-10-05" });
    ledger = recordRecommendation(ledger, {
      ...base,
      recordedAt: "2026-10-04T12:00:00Z",
      targetDate: "2026-10-05",
      tickets: [{ main: [6, 7, 8, 9, 10], super: 2 }],
    });
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0]!.targetDate).toBe("2026-10-05");
    expect(ledger.entries[0]!.tickets[0]!.super).toBe(2);
  });
});

describe("scoreLedger", () => {
  const tickets = [
    { main: [10, 20, 36, 37, 40], super: 11 },
    { main: [12, 21, 34, 35, 39], super: 13 },
    { main: [11, 25, 32, 33, 42], super: 7 },
  ];
  const ledger: Ledger = {
    entries: [
      { recordedAt: "a", targetDate: "2026-10-03", game: "baloto", model: "m", tickets },
      { recordedAt: "b", targetDate: "2026-10-05", game: "baloto", model: "m", tickets },
      { recordedAt: "c", targetDate: "2026-10-07", game: "baloto", model: "m", tickets },
    ],
  };
  const draws = [
    draw("2026-10-03", [3, 10, 14, 26, 31], 10), // miss
    draw("2026-10-05", [1, 2, 3, 4, 12], 13), // ticket 2 hits the Súper Balota with one match → 1+S
  ];
  const score = scoreLedger(ledger, draws);

  test("scores what has a draw and leaves the rest pending", () => {
    expect(score.scored).toHaveLength(2);
    expect(score.pending).toHaveLength(1);
    expect(score.pending[0]!.targetDate).toBe("2026-10-07");
  });

  test("counts Súper Balota hits against the exact expectation", () => {
    expect(score.superHits).toBe(1);
    expect(score.superExpected).toBeCloseTo(2 * 3 / 16, 12);
    expect(score.scored[1]!.superHitTicket).toBe(1);
    expect(score.scored[1]!.bestTier).toBe("1+S");
    expect(score.scored[0]!.bestTier).toBeNull();
    expect(score.wins).toBe(1);
  });

  test("the binomial p-value is two-sided and exact", () => {
    expect(binomialTwoSided(2, 4, 0.5)).toBeCloseTo(1, 9); // dead centre
    expect(binomialTwoSided(0, 10, 0.5)).toBeCloseTo(2 / 1024, 9);
    expect(binomialTwoSided(10, 10, 0.5)).toBeCloseTo(2 / 1024, 9);
    expect(score.superPValue).not.toBeNull();
    expect(score.superPValue!).toBeGreaterThan(0.3);
  });

  test("the doubled-tail convention is the conservative one and survives the edges", () => {
    // 3 hits in 5 at 3/16: doubling gives 2·P(X ≥ 3) = 0.0975; the
    // minimum-likelihood convention would give 0.0488.
    expect(binomialTwoSided(3, 5, 3 / 16)).toBeCloseTo(0.09753799, 7);
    // Certain or impossible events: the observation is the only outcome, p = 1, never NaN.
    expect(binomialTwoSided(3, 3, 1)).toBe(1);
    expect(binomialTwoSided(0, 3, 0)).toBe(1);
    expect(poissonBinomialTwoSided(0, [])).toBe(1);
  });

  test("entries with different ticket counts still get an exact (Poisson-binomial) p-value", () => {
    const mixed: Ledger = {
      entries: [
        { recordedAt: "a", targetDate: "2026-10-03", game: "baloto", model: "m", tickets },
        { recordedAt: "b", targetDate: "2026-10-05", game: "baloto", model: "m", tickets: tickets.slice(0, 2) },
      ],
    };
    const s = scoreLedger(mixed, draws);
    expect(s.superExpected).toBeCloseTo(3 / 16 + 2 / 16, 12);
    expect(s.superHits).toBe(1);
    // P(X ≥ 1) = 1 − (13/16)(14/16); P(X ≤ 1) = 1 − (3/16)(2/16); doubled smaller tail.
    const upper = 1 - (13 / 16) * (14 / 16);
    const lower = 1 - (3 / 16) * (2 / 16);
    expect(s.superPValue).toBeCloseTo(Math.min(1, 2 * Math.min(upper, lower)), 12);
    // equal probabilities reduce to the binomial
    expect(poissonBinomialTwoSided(1, [3 / 16, 3 / 16, 3 / 16])).toBeCloseTo(binomialTwoSided(1, 3, 3 / 16), 12);
  });
});
