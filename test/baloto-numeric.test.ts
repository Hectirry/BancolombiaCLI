import { expect, test, describe } from "bun:test";
import {
  betaCdf,
  betaQuantile,
  logChoose,
  logGamma,
  normalCdf,
  normalQuantile,
  poissonBinomialPmf,
} from "../src/baloto/numeric.ts";

describe("normal distribution", () => {
  test("the quantile matches the textbook values to six decimals", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 6);
    // Φ⁻¹(1 − 0.025/16): the simultaneous quantile the Súper Balota intervals need.
    expect(normalQuantile(1 - 0.025 / 16)).toBeCloseTo(2.955167, 6);
    expect(normalQuantile(0.9986501019683699)).toBeCloseTo(3, 7);
  });

  test("the CDF is Abramowitz–Stegun accurate (7.5e-8) and inverts the quantile", () => {
    expect(Math.abs(normalCdf(1.96) - 0.97500210485)).toBeLessThan(7.5e-8);
    expect(Math.abs(normalCdf(-1.96) - 0.02499789515)).toBeLessThan(7.5e-8);
    expect(Math.abs(normalCdf(3) - 0.99865010197)).toBeLessThan(7.5e-8);
    for (const p of [0.001, 0.1, 0.5, 0.9, 0.9984375]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    }
  });
});

describe("beta distribution", () => {
  test("log-gamma and log-choose agree with the factorials", () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
    expect(Math.exp(logChoose(43, 5))).toBeCloseTo(962_598, 6);
    expect(logChoose(5, 6)).toBe(-Infinity);
  });

  test("the regularised incomplete beta has its closed-form values", () => {
    // Beta(2,3): I_x = 6x² − 8x³ + 3x⁴ → I_0.5 = 11/16.
    expect(betaCdf(0.5, 2, 3)).toBeCloseTo(11 / 16, 12);
    // Beta(1,1) is uniform.
    expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    expect(betaCdf(0, 2, 3)).toBe(0);
    expect(betaCdf(1, 2, 3)).toBe(1);
  });

  test("the quantile inverts the CDF, also at posterior-sized parameters", () => {
    for (const [a, b] of [
      [2, 3],
      [0.5, 0.5],
      [61, 929],
      [49, 941],
    ] as const) {
      for (const p of [0.0015625, 0.1, 0.5, 0.9, 0.9984375]) {
        const x = betaQuantile(p, a, b);
        expect(betaCdf(x, a, b)).toBeCloseTo(p, 10);
      }
    }
    // Reflection symmetry: q(p; a, b) = 1 − q(1 − p; b, a).
    expect(betaQuantile(0.01, 3, 7) + betaQuantile(0.99, 7, 3)).toBeCloseTo(1, 12);
  });

  test("a posterior at 60 of 974 is right-skewed: the exact interval sits above the normal one", () => {
    const a = 61;
    const b = 990 - 61;
    const mean = a / (a + b);
    const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
    const z = normalQuantile(1 - 0.025 / 16);
    expect(betaQuantile(0.025 / 16, a, b)).toBeGreaterThan(mean - z * sd);
    expect(betaQuantile(1 - 0.025 / 16, a, b)).toBeGreaterThan(mean + z * sd);
    // but the normal interval is not far off: it still holds > 99.5 % of the mass.
    const covered = betaCdf(mean + z * sd, a, b) - betaCdf(mean - z * sd, a, b);
    expect(covered).toBeGreaterThan(0.995);
    expect(covered).toBeLessThan(1 - 0.05 / 16);
  });
});

describe("poissonBinomialPmf", () => {
  test("reduces to the binomial for equal probabilities", () => {
    const pmf = poissonBinomialPmf([0.5, 0.5, 0.5, 0.5]);
    expect(pmf).toHaveLength(5);
    expect(pmf[0]).toBeCloseTo(1 / 16, 12);
    expect(pmf[2]).toBeCloseTo(6 / 16, 12);
    expect(pmf.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12);
  });

  test("has the right mean for unequal probabilities", () => {
    const ps = [3 / 16, 2 / 16, 5 / 16, 1 / 16];
    const pmf = poissonBinomialPmf(ps);
    const mean = pmf.reduce((s, p, k) => s + k * p, 0);
    expect(mean).toBeCloseTo(ps.reduce((s, p) => s + p, 0), 12);
  });
});
