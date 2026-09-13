import { expect, test, describe } from "bun:test";
import { backtestSelection } from "../src/baloto/realized.ts";
import { matchDistribution } from "../src/baloto/bias.ts";
import { MAIN_PICK, MAIN_POOL, PRIZE_TIERS, SUPER_POOL, TIER_BY_ID } from "../src/baloto/rules.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import type { Draw } from "../src/baloto/dataset.ts";

/**
 * A synthetic season with a planted crowd that over-plays low numbers, whose
 * published payouts follow the pari-mutuel arithmetic: pot / winners, with
 * winner counts derived from the planted preferences. The realised backtest
 * must recover the advantage of leaning against that crowd.
 */
function seasonWithCrowd(count: number, seed: number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const truth = Array.from({ length: MAIN_POOL }, (_, i) => (i < 22 ? 1.6 : 1));
  const scale = MAIN_PICK / truth.reduce((a, b) => a + b, 0);
  const pi = truth.map((w) => w * scale);
  const weights = pi.map((p) => p / (1 - p));
  const tickets = 300_000;
  const salesNet = tickets * 5_042;

  return Array.from({ length: count }, (_, i) => {
    const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
    const superBall = 1 + randInt(rng, SUPER_POOL);
    const drawnSet = new Set(main);
    const inside = main.map((n) => weights[n - 1]!);
    const outside: number[] = [];
    for (let n = 1; n <= MAIN_POOL; n++) if (!drawnSet.has(n)) outside.push(weights[n - 1]!);
    const pb = matchDistribution(inside, outside);

    const tiers = PRIZE_TIERS.map((tier) => {
      let mass = 0;
      for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
      const p = mass * (tier.superMatch ? 1 / SUPER_POOL : 1 - 1 / SUPER_POOL);
      const winners = Math.max(0, Math.round(tickets * p));
      let prizePerWinner = 0;
      if (tier.id === "5+S") prizePerWinner = 10_000_000_000;
      else if (tier.kind === "fixed") prizePerWinner = 6_000;
      else if (winners > 0) prizePerWinner = Math.round((tier.allocation * salesNet) / winners);
      return { tier: tier.id, winners, prizePerWinner, totalPaid: prizePerWinner * winners };
    });
    return {
      date: `20${20 + Math.floor(i / 300)}-01-${String((i % 28) + 1).padStart(2, "0")}`,
      game: "baloto" as const,
      main,
      super: superBall,
      tiers,
    };
  });
}

describe("backtestSelection", () => {
  const report = backtestSelection(seasonWithCrowd(400, 17));

  test("splits the history in half, chronologically", () => {
    expect(report.trainDraws).toBe(200);
    expect(report.testDraws).toBe(200);
    expect(report.trainTo < report.testFrom).toBe(true);
  });

  test("learns to lean against a planted crowd", () => {
    expect(report.learnedGamma).toBeGreaterThan(0);
  });

  test("the learned rule realises more pesos than a crowd-like one, out of sample", () => {
    expect(report.testLearned).toBeGreaterThan(report.testCrowdLike);
  });

  test("the win rate barely moves — only the payout per win does", () => {
    // Odds cannot be improved; the two rules must win at nearly the same rate.
    expect(Math.abs(report.winRateLearned - report.winRateCrowdLike)).toBeLessThan(0.02);
  });

  test("reports one point per gamma evaluated", () => {
    const gammas = report.points.map((p) => p.gamma);
    expect(new Set(gammas).size).toBe(gammas.length);
    expect(gammas).toContain(0);
    expect(gammas).toContain(-1);
  });

  test("finds no advantage when the crowd is actually uniform", () => {
    // Same generator but a flat crowd: leaning against it should buy ~nothing.
    const rng = makeRng(5);
    const buffer = new Int32Array(MAIN_POOL);
    const tickets = 300_000;
    const salesNet = tickets * 5_042;
    const flat: Draw[] = Array.from({ length: 400 }, (_, i) => {
      const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
      const superBall = 1 + randInt(rng, SUPER_POOL);
      const drawnSet = new Set(main);
      const inside = main.map(() => 1);
      const outside: number[] = [];
      for (let n = 1; n <= MAIN_POOL; n++) if (!drawnSet.has(n)) outside.push(1);
      const pb = matchDistribution(inside, outside);
      const tiers = PRIZE_TIERS.map((tier) => {
        let mass = 0;
        for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
        const p = mass * (tier.superMatch ? 1 / SUPER_POOL : 1 - 1 / SUPER_POOL);
        const winners = Math.max(0, Math.round(tickets * p));
        let prizePerWinner = 0;
        if (tier.id === "5+S") prizePerWinner = 10_000_000_000;
        else if (tier.kind === "fixed") prizePerWinner = 6_000;
        else if (winners > 0) prizePerWinner = Math.round((tier.allocation * salesNet) / winners);
        return { tier: tier.id, winners, prizePerWinner, totalPaid: prizePerWinner * winners };
      });
      return {
        date: `20${20 + Math.floor(i / 300)}-02-${String((i % 28) + 1).padStart(2, "0")}`,
        game: "baloto" as const,
        main,
        super: superBall,
        tiers,
      };
    });
    const flatReport = backtestSelection(flat);
    const spread =
      Math.abs(flatReport.testLearned - flatReport.testCrowdLike) /
      Math.max(flatReport.testCrowdLike, 1);
    expect(spread).toBeLessThan(0.03);
  });
});
