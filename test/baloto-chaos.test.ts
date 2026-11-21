import { expect, test, describe } from "bun:test";
import {
  DEFAULT_CHAMBER,
  initialState,
  measureLyapunov,
  predictabilityHorizons,
  separation,
  step,
} from "../src/baloto/chaos.ts";

describe("the chamber simulation", () => {
  test("is strictly deterministic: identical starts stay bit-identical", () => {
    const a = initialState(DEFAULT_CHAMBER, 7);
    const b = initialState(DEFAULT_CHAMBER, 7);
    for (let s = 0; s < 5_000; s++) {
      step(a, DEFAULT_CHAMBER);
      step(b, DEFAULT_CHAMBER);
    }
    expect(separation(a, b)).toBe(0);
  });

  test("keeps every ball inside the chamber", () => {
    const state = initialState(DEFAULT_CHAMBER, 3);
    for (let s = 0; s < 20_000; s++) step(state, DEFAULT_CHAMBER);
    const limit = DEFAULT_CHAMBER.radius - DEFAULT_CHAMBER.ballRadius + 1e-9;
    for (let i = 0; i < DEFAULT_CHAMBER.balls; i++) {
      const x = state.data[i * 4]!;
      const y = state.data[i * 4 + 1]!;
      expect(Math.sqrt(x * x + y * y)).toBeLessThanOrEqual(limit);
    }
  });

  test("the air jet keeps the balls colliding rather than settling", () => {
    const state = initialState(DEFAULT_CHAMBER, 3);
    for (let s = 0; s < 20_000; s++) step(state, DEFAULT_CHAMBER);
    const before = state.collisions;
    for (let s = 0; s < 10_000; s++) step(state, DEFAULT_CHAMBER);
    expect(state.collisions).toBeGreaterThan(before);
  });

  test("speeds stay physically sensible (bounded by drag)", () => {
    const state = initialState(DEFAULT_CHAMBER, 3);
    for (let s = 0; s < 30_000; s++) step(state, DEFAULT_CHAMBER);
    for (let i = 0; i < DEFAULT_CHAMBER.balls; i++) {
      const vx = state.data[i * 4 + 2]!;
      const vy = state.data[i * 4 + 3]!;
      expect(Math.sqrt(vx * vx + vy * vy)).toBeLessThan(50);
    }
  });
});

describe("measureLyapunov", () => {
  const report = measureLyapunov(DEFAULT_CHAMBER, 1e-9, 2, 1.5, 7);

  test("a nanometre perturbation grows — the system is chaotic", () => {
    expect(report.lambda).toBeGreaterThan(10);
    expect(report.doublingTime).toBeLessThan(0.1);
  });

  test("the twins end fully decorrelated", () => {
    const last = report.trace.at(-1)!;
    expect(last.separation).toBeGreaterThan(DEFAULT_CHAMBER.radius / 10);
  });

  test("the exponent is a property of the system, not of the perturbation size", () => {
    const tiny = measureLyapunov(DEFAULT_CHAMBER, 1e-12, 2, 1.5, 7);
    // Same order of magnitude across three decades of epsilon.
    expect(tiny.lambda).toBeGreaterThan(report.lambda / 3);
    expect(tiny.lambda).toBeLessThan(report.lambda * 3);
  });

  test("balls collide at a realistic rate", () => {
    expect(report.collisionRate).toBeGreaterThan(1);
    expect(report.collisionRate).toBeLessThan(1_000);
  });
});

describe("predictabilityHorizons", () => {
  const rows = predictabilityHorizons(50);

  test("better initial knowledge buys more foresight, but only logarithmically", () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.horizon).toBeGreaterThan(rows[i - 1]!.horizon);
    }
    // Twelve orders of magnitude of precision buy less than a second here.
    const camera = rows.find((r) => r.precision === 1e-4)!;
    const planck = rows.at(-1)!;
    expect(planck.horizon - camera.horizon).toBeLessThan(1.6);
  });

  test("even Planck-scale knowledge is far short of a real mixing cycle", () => {
    const planck = rows.at(-1)!;
    expect(planck.horizon).toBeLessThan(10);
  });
});
