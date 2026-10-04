import { expect, test, describe } from "bun:test";
import {
  algorithmStrategies,
  algorithmSuperRules,
  describeLogistic,
  fisherGPValue,
  fitLogistic,
  logisticScores,
  periodograms,
} from "../src/baloto/algorithms.ts";
import { backtest } from "../src/baloto/backtest.ts";
import { scoreSuperRules } from "../src/baloto/superball.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function fair(count: number, seed: number): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    game: "baloto" as const,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: 1 + randInt(rng, SUPER_POOL),
  }));
}

/** A machine where ball 7 is in almost every draw — a bias no model should miss. */
function loaded(count: number, seed: number): Draw[] {
  return fair(count, seed).map((d, i) => {
    if (i % 5 === 0 || d.main.includes(7)) return d;
    const main = [...d.main.slice(0, 4), 7].sort((a, b) => a - b);
    return { ...d, main: [...new Set(main)].length === 5 ? main : d.main };
  });
}

/** A machine where ball 11 comes and goes on a strict 8-draw cycle. */
function periodic(count: number, seed: number): Draw[] {
  return fair(count, seed).map((d, i) => {
    const wants = i % 8 < 4;
    const has = d.main.includes(11);
    if (wants === has) return d;
    // Swap 11 in or out against a rotating partner so no other ball inherits
    // the cycle: the one dropped or inserted changes from draw to draw.
    let main: number[];
    if (wants) {
      main = d.main.filter((_, k) => k !== i % 5).concat(11);
    } else {
      let partner = ((i * 7) % MAIN_POOL) + 1;
      while (d.main.includes(partner) || partner === 11) partner = (partner % MAIN_POOL) + 1;
      main = d.main.map((n) => (n === 11 ? partner : n));
    }
    const unique = [...new Set(main)];
    return unique.length === 5 ? { ...d, main: unique.sort((a, b) => a - b) } : d;
  });
}

describe("algorithmStrategies", () => {
  const history = fair(400, 3);

  test("every strategy returns a legal ticket, deterministically for the same history", () => {
    const rng = makeRng(1);
    const buffer = new Int32Array(MAIN_POOL);
    for (const s of algorithmStrategies()) {
      const a = s.pick(history, rng, buffer);
      expect(a.main).toHaveLength(MAIN_PICK);
      expect(new Set(a.main).size).toBe(MAIN_PICK);
      for (const n of a.main) expect(n >= 1 && n <= MAIN_POOL).toBe(true);
      expect(a.super >= 1 && a.super <= SUPER_POOL).toBe(true);
      if (s.id !== "delta") {
        const b = s.pick(history, rng, buffer);
        expect(b.main).toEqual(a.main);
      }
    }
  });

  test("none of them beats chance on a fair machine", () => {
    const report = backtest(fair(700, 11), algorithmStrategies(), 300, 2);
    for (const r of report.results) {
      expect(Math.abs(r.z)).toBeLessThan(3.5);
    }
  }, 60_000);

  test("the logistic model does find a genuinely loaded ball", () => {
    const draws = loaded(600, 5);
    const model = fitLogistic(draws);
    const scores = logisticScores(model, draws);
    const best = scores
      .map((s, n) => ({ n, s }))
      .filter((x) => x.n >= 1)
      .sort((a, b) => b.s - a.s)[0]!;
    expect(best.n).toBe(7);
    // and the frequency weights carry the signal
    const described = describeLogistic(model);
    expect(described.find((c) => c.feature === "f200")!.weight).toBeGreaterThan(0);
  });

  test("the logistic fit converges to the penalised maximum likelihood, with standard errors", () => {
    const draws = fair(500, 3);
    const model = fitLogistic(draws);
    expect(model.iterations).toBeLessThan(10);
    expect(model.observations).toBe(470);
    // The intercept sits at the base rate of 5/43 and is sharply estimated;
    // every lag coefficient on a fair machine is inside two standard errors.
    const described = describeLogistic(model);
    expect(described[0]!.weight).toBeCloseTo(Math.log(5 / 38), 1);
    for (const c of described.slice(1)) {
      expect(c.standardError).toBeGreaterThan(0);
      expect(Math.abs(c.z)).toBeLessThan(2.5);
    }
    // More iterations change nothing: the optimum was reached.
    const longer = fitLogistic(draws, MAIN_POOL, (d) => d.main, { iterations: 100 });
    for (let i = 0; i < model.weights.length; i++) expect(longer.weights[i]).toBeCloseTo(model.weights[i]!, 8);
  });
});

describe("periodograms", () => {
  test("Fisher's g p-value is a probability that shrinks as g grows", () => {
    const m = 200;
    const a = fisherGPValue(0.02, m);
    const b = fisherGPValue(0.08, m);
    expect(a).toBeGreaterThan(b);
    expect(a).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(0);
    // ~1/m is the expected share for white noise: not significant
    expect(fisherGPValue(1 / m, m)).toBeGreaterThan(0.5);
  });

  test("Fisher's g p-value is the exact 1929 series where the series is stable", () => {
    // m = 10, g = 0.5: only j = 1 survives (1 − 2·0.5 = 0), so P = 10 · 0.5⁹ = 10/512.
    expect(fisherGPValue(0.5, 10)).toBeCloseTo(10 / 512, 12);
    // m = 10, g = 0.4: 10·0.6⁹ − 45·0.2⁹ = 0.1007539…
    expect(fisherGPValue(0.4, 10)).toBeCloseTo(10 * 0.6 ** 9 - 45 * 0.2 ** 9, 12);
    // The exponential approximation alone would have said 0.169 here.
    expect(Math.abs(fisherGPValue(0.4, 10) - 0.1688)).toBeGreaterThan(0.05);
    // m = 486 (a 974-draw series), g = 0.02: exact 2.7 %, approximation 2.9 %.
    const m = 486;
    const exact = Array.from({ length: Math.floor(1 / 0.02) }, (_, i) => i + 1).reduce((s, j) => {
      let logC = 0;
      for (let i = 1; i <= j; i++) logC += Math.log(m - j + i) - Math.log(i);
      const term = Math.exp(logC + (m - 1) * Math.log(1 - j * 0.02));
      return s + (j % 2 === 1 ? term : -term);
    }, 0);
    expect(fisherGPValue(0.02, m)).toBeCloseTo(exact, 10);
    expect(fisherGPValue(0.02, m)).toBeGreaterThan(0.026);
    expect(fisherGPValue(0.02, m)).toBeLessThan(0.028);
    // Still a probability, still decreasing in g, and ≈ 1 at the white-noise share.
    expect(fisherGPValue(1.2 / m, m)).toBeGreaterThan(0.999);
    let prev = 1.0000001;
    for (let g = 0.01; g < 0.1; g += 0.0005) {
      const p = fisherGPValue(g, m);
      expect(p).toBeLessThanOrEqual(prev + 1e-9);
      prev = p;
    }
  });

  test("the one-step projection of a planted cosine has the right sign and size", () => {
    // Ball 1 is present exactly when cos(ωt + φ) > 0, at a Fourier frequency.
    const n = 240;
    const k = 30;
    const omega = (2 * Math.PI * k) / n;
    for (const phi of [0.3, 1.1, 2.5, -0.8]) {
      const hist: Draw[] = Array.from({ length: n }, (_, t) => ({
        date: "2026-01-01",
        game: "baloto",
        main: Math.cos(omega * t + phi) > 0 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10],
        super: 1,
      }));
      const row = periodograms(hist, 10)[0]!;
      expect(row.period).toBeCloseTo(n / k, 6);
      // The fitted sinusoid at t = n is (2/n)·Σ c_t cos(ωt) — the cosine
      // coefficient — whose sign is that of cos(φ) for a square wave of this phase.
      expect(Math.sign(row.nextPhase)).toBe(Math.sign(Math.cos(phi)));
    }
  });

  test("finds no significant cycle in a fair machine", () => {
    const rows = periodograms(fair(600, 7));
    expect(rows).toHaveLength(MAIN_POOL);
    expect(rows.filter((r) => r.significant)).toHaveLength(0);
  });

  test("catches a planted 8-draw cycle, and only that one", () => {
    const rows = periodograms(periodic(600, 7));
    const eleven = rows.find((r) => r.ball === 11)!;
    expect(eleven.significant).toBe(true);
    expect(Math.abs(eleven.period - 8)).toBeLessThan(0.5);
    expect(rows.filter((r) => r.significant).map((r) => r.ball)).toEqual([11]);
  });
});

describe("algorithmSuperRules", () => {
  test("play distinct legal balls and do not beat chance on a fair machine", () => {
    const draws = fair(900, 9);
    for (const rule of algorithmSuperRules()) {
      const balls = rule.choose(draws.slice(0, 500), 3);
      expect(balls).toHaveLength(3);
      expect(new Set(balls).size).toBe(3);
    }
    const scores = scoreSuperRules(draws, algorithmSuperRules(), 3, 500);
    expect(scores.every((s) => !s.beatsChance)).toBe(true);
  }, 60_000);
});
