/**
 * Deterministic random numbers.
 *
 * Every p-value in this module family comes from a Monte Carlo simulation of
 * the "the machine is fair" null hypothesis rather than from an asymptotic
 * approximation. That matters: the five main balls are drawn *without*
 * replacement, so the usual chi-square degrees-of-freedom rule does not apply
 * (the Pearson statistic has expectation 38, not 42). Simulating the real
 * sampling scheme sidesteps the issue entirely — at the cost of needing a
 * reproducible generator, which is what lives here.
 */

import { MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";

/** mulberry32 — small, fast, and good enough for resampling. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). */
export function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/**
 * Draw `k` distinct values from 1..n uniformly, ascending. Partial
 * Fisher–Yates on a reusable buffer keeps the simulations allocation-light.
 */
export function sampleDistinct(
  rng: () => number,
  n: number,
  k: number,
  buffer: Int32Array,
): number[] {
  for (let i = 0; i < n; i++) buffer[i] = i + 1;
  for (let i = 0; i < k; i++) {
    const j = i + randInt(rng, n - i);
    const tmp = buffer[i]!;
    buffer[i] = buffer[j]!;
    buffer[j] = tmp;
  }
  const out = Array.from(buffer.subarray(0, k));
  out.sort((a, b) => a - b);
  return out;
}

/** One simulated fair draw. */
export function simulateDraw(
  rng: () => number,
  buffer: Int32Array,
): { main: number[]; super: number } {
  return {
    main: sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer),
    super: 1 + randInt(rng, SUPER_POOL),
  };
}

/**
 * Monte Carlo p-value: the share of fair simulations whose statistic is at
 * least as extreme as the observed one. The +1 correction keeps the p-value
 * from ever being exactly zero, which would overstate the evidence.
 */
export function monteCarloPValue(observed: number, simulated: number[]): number {
  let atLeast = 0;
  for (const value of simulated) if (value >= observed) atLeast++;
  return (atLeast + 1) / (simulated.length + 1);
}
