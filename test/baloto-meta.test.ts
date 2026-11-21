import { describe, expect, test } from "bun:test";
import type { Draw } from "../src/baloto/dataset.ts";
import { SuperChoiceCache, leaderIndex, metaSuperRules } from "../src/baloto/meta.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import { bonferroniZ, scoreSuperRules, standardSuperRules, type SuperRule } from "../src/baloto/superball.ts";

function history(count: number, seed: number, rigSuper?: (rng: () => number, i: number) => number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-${String(1 + Math.floor(i / 28) % 12).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: rigSuper ? rigSuper(rng, i) : 1 + randInt(rng, SUPER_POOL),
  }));
}

/** Ball 4 in 30 % of draws, the other fifteen sharing the rest evenly. */
const loaded = (rng: () => number): number => (rng() < 0.3 ? 4 : 1 + ((randInt(rng, SUPER_POOL - 1) + 4) % SUPER_POOL));

const legal = (balls: number[], n: number) => {
  expect(balls).toHaveLength(n);
  expect(new Set(balls).size).toBe(n);
  for (const b of balls) {
    expect(Number.isInteger(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(SUPER_POOL);
  }
};

describe("metaSuperRules", () => {
  const base = standardSuperRules();
  const fair = history(900, 5);

  test("enters the five intuitive meta-rules", () => {
    const names = metaSuperRules(base).map((r) => r.name);
    expect(names).toHaveLength(5);
    expect(names.filter((n) => n.includes("follow the leader"))).toHaveLength(1);
    expect(names.filter((n) => n.includes("Bayesian average"))).toHaveLength(2);
    expect(names.filter((n) => n.includes("contrarian"))).toHaveLength(1);
    expect(names.filter((n) => n.includes("recency ensemble"))).toHaveLength(1);
  });

  test("every meta-rule plays n distinct legal balls at every ticket count and history length", () => {
    const rules = metaSuperRules(base);
    for (const n of [1, 2, 3, 5, 16]) {
      for (const len of [0, 1, 49, 50, 51, 400, 900]) {
        for (const rule of rules) legal(rule.choose(fair.slice(0, len), n), n);
      }
    }
  });

  test("the contrarian never plays what the leader plays", () => {
    const cache = new SuperChoiceCache(base);
    const [leader, , , contrarian] = metaSuperRules(base, { cache });
    for (const len of [100, 400, 700, 899]) {
      const past = fair.slice(0, len);
      const lead = new Set(leader!.choose(past, 3));
      for (const b of contrarian!.choose(past, 3)) expect(lead.has(b)).toBe(false);
    }
  });

  test("follow the leader plays exactly what the leading base rule plays", () => {
    const cache = new SuperChoiceCache(base);
    const [follow] = metaSuperRules(base, { cache });
    const past = fair.slice(0, 600);
    const { hits } = cache.record(past, 3);
    const leader = base[leaderIndex(base, hits)]!;
    expect(follow!.choose(past, 3)).toEqual(leader.choose(past, 3).slice(0, 3));
  });

  test("the nested record is a true walk-forward: it only counts draws already in the past", () => {
    const cache = new SuperChoiceCache(base, 50);
    expect(cache.record(fair.slice(0, 50), 3).trials).toBe(0);
    const { hits, trials } = cache.record(fair.slice(0, 300), 3);
    expect(trials).toBe(250);
    // Recompute the record by hand for one rule, from scratch.
    const fixed = base.findIndex((r) => r.name === "fixed 1-2-3");
    let byHand = 0;
    for (let k = 50; k < 300; k++) if (fair[k]!.super <= 3) byHand++;
    expect(hits[fixed]).toBe(byHand);
    // and one more draw in the past adds exactly that draw's verdict
    const next = cache.record(fair.slice(0, 301), 3);
    expect(next.trials).toBe(251);
    expect(next.hits[fixed]).toBe(byHand + (fair[300]!.super <= 3 ? 1 : 0));
  });

  test("the cache flushes when handed a different history rather than answering for the wrong draws", () => {
    const cache = new SuperChoiceCache(base, 50);
    const a = cache.record(fair.slice(0, 300), 3).hits;
    const other = history(300, 77);
    const b = cache.record(other, 3).hits;
    const fresh = new SuperChoiceCache(base, 50).record(other, 3).hits;
    expect(b).toEqual(fresh);
    expect(a).not.toEqual(b);
  });

  test("the cached base rules answer exactly as the originals", () => {
    const cache = new SuperChoiceCache(base);
    const cached = cache.cached();
    for (const len of [0, 10, 400, 899]) {
      const past = fair.slice(0, len);
      cached.forEach((rule, r) => expect(rule.choose(past, 3)).toEqual(base[r]!.choose(past, 3).slice(0, 3)));
    }
  });

  test("on a fair machine no meta-rule beats chance, and the threshold grows with the field", () => {
    const cache = new SuperChoiceCache(base);
    const rules = [...cache.cached(), ...metaSuperRules(base, { cache })];
    const scores = scoreSuperRules(fair, rules, 3, 400);
    expect(scores).toHaveLength(base.length + 5);
    for (const s of scores) {
      expect(s.draws).toBe(500);
      // A meta-rule always covers exactly n distinct balls, so its null is
      // exactly 3/16 per draw (a base rule such as "repeat the last drawn" may
      // cover fewer when the last six draws repeat, and is scored for that).
      if (s.name.startsWith("meta:")) expect(s.expected).toBeCloseTo((500 * 3) / SUPER_POOL, 9);
      expect(Math.abs(s.z)).toBeLessThan(bonferroniZ(rules.length));
      expect(s.beatsChance).toBe(false);
    }
  });

  test("with a ball loaded to 30 %, follow the leader ends up playing it", () => {
    const rigged = history(700, 11, loaded);
    const cache = new SuperChoiceCache(base);
    const [follow, bayesHalf, bayesOne] = metaSuperRules(base, { cache });
    for (const len of [500, 600, 699]) {
      expect(follow!.choose(rigged.slice(0, len), 3)).toContain(4);
      expect(bayesHalf!.choose(rigged.slice(0, len), 3)).toContain(4);
      expect(bayesOne!.choose(rigged.slice(0, len), 3)).toContain(4);
    }
    // and the tournament sees it: the leader-follower clears the threshold
    // along with the hot rule it ends up copying.
    const scores = scoreSuperRules(rigged, [...cache.cached(), ...metaSuperRules(base, { cache })], 3, 300);
    const followScore = scores.find((s) => s.name.includes("follow the leader"))!;
    expect(followScore.beatsChance).toBe(true);
    expect(followScore.rate).toBeGreaterThan(0.3);
  });

  test("is a no-op on an empty base and omits the recency ensemble when its parts are missing", () => {
    const only: SuperRule[] = [{ name: "fixed", choose: (_, n) => [1, 2, 3].slice(0, n) }];
    const rules = metaSuperRules(only);
    expect(rules.some((r) => r.name.includes("recency"))).toBe(false);
    for (const rule of rules) legal(rule.choose(fair.slice(0, 100), 3), 3);
    for (const rule of metaSuperRules([])) legal(rule.choose(fair.slice(0, 100), 3), 3);
  });
});
