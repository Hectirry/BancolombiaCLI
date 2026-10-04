import { expect, test, describe } from "bun:test";
import {
  binomialTwoSided,
  detectableDeparture,
  entryCost,
  entryExpectation,
  nextDrawDate,
  nightsToDistinguish,
  recordRecommendation,
  scoreLedger,
  type Ledger,
} from "../src/baloto/ledger.ts";
import type { Draw, Game } from "../src/baloto/dataset.ts";

const draw = (date: string, main: number[], sup: number, game: Game = "baloto"): Draw => ({ date, game, main, super: sup });

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

  test("keeps the stake: $6.000 a ticket when no cost was recorded, and pesos per hit", () => {
    expect(score.tickets).toBe(6);
    expect(score.staked).toBe(36_000);
    expect(score.stakePerHit.observed).toBe(36_000);
    expect(score.stakePerHit.expected).toBeCloseTo(36_000 / (6 / 16), 6);
  });

  test("reads the drought against the model's own miss probability", () => {
    // Night 1 missed, night 2 hit: current drought 0, longest 1.
    expect(score.streak).toEqual({ current: 0, longest: 1, pCurrent: 1 });
    const dry = scoreLedger(ledger, [draws[0]!, draw("2026-10-05", [1, 2, 3, 4, 5], 1)]);
    expect(dry.streak.current).toBe(2);
    expect(dry.streak.pCurrent).toBeCloseTo((13 / 16) ** 2, 12);
  });
});

describe("scoreLedger with Revancha", () => {
  const tickets = [
    { main: [10, 20, 36, 37, 40], super: 11 },
    { main: [12, 21, 34, 35, 39], super: 13 },
  ];
  const entry = (targetDate: string) => ({
    recordedAt: "a",
    targetDate,
    game: "baloto" as const,
    model: "m",
    tickets,
    revancha: true,
    cost: 18_000,
  });
  const ledger: Ledger = { entries: [entry("2026-10-03"), entry("2026-10-05"), entry("2026-10-07")] };
  const draws = [
    draw("2026-10-03", [3, 10, 14, 26, 31], 10), // Baloto misses
    draw("2026-10-03", [1, 2, 3, 4, 5], 13, "revancha"), // Revancha: ticket 2 hits the Súper Balota
    draw("2026-10-05", [1, 2, 3, 4, 5], 1), // Baloto misses
    draw("2026-10-05", [6, 7, 8, 9, 15], 2, "revancha"), // Revancha misses
    draw("2026-10-07", [1, 2, 3, 4, 5], 11), // Baloto hits, but the Revancha draw is not in yet
  ];
  const score = scoreLedger(ledger, draws);

  test("a night counts as a hit when either draw hits, and is pending until both are in", () => {
    expect(score.scored).toHaveLength(2);
    expect(score.pending.map((p) => p.targetDate)).toEqual(["2026-10-07"]);
    expect(score.scored[0]!.superHitTicket).toBe(-1);
    expect(score.scored[0]!.companion!.superHitTicket).toBe(1);
    expect(score.scored[0]!.nightSuperHit).toBe(true);
    expect(score.scored[0]!.companion!.bestTier).toBe("1+S");
    expect(score.scored[0]!.wonAnything).toBe(true);
    expect(score.scored[1]!.nightSuperHit).toBe(false);
    expect(score.superHits).toBe(1);
  });

  test("the expectation is 1 − (1 − 2/16)² a night, and the p-value uses it", () => {
    expect(entryExpectation(entry("x"))).toBeCloseTo(60 / 256, 12);
    expect(score.superExpected).toBeCloseTo(2 * (60 / 256), 12);
    expect(score.nightRate).toBeCloseTo(60 / 256, 12);
    expect(score.superPValue).toBeCloseTo(binomialTwoSided(1, 2, 60 / 256), 12);
  });

  test("stakes what was recorded, and prices Revancha when nothing was", () => {
    expect(score.staked).toBe(36_000);
    expect(entryCost({ ...entry("x"), cost: undefined })).toBe(2 * 9_000);
    expect(entryCost({ ...entry("x"), cost: undefined, revancha: false })).toBe(2 * 6_000);
  });

  test("nights with different expectations get no single p-value", () => {
    const mixed: Ledger = { entries: [entry("2026-10-03"), { ...entry("2026-10-05"), revancha: false }] };
    const s = scoreLedger(mixed, draws);
    expect(s.scored).toHaveLength(2);
    expect(s.nightRate).toBeNull();
    expect(s.superPValue).toBeNull();
    expect(s.superExpected).toBeCloseTo(60 / 256 + 2 / 16, 12);
  });
});

describe("sample size", () => {
  test("18.75 % against 25 % needs 327 nights; against 21 %, 2 425", () => {
    expect(nightsToDistinguish(0.1875, 0.25)).toBe(327);
    expect(nightsToDistinguish(0.1875, 0.21)).toBe(2425);
    expect(nightsToDistinguish(0.1875, 0.1875)).toBe(Infinity);
  });

  test("the detectable departure shrinks with nights and inverts the sample size", () => {
    const few = detectableDeparture(20, 0.1875);
    const many = detectableDeparture(500, 0.1875);
    expect(few).toBeGreaterThan(many);
    expect(nightsToDistinguish(0.1875, 0.1875 + many)).toBeLessThanOrEqual(500);
    expect(nightsToDistinguish(0.1875, 0.1875 + many * 0.99)).toBeGreaterThan(500);
    expect(detectableDeparture(0, 0.1875)).toBe(1);
  });
});
