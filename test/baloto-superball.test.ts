import { expect, test, describe } from "bun:test";
import {
  atLeastThreeMain,
  nightCoverage,
  nightCoverageForBudget,
  planSuperCoverage,
  scoreSuperRules,
  standardSuperRules,
  superPosterior,
  winAnythingProbability,
} from "../src/baloto/superball.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL, classify } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function history(count: number, seed: number, rigSuper?: (i: number) => number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: rigSuper ? rigSuper(i) : 1 + randInt(rng, SUPER_POOL),
  }));
}

describe("superPosterior", () => {
  const post = superPosterior(history(900, 5));

  test("covers all sixteen balls and sums to one", () => {
    expect(post).toHaveLength(SUPER_POOL);
    expect(post.reduce((a, p) => a + p.mean, 0)).toBeCloseTo(1, 10);
  });

  test("finds no distinguishable ball in a fair machine", () => {
    expect(post.every((p) => !p.distinguishable)).toBe(true);
  });

  test("a stronger prior shrinks every estimate towards 1/16", () => {
    const weak = superPosterior(history(900, 5), 1);
    const strong = superPosterior(history(900, 5), 500);
    const spread = (rows: { mean: number }[]) =>
      Math.max(...rows.map((r) => r.mean)) - Math.min(...rows.map((r) => r.mean));
    expect(spread(strong)).toBeLessThan(spread(weak));
  });

  test("detects a genuinely loaded ball", () => {
    // Ball 4 comes up in a third of draws: a bias this size must be caught.
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const loaded = superPosterior(rigged).find((p) => p.ball === 4)!;
    expect(loaded.distinguishable).toBe(true);
    expect(loaded.low).toBeGreaterThan(1 / SUPER_POOL);
  });
});

describe("planSuperCoverage", () => {
  const draws = history(900, 5);

  test("hit probability is exactly tickets/16", () => {
    for (const n of [1, 2, 3, 5, 16]) {
      expect(planSuperCoverage(draws, n).hitProbability).toBeCloseTo(n / SUPER_POOL, 12);
    }
  });

  test("never repeats a ball — a duplicate would waste a ticket", () => {
    const plan = planSuperCoverage(draws, 6);
    expect(new Set(plan.balls).size).toBe(6);
  });

  test("cannot promise more than certainty", () => {
    const plan = planSuperCoverage(draws, 40);
    expect(plan.balls).toHaveLength(SUPER_POOL);
    expect(plan.hitProbability).toBe(1);
  });

  test("ranks by posterior mean when a ball is genuinely distinguishable", () => {
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const plan = planSuperCoverage(rigged, 1);
    expect(plan.balls[0]).toBe(4);
    expect(plan.rule).toBe("posterior");
  });

  test("a loaded ball outranks an unplayed one — the objective comes first", () => {
    // Ball 4 is loaded *and* the most played. Hitting it is likelier, so the
    // crowd tiebreak must not be allowed to overrule that.
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const crowdLovesFour = Array.from({ length: SUPER_POOL }, (_, i) => (i === 3 ? 0.4 : 0.04));
    const plan = planSuperCoverage(rigged, 1, { superWeights: crowdLovesFour });
    expect(plan.balls[0]).toBe(4);
    expect(plan.rule).toBe("posterior");
  });

  test("by default ranks by posterior mean even when nothing is distinguishable", () => {
    const crowd = Array.from({ length: SUPER_POOL }, (_, i) => (i + 1) / 136);
    const plan = planSuperCoverage(draws, 3, { superWeights: crowd });
    expect(plan.rule).toBe("posterior");
    const means = superPosterior(draws).sort((a, b) => b.mean - a.mean);
    expect(plan.balls).toEqual(means.slice(0, 3).map((p) => p.ball));
  });

  test("only prefers the balls fewest people play when asked to", () => {
    const crowd = Array.from({ length: SUPER_POOL }, (_, i) => (i + 1) / 136);
    const plan = planSuperCoverage(draws, 3, { tiebreak: "least-played", superWeights: crowd });
    expect(plan.rule).toBe("least-played");
    expect(plan.balls).toEqual([1, 2, 3]);
    expect(plan.crowding).toBeLessThan(1);
    // and it costs nothing on the stated objective
    expect(plan.hitProbability).toBeCloseTo(3 / SUPER_POOL, 12);
  });

  test("says so when asked for a crowd tiebreak without a crowd model", () => {
    const plan = planSuperCoverage(draws, 3, { tiebreak: "least-played" });
    expect(plan.rule).toBe("arbitrary");
    expect(plan.crowding).toBe(1);
  });

  test("still accepts a bare prior strength, as it used to", () => {
    expect(planSuperCoverage(draws, 3, 500).hitProbability).toBeCloseTo(3 / SUPER_POOL, 12);
  });

  test("reports how flat the posterior is", () => {
    // On a fair machine the best-to-worst spread stays small.
    expect(planSuperCoverage(draws, 3).spreadPoints).toBeLessThan(5);
    expect(planSuperCoverage(draws, 3).distinguishable).toHaveLength(0);
  });
});

describe("scoreSuperRules", () => {
  const draws = history(900, 5);
  const rules = [
    { name: "fixed", choose: (_: Draw[], n: number) => [1, 2, 3].slice(0, n) },
    { name: "hottest", choose: (past: Draw[], n: number) =>
        superPosterior(past).sort((a, b) => b.mean - a.mean).slice(0, n).map((p) => p.ball) },
    { name: "coldest", choose: (past: Draw[], n: number) =>
        superPosterior(past).sort((a, b) => a.mean - b.mean).slice(0, n).map((p) => p.ball) },
  ];

  test("no rule beats chance on a fair machine", () => {
    const scores = scoreSuperRules(draws, rules, 3, 400);
    expect(scores.every((s) => !s.beatsChance)).toBe(true);
    for (const s of scores) expect(s.rate).toBeCloseTo(3 / SUPER_POOL, 1);
  });

  test("scores every rule over the same draws", () => {
    const scores = scoreSuperRules(draws, rules, 3, 400);
    expect(scores).toHaveLength(rules.length);
    expect(new Set(scores.map((s) => s.draws)).size).toBe(1);
    expect(scores[0]!.draws).toBe(500);
  });

  test("catches a rule that really does know something", () => {
    // Ball 4 in a third of draws, and a rule that plays it.
    const rigged = history(600, 9, (i) => (i % 3 === 0 ? 4 : 1 + ((i * 7) % SUPER_POOL)));
    const [cheat] = scoreSuperRules(rigged, [
      { name: "plays 4", choose: () => [4] },
    ], 1, 300);
    expect(cheat!.beatsChance).toBe(true);
    expect(cheat!.rate).toBeGreaterThan(0.25);
  });

  test("the multiple-comparison threshold widens with the field", () => {
    // The same rule, entered once against entered twenty times.
    const one = { name: "fixed", choose: (_: Draw[], n: number) => [1, 2, 3].slice(0, n) };
    const alone = scoreSuperRules(draws, [one], 3, 400)[0]!;
    const crowded = scoreSuperRules(draws, Array.from({ length: 20 }, (_, i) => ({
      ...one, name: `fixed-${i}`,
    })), 3, 400)[0]!;
    expect(crowded.z).toBeCloseTo(alone.z, 10);
    expect(crowded.beatsChance || !alone.beatsChance).toBe(true);
  });
});

describe("standardSuperRules", () => {
  const draws = history(900, 5);

  test("every rule plays distinct balls, exactly as many as asked", () => {
    const crowd = Array.from({ length: SUPER_POOL }, (_, i) => (i + 1) / 136);
    for (const rule of standardSuperRules(1, crowd)) {
      for (const n of [1, 3, 5]) {
        const balls = rule.choose(draws.slice(0, 500), n);
        expect(balls).toHaveLength(n);
        expect(new Set(balls).size).toBe(n);
        for (const b of balls) expect(b >= 1 && b <= SUPER_POOL).toBe(true);
      }
    }
  });

  test("'repeat the last drawn' really plays the most recent ball first", () => {
    const rule = standardSuperRules().find((r) => r.name === "repeat the last drawn")!;
    const tail = draws.slice(0, 500);
    expect(rule.choose(tail, 1)).toEqual([tail[tail.length - 1]!.super]);
  });

  test("'persist' plays the balls seen twice in the last four, then fills by posterior", () => {
    const rule = standardSuperRules().find((r) => r.name.startsWith("persist"))!;
    const tail = [...draws.slice(0, 496), ...draws.slice(0, 4).map((d) => ({ ...d, super: 9 }))];
    const balls = rule.choose(tail, 3);
    expect(balls[0]).toBe(9);
    expect(new Set(balls).size).toBe(3);
  });

  test("leaves the crowd rule out when there is no crowd model", () => {
    const names = standardSuperRules().map((r) => r.name);
    expect(names.some((n) => n.includes("crowd"))).toBe(false);
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  test("none of the folk systems beats chance on a fair machine", () => {
    const scores = scoreSuperRules(draws, standardSuperRules(), 3, 400);
    expect(scores.every((s) => !s.beatsChance)).toBe(true);
  });
});

describe("winAnythingProbability", () => {
  test("one ticket reaches three main matches in 7 221 of 962 598 ways", () => {
    expect(atLeastThreeMain() * 962_598).toBeCloseTo(7_221, 6);
  });

  test("three disjoint tickets with distinct Súper Balotas: 3 169 413 / 15 401 568", () => {
    expect(winAnythingProbability(3)).toBeCloseTo(3_169_413 / 15_401_568, 12);
  });

  test("grows with tickets and never exceeds certainty", () => {
    expect(winAnythingProbability(1)).toBeLessThan(winAnythingProbability(2));
    expect(winAnythingProbability(2)).toBeLessThan(winAnythingProbability(3));
    expect(winAnythingProbability(16)).toBe(1);
    expect(winAnythingProbability(0)).toBe(0);
  });
});

describe("nightCoverage", () => {
  test("without Revancha it is the single-draw arithmetic at $6.000 a ticket", () => {
    for (const n of [1, 2, 3, 6]) {
      const night = nightCoverage(n, false);
      expect(night.draws).toBe(1);
      expect(night.superHit).toBeCloseTo(n / SUPER_POOL, 12);
      expect(night.winAnything).toBeCloseTo(winAnythingProbability(n), 12);
      expect(night.cost).toBe(6_000 * n);
    }
  });

  test("Revancha gives every ticket a second independent try: 1 − (1 − n/16)²", () => {
    // Exact sixteenths squared: 31/256, 60/256, 87/256, 112/256, 135/256, 156/256.
    const exact = [31, 60, 87, 112, 135, 156];
    exact.forEach((numerator, i) => {
      const night = nightCoverage(i + 1, true);
      expect(night.draws).toBe(2);
      expect(night.superHit).toBeCloseTo(numerator / 256, 12);
      expect(night.cost).toBe(9_000 * (i + 1));
    });
  });

  test("P(win anything) with Revancha is 1 − (1 − W)² on the exact single-draw W", () => {
    // Three disjoint tickets miss everything in one draw with probability
    // 12 232 155 / 15 401 568; with Revancha they must miss twice.
    const miss = 12_232_155 / 15_401_568;
    expect(nightCoverage(3, true).winAnything).toBeCloseTo(1 - miss * miss, 12);
  });

  test("the same $18.000 buys more hit with two Revancha tickets than three plain ones", () => {
    const { without, withRevancha } = nightCoverageForBudget(18_000);
    expect(without.tickets).toBe(3);
    expect(withRevancha.tickets).toBe(2);
    expect(without.cost).toBe(18_000);
    expect(withRevancha.cost).toBe(18_000);
    expect(without.superHit).toBeCloseTo(0.1875, 12);
    expect(withRevancha.superHit).toBeCloseTo(60 / 256, 12); // 23.4375 %
    expect(withRevancha.winAnything).toBeGreaterThan(without.winAnything);
  });

  test("per peso, Revancha wins up to seven tickets, ties at eight and loses after", () => {
    // n tickets with Revancha cost the same as 1.5n plain tickets:
    // 1 − (1 − n/16)² − 1.5n/16 = n(8 − n)/256, as long as 1.5n ≤ 16 balls.
    for (let n = 2; n <= 10; n += 2) {
      const doubled = nightCoverage(n, true);
      const plain = nightCoverage((3 * n) / 2, false);
      expect(doubled.cost).toBe(plain.cost);
      const gap = doubled.superHit - plain.superHit;
      expect(gap).toBeCloseTo((n * (8 - n)) / 256, 12);
    }
    expect(nightCoverage(8, true).superHit).toBeCloseTo(0.75, 12);
    expect(nightCoverage(12, false).superHit).toBeCloseTo(0.75, 12);
    // Past sixteen plain tickets the single draw is a certainty; two draws never are.
    expect(nightCoverage(18, false).superHit).toBe(1);
    expect(nightCoverage(12, true).superHit).toBeLessThan(1);
  });

  test("never promises more than certainty and costs nothing for no tickets", () => {
    expect(nightCoverage(16, true).superHit).toBe(1);
    expect(nightCoverage(0, true)).toMatchObject({ superHit: 0, winAnything: 0, cost: 0 });
  });

  test("agrees with a Monte Carlo of both draws, scored with the real prize tiers", () => {
    // Disjoint main numbers, distinct Súper Balotas, two independent fair
    // draws per night when Revancha is on. The simulation knows nothing of
    // the closed form: it classifies every ticket against every draw.
    const simulate = (n: number, revancha: boolean, nights: number, seed: number) => {
      const rng = makeRng(seed);
      const buffer = new Int32Array(MAIN_POOL);
      const tickets = Array.from({ length: n }, (_, i) => ({
        main: [1, 2, 3, 4, 5].map((k) => k + MAIN_PICK * i),
        super: i + 1,
      }));
      let superHits = 0;
      let wins = 0;
      for (let night = 0; night < nights; night++) {
        let hit = false;
        let won = false;
        for (let d = 0; d < (revancha ? 2 : 1); d++) {
          const drawn = { main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer), super: 1 + randInt(rng, SUPER_POOL) };
          for (const t of tickets) {
            if (t.super === drawn.super) hit = true;
            if (classify(t, drawn) !== null) won = true;
          }
        }
        if (hit) superHits++;
        if (won) wins++;
      }
      return { superHit: superHits / nights, winAnything: wins / nights };
    };
    const nights = 60_000;
    for (const [n, revancha, seed] of [[3, false, 11], [3, true, 12], [2, true, 13]] as const) {
      const exact = nightCoverage(n, revancha);
      const mc = simulate(n, revancha, nights, seed);
      // Four standard errors either side: a false failure once in 16 000 runs.
      const se = (p: number) => Math.sqrt((p * (1 - p)) / nights);
      expect(Math.abs(mc.superHit - exact.superHit)).toBeLessThan(4 * se(exact.superHit));
      expect(Math.abs(mc.winAnything - exact.winAnything)).toBeLessThan(4 * se(exact.winAnything));
    }
  });
});
