import { expect, test, describe } from "bun:test";
import {
  crossGameDependence,
  fitHmm,
  fitIid,
  hmmPredictive,
  hmmSuperRule,
  regimeEvidence,
} from "../src/baloto/regime.ts";
import { scoreSuperRules } from "../src/baloto/superball.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

function fair(count: number, seed: number, game: "baloto" | "revancha" = "baloto"): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    game,
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: 1 + randInt(rng, SUPER_POOL),
  }));
}

/** Two regimes of 300 draws each: balls 1–8 favoured, then balls 9–16. */
function regimes(seed: number): Draw[] {
  const rng = makeRng(seed);
  return fair(600, seed).map((d, i) => {
    const low = i < 300;
    const biased = rng() < 0.7;
    const ball = biased ? (low ? 1 + randInt(rng, 8) : 9 + randInt(rng, 8)) : 1 + randInt(rng, SUPER_POOL);
    return { ...d, super: ball };
  });
}

describe("fitIid / fitHmm", () => {
  test("the HMM never has a worse likelihood than i.i.d., and BIC charges it for parameters", () => {
    const seq = fair(600, 3).map((d) => d.super);
    const iid = fitIid(seq, SUPER_POOL);
    const hmm = fitHmm(seq, SUPER_POOL, 2, { iterations: 40, restarts: 2 });
    expect(hmm.logLikelihood).toBeGreaterThanOrEqual(iid.logLikelihood - 1e-6);
    expect(hmm.parameters).toBe(33);
    expect(iid.parameters).toBe(15);
    expect(hmm.transition.every((row) => Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9)).toBe(true);
    expect(hmm.emission.every((row) => Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9)).toBe(true);
  });

  test("on a fair machine BIC does not favour regimes", () => {
    const ev = regimeEvidence(fair(900, 5));
    expect(ev.favoursRegimes).toBe(false);
  }, 60_000);

  test("finds two planted regimes and separates their emissions", () => {
    const ev = regimeEvidence(regimes(11));
    expect(ev.favoursRegimes).toBe(true);
    expect(ev.deltaBic).toBeGreaterThan(50);
    expect(ev.stateSeparation).toBeGreaterThan(0.4);
    // Viterbi should split the history roughly in half.
    expect(Math.min(...ev.occupancy)).toBeGreaterThan(0.3);
  }, 60_000);

  test("the predictive distribution is a distribution and leans the right way", () => {
    const draws = regimes(11);
    const fit = fitHmm(draws.map((d) => d.super), SUPER_POOL, 2, { iterations: 60, restarts: 3 });
    const pred = hmmPredictive(fit);
    expect(pred.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // The history ends in the high regime: mass on 9–16 should exceed mass on 1–8.
    const high = pred.slice(8).reduce((a, b) => a + b, 0);
    expect(high).toBeGreaterThan(0.5);
  }, 60_000);
});

describe("hmmSuperRule", () => {
  test("plays distinct legal balls and does not beat chance on a fair machine", () => {
    const draws = fair(800, 9);
    const rule = hmmSuperRule();
    const balls = rule.choose(draws.slice(0, 400), 3);
    expect(balls).toHaveLength(3);
    expect(new Set(balls).size).toBe(3);
    const [score] = scoreSuperRules(draws, [rule], 3, 500);
    expect(score!.beatsChance).toBe(false);
  }, 120_000);
});

describe("crossGameDependence", () => {
  test("two independent machines look independent", () => {
    const b = fair(800, 21, "baloto");
    const r = fair(800, 22, "revancha");
    const dep = crossGameDependence(b, r, 400);
    expect(dep.pairs).toBe(800);
    expect(dep.pValue).toBeGreaterThan(0.01);
    expect(dep.sameSuperExpected).toBeCloseTo(50, 6);
  });

  test("a Revancha that copies Baloto is caught", () => {
    const b = fair(800, 21, "baloto");
    const r = b.map((d, i) => ({ ...d, game: "revancha" as const, super: i % 3 === 0 ? 1 + ((d.super + 2) % SUPER_POOL) : d.super }));
    const dep = crossGameDependence(b, r, 400);
    expect(dep.pValue).toBeLessThan(0.01);
    expect(dep.sameSuperPValue).toBeLessThan(0.01);
  });
});
