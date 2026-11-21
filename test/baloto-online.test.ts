import { describe, expect, test } from "bun:test";
import type { Draw } from "../src/baloto/dataset.ts";
import { changePoint, ctw, onlineSuperRules, thompsonSample } from "../src/baloto/online.ts";
import { SuperChoiceCache, metaSuperRules, trackingSuperRules, trackingWeights } from "../src/baloto/meta.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import { scoreSuperRules, standardSuperRules, type SuperRule } from "../src/baloto/superball.ts";

/** A history whose Súper Balota comes from `next`, which may look at the balls already drawn. */
function history(count: number, seed: number, next?: (rng: () => number, supers: number[], i: number) => number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const supers: number[] = [];
  return Array.from({ length: count }, (_, i) => {
    const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
    const s = next ? next(rng, supers, i) : 1 + randInt(rng, SUPER_POOL);
    supers.push(s);
    return {
      date: `20${String(18 + Math.floor(i / 336)).padStart(2, "0")}-${String(1 + (Math.floor(i / 28) % 12)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      game: "baloto" as const,
      main,
      super: s,
    };
  });
}
const fairBall = (rng: () => number): number => 1 + randInt(rng, SUPER_POOL);
/** `ball` with probability `p`, the other fifteen sharing the rest evenly. */
const loaded = (ball: number, p: number) => (rng: () => number): number =>
  rng() < p ? ball : 1 + ((ball + randInt(rng, SUPER_POOL - 1)) % SUPER_POOL);
const supersOf = (draws: Draw[]) => draws.map((d) => d.super);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const byName = (rules: SuperRule[], fragment: string) => rules.find((r) => r.name.includes(fragment))!;

const legal = (balls: number[], n: number) => {
  expect(balls).toHaveLength(n);
  expect(new Set(balls).size).toBe(n);
  for (const b of balls) {
    expect(Number.isInteger(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(SUPER_POOL);
  }
};

describe("context-tree weighting", () => {
  const fair = supersOf(history(800, 3));

  test("is a probability assignment at every depth and history length", () => {
    for (const depth of [0, 1, 2, 3]) {
      for (const len of [0, 1, 2, 3, 50, 500]) {
        const { probs } = ctw(fair.slice(0, len), SUPER_POOL, depth);
        expect(probs).toHaveLength(SUPER_POOL);
        expect(sum(probs)).toBeCloseTo(1, 9);
        for (const p of probs) expect(p).toBeGreaterThan(0);
      }
    }
  });

  test("at depth 0 it is the Krichevsky–Trofimov estimator", () => {
    const seq = fair.slice(0, 300);
    const counts = new Array<number>(SUPER_POOL).fill(0);
    for (const s of seq) counts[s - 1]!++;
    const report = ctw(seq, SUPER_POOL, 0);
    report.probs.forEach((p, i) => expect(p).toBeCloseTo((counts[i]! + 0.5) / (300 + SUPER_POOL / 2), 12));
    expect(report.codeLength).toBeCloseTo(report.memorylessCodeLength, 9);
    expect(report.memorylessWeight).toBe(1);
  });

  test("the code length of a sequence is the sum of its own one-step losses", () => {
    // The chain rule: if the predictive were anything but the ratio of
    // weighted probabilities, these two would disagree.
    const seq = supersOf(history(140, 8, (rng, s) => (s.length > 0 && rng() < 0.4 ? (s[s.length - 1]! % SUPER_POOL) + 1 : fairBall(rng))));
    let stepwise = 0;
    for (let t = 0; t < seq.length; t++) stepwise -= Math.log(ctw(seq.slice(0, t)).probs[seq[t]! - 1]!);
    expect(ctw(seq).codeLength).toBeCloseTo(stepwise, 6);
  });

  test("finds planted first-order memory, and says how sure it is", () => {
    // Half the time the ball is the successor of the previous one.
    const draws = history(700, 11, (rng, s) => (s.length > 0 && rng() < 0.5 ? (s[s.length - 1]! % SUPER_POOL) + 1 : fairBall(rng)));
    const seq = supersOf(draws);
    const report = ctw(seq);
    const successor = seq[seq.length - 1]! % SUPER_POOL; // index of (last % 16) + 1
    expect(report.probs[successor]!).toBeGreaterThan(0.35);
    expect(report.memorylessWeight).toBeLessThan(1e-9);
    expect(report.codeLength).toBeLessThan(report.uniformCodeLength - 150);
    const [learner, hot] = scoreSuperRules(draws, [byName(onlineSuperRules(), "context-tree"), byName(standardSuperRules(), "highest posterior")], 1, 300);
    expect(learner!.beatsChance).toBe(true);
    expect(learner!.rate).toBeGreaterThan(0.4);
    expect(Math.abs(hot!.z)).toBeLessThan(3);
  });

  test("finds memory two draws back, which a first-order model cannot see", () => {
    const draws = history(1400, 13, (rng, s) => (s.length > 1 && rng() < 0.6 ? (s[s.length - 2]! % SUPER_POOL) + 1 : fairBall(rng)));
    const seq = supersOf(draws);
    const target = seq[seq.length - 2]! % SUPER_POOL;
    // 256 two-ball contexts share 1 400 draws, about five each, so the estimate
    // is still half prior: four times the 1/16 of chance, not yet the 62 % it is.
    expect(ctw(seq, SUPER_POOL, 2).probs[target]!).toBeGreaterThan(0.2);
    expect(ctw(seq, SUPER_POOL, 1).probs[target]!).toBeLessThan(0.1);
    const [learner] = scoreSuperRules(draws, [byName(onlineSuperRules(), "context-tree")], 1, 900);
    expect(learner!.beatsChance).toBe(true);
    expect(learner!.rate).toBeGreaterThan(0.4);
  });

  test("on a fair machine it falls back on the memoryless estimate and plays the most frequent balls", () => {
    const report = ctw(fair);
    expect(report.memorylessWeight).toBeGreaterThan(0.999999);
    const counts = new Array<number>(SUPER_POOL).fill(0);
    for (const s of fair) counts[s - 1]!++;
    const frequent = counts.map((c, i) => ({ ball: i + 1, c })).sort((a, b) => b.c - a.c || a.ball - b.ball).slice(0, 3).map((x) => x.ball);
    expect(byName(onlineSuperRules(), "context-tree").choose(history(800, 3), 3)).toEqual(frequent);
    // It pays for the memory it did not find: more bits than a coder told the balls are equally likely.
    expect(report.codeLength).toBeGreaterThan(report.uniformCodeLength);
  });
});

describe("Bayesian online change-point detection", () => {
  test("the forecast and the run-length posterior are distributions", () => {
    const fair = supersOf(history(400, 5));
    for (const len of [0, 1, 2, 10, 400]) {
      const report = changePoint(fair.slice(0, len));
      expect(sum(report.probs)).toBeCloseTo(1, 9);
      for (const p of report.probs) expect(p).toBeGreaterThan(0);
      expect(report.runLength).toBeGreaterThanOrEqual(0);
      expect(report.runLength).toBeLessThanOrEqual(len);
      expect(report.recentChange).toBeGreaterThanOrEqual(0);
      expect(report.recentChange).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(changePoint([]).probs.every((p) => Math.abs(p - 1 / SUPER_POOL) < 1e-12)).toBe(true);
  });

  test("on a fair machine it sees no more change than its prior expects", () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const reports = seeds.map((s) => changePoint(supersOf(history(600, s))));
    const mean = sum(reports.map((r) => r.recentChange)) / seeds.length;
    expect(reports[0]!.recentChangePrior).toBeCloseTo(1 - (199 / 200) ** 50, 12);
    expect(mean).toBeLessThan(reports[0]!.recentChangePrior);
    // …and its belief sits on one long regime: most of the 600 draws.
    expect(sum(reports.map((r) => r.runLength)) / seeds.length).toBeGreaterThan(400);
  });

  test("sees a planted change, dates it, and rebuilds the forecast from the draws since", () => {
    // Ball 3 at 30 % for 400 draws, then ball 12 at 40 % for the last 150.
    const draws = history(550, 9, (rng, _s, i) => (i < 400 ? loaded(3, 0.3)(rng) : loaded(12, 0.4)(rng)));
    const report = changePoint(supersOf(draws), SUPER_POOL, 1 / 200, 1, 200);
    expect(report.recentChange).toBeGreaterThan(0.95);
    expect(Math.abs(report.runLength - 150)).toBeLessThan(30);
    expect(report.probs[11]!).toBeGreaterThan(0.25);
    expect(report.probs[2]!).toBeLessThan(0.1);
    // The all-time count still has ball 3 on top; the learner has moved on.
    const rules = [byName(onlineSuperRules(), "change-point"), byName(standardSuperRules(), "highest posterior")];
    expect(rules[0]!.choose(draws, 1)).toEqual([12]);
    expect(rules[1]!.choose(draws, 1)).toEqual([3]);
    const [learner, hot] = scoreSuperRules(draws, rules, 1, 440);
    expect(learner!.hits).toBeGreaterThan(3 * Math.max(1, hot!.hits));
  });
});

describe("Thompson sampling", () => {
  test("a sample is a distribution, and the same history always gives the same one", () => {
    const fair = supersOf(history(500, 4));
    const a = thompsonSample(fair);
    expect(sum(a)).toBeCloseTo(1, 12);
    for (const p of a) expect(p).toBeGreaterThan(0);
    expect(thompsonSample(fair)).toEqual(a);
    expect(thompsonSample(fair.slice(0, 499))).not.toEqual(a);
  });

  test("samples scatter around the posterior mean with the posterior's own spread", () => {
    // 2 000 different histories of the same machine would each give one sample;
    // here one history, re-seeded by appending to it, stands in for that.
    const base = supersOf(history(400, 6, loaded(4, 0.3)));
    const samples: number[] = [];
    for (let k = 0; k < 400; k++) samples.push(thompsonSample([...base, ...new Array<number>(k % 7).fill(9), 1 + (k % SUPER_POOL)])[3]!);
    const mean = sum(samples) / samples.length;
    const sd = Math.sqrt(sum(samples.map((x) => (x - mean) ** 2)) / samples.length);
    expect(mean).toBeGreaterThan(0.25);
    expect(mean).toBeLessThan(0.34);
    // Beta sd near sqrt(0.3 · 0.7 / 420) ≈ 0.022
    expect(sd).toBeGreaterThan(0.012);
    expect(sd).toBeLessThan(0.035);
  });

  test("on a fair machine its balls change from night to night; on a loaded one it keeps the loaded ball", () => {
    const rule = byName(onlineSuperRules(), "Thompson");
    const fair = history(520, 2);
    const tops = new Set<number>();
    for (let len = 400; len < 520; len++) tops.add(rule.choose(fair.slice(0, len), 1)[0]!);
    expect(tops.size).toBeGreaterThan(6);
    const rigged = history(520, 2, loaded(4, 0.3));
    let kept = 0;
    for (let len = 400; len < 520; len++) if (rule.choose(rigged.slice(0, len), 1)[0] === 4) kept++;
    expect(kept).toBe(120);
  });
});

describe("onlineSuperRules", () => {
  const fair = history(900, 7);

  test("every learner plays n distinct legal balls at every ticket count and history length", () => {
    for (const rule of onlineSuperRules()) {
      for (const n of [1, 2, 3, 5, 16]) {
        for (const len of [0, 1, 2, 49, 400]) legal(rule.choose(fair.slice(0, len), n), n);
      }
    }
  });

  test("on a fair machine none of them beats chance", () => {
    const scores = scoreSuperRules(fair, onlineSuperRules(), 3, 400);
    expect(scores).toHaveLength(3);
    for (const s of scores) {
      expect(s.beatsChance).toBe(false);
      expect(s.expected).toBeCloseTo((500 * 3) / SUPER_POOL, 9);
    }
  });
});

describe("tracking the best rule (fixed share)", () => {
  const base = standardSuperRules();

  test("plays n distinct legal balls, and its weights are a distribution that starts uniform", () => {
    const fair = history(500, 12);
    const cache = new SuperChoiceCache(base);
    const [tracker] = trackingSuperRules(base, { cache });
    for (const n of [1, 2, 3, 16]) for (const len of [0, 1, 50, 51, 500]) legal(tracker!.choose(fair.slice(0, len), n), n);
    expect(trackingWeights(cache, fair.slice(0, 50), 3).every((w) => Math.abs(w - 1 / base.length) < 1e-12)).toBe(true);
    const weights = trackingWeights(cache, fair, 3);
    expect(sum(weights)).toBeCloseTo(1, 9);
    for (const w of weights) expect(w).toBeGreaterThanOrEqual(1 / 50 / base.length);
    expect(trackingSuperRules([])[0]!.choose(fair, 3)).toEqual([1, 2, 3]);
  });

  test("the per-draw hits it learns from add up to the nested record", () => {
    const fair = history(400, 12);
    const cache = new SuperChoiceCache(base);
    const rows = cache.hitsByDraw(fair, 3);
    const { hits, trials } = cache.record(fair, 3);
    expect(rows).toHaveLength(trials);
    base.forEach((_, r) => expect(sum(rows.map((row) => row[r]!))).toBe(hits[r]!));
    // Asking for a shorter history afterwards returns the same rows, cut short.
    expect(cache.hitsByDraw(fair.slice(0, 200), 3)).toEqual(rows.slice(0, 150));
  });

  test("follows the best rule through a switch the Bayesian average sleeps through", () => {
    // Two one-note experts and a machine that favours the first one's ball for
    // 500 draws, then the second one's for 150.
    const experts: SuperRule[] = [
      { name: "always 3", choose: (_p, n) => [3, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].slice(0, n) },
      { name: "always 12", choose: (_p, n) => [12, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 3, 13, 14, 15, 16].slice(0, n) },
    ];
    const draws = history(650, 21, (rng, _s, i) => (i < 500 ? loaded(3, 0.6)(rng) : loaded(12, 0.6)(rng)));
    const cache = new SuperChoiceCache(experts);
    const average = byName(metaSuperRules(experts, { cache }), "β = 0.5");
    const [tracker] = trackingSuperRules(experts, { cache });
    expect(average.choose(draws, 1)).toEqual([3]);
    expect(tracker!.choose(draws, 1)).toEqual([12]);
    const [a, t] = scoreSuperRules(draws, [average, tracker!], 1, 530);
    expect(t!.hits).toBeGreaterThan(50);
    expect(a!.hits).toBeLessThan(15);
    expect(trackingWeights(cache, draws, 1)[1]!).toBeGreaterThan(0.9);
  });

  test("on a fair machine it does not beat chance, entered as the tournament enters it", () => {
    // After the base rules and the other meta-rules, sharing their cache, so
    // the threshold is the field's and the base choices are computed once.
    const fair = history(900, 5);
    const cache = new SuperChoiceCache(base);
    const rules = [...cache.cached(), ...metaSuperRules(base, { cache }), ...trackingSuperRules(base, { cache })];
    const scores = scoreSuperRules(fair, rules, 3, 400);
    const tracker = scores[scores.length - 1]!;
    expect(tracker.name).toContain("tracking the best rule");
    expect(tracker.beatsChance).toBe(false);
    expect(tracker.expected).toBeCloseTo((500 * 3) / SUPER_POOL, 9);
    // Entering it does not move anyone else's record.
    const without = scoreSuperRules(fair, [...standardSuperRules(), ...metaSuperRules(standardSuperRules())], 3, 400);
    without.forEach((w, i) => expect(scores[i]!.hits).toBe(w.hits));
  });
});
