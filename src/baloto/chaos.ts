/**
 * Could the machine itself be simulated? A measurement, not an opinion.
 *
 * The proposal is the most physically serious attack on a lottery: the balls
 * bounce in a controlled chamber under deterministic mechanics, so with the
 * initial positions and a good simulator one could compute the outcome. It has
 * worked before — Thorp and Shannon's wearable computer beat roulette in 1961,
 * and Diaconis showed coin flips are slightly predictable — because those
 * systems undergo only a handful of chaotic events before settling.
 *
 * Whether it works here is a number: the Lyapunov exponent λ of the ball
 * chamber. Uncertainty in the initial conditions grows like e^(λt), so knowing
 * the state to precision δ buys ln(L/δ)/λ seconds of foresight before the
 * prediction is worth nothing (L being the size of the chamber). This module
 * measures λ the honest way — run two copies of the same deterministic
 * simulation differing by a nanometre in one ball, and watch them diverge.
 *
 * Nothing here is tuned to make the answer come out one way. The simulation is
 * strictly deterministic (same inputs, bit-identical outputs); the divergence
 * measured is intrinsic to colliding spheres, not injected noise.
 */

import { makeRng } from "./random.ts";

export interface ChamberParams {
  /** Number of balls in the chamber. */
  balls: number;
  /** Chamber radius, metres. */
  radius: number;
  /** Ball radius, metres (Baloto balls are about ping-pong sized). */
  ballRadius: number;
  /** Coefficient of restitution for collisions. */
  restitution: number;
  /** Peak upward acceleration of the air jet, m/s². */
  jetStrength: number;
  /** Width of the jet as a fraction of the chamber radius. */
  jetWidth: number;
  /** Linear drag coefficient, 1/s. */
  drag: number;
  /** Integration timestep, seconds. */
  dt: number;
}

export const DEFAULT_CHAMBER: ChamberParams = {
  balls: 43,
  radius: 0.35,
  ballRadius: 0.02,
  restitution: 0.92,
  jetStrength: 60,
  jetWidth: 0.45,
  drag: 0.4,
  dt: 1e-4,
};

export interface ChamberState {
  /** Positions and velocities, interleaved per ball: x, y, vx, vy. */
  data: Float64Array;
  collisions: number;
  time: number;
}

const G = 9.81;

/** Deterministic initial state: balls resting in a jittered grid. */
export function initialState(params: ChamberParams, seed = 7): ChamberState {
  const rng = makeRng(seed);
  const data = new Float64Array(params.balls * 4);
  const perRow = Math.ceil(Math.sqrt(params.balls));
  const spacing = params.ballRadius * 2.4;
  for (let i = 0; i < params.balls; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    data[i * 4] = (col - (perRow - 1) / 2) * spacing + (rng() - 0.5) * 1e-3;
    data[i * 4 + 1] = -params.radius * 0.5 + row * spacing + (rng() - 0.5) * 1e-3;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 0;
  }
  return { data, collisions: 0, time: 0 };
}

/** Advance the chamber by one timestep. Purely deterministic. */
export function step(state: ChamberState, params: ChamberParams): void {
  const { data } = state;
  const n = params.balls;
  const dt = params.dt;
  const r = params.ballRadius;

  for (let i = 0; i < n; i++) {
    const x = data[i * 4]!;
    const y = data[i * 4 + 1]!;
    // Air jet: an upward plume, strongest at the bottom centre, fading with
    // height. A fixed, smooth field — deterministic agitation.
    const lateral = Math.exp(-((x / (params.jetWidth * params.radius)) ** 2));
    const heightFade = Math.max(0, 1 - (y + params.radius) / (2 * params.radius));
    const jet = params.jetStrength * lateral * heightFade;

    data[i * 4 + 2] = data[i * 4 + 2]! * (1 - params.drag * dt);
    data[i * 4 + 3] = (data[i * 4 + 3]! + (jet - G) * dt) * (1 - params.drag * dt);
    data[i * 4] = x + data[i * 4 + 2]! * dt;
    data[i * 4 + 1] = y + data[i * 4 + 3]! * dt;
  }

  // Ball–ball collisions: equal masses, exchange of the normal component.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = data[j * 4]! - data[i * 4]!;
      const dy = data[j * 4 + 1]! - data[i * 4 + 1]!;
      const dist2 = dx * dx + dy * dy;
      const minDist = 2 * r;
      if (dist2 >= minDist * minDist || dist2 === 0) continue;
      const dist = Math.sqrt(dist2);
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minDist - dist;
      // Separate the pair, then reflect the closing velocity.
      data[i * 4] = data[i * 4]! - (nx * overlap) / 2;
      data[i * 4 + 1] = data[i * 4 + 1]! - (ny * overlap) / 2;
      data[j * 4] = data[j * 4]! + (nx * overlap) / 2;
      data[j * 4 + 1] = data[j * 4 + 1]! + (ny * overlap) / 2;
      const rvx = data[j * 4 + 2]! - data[i * 4 + 2]!;
      const rvy = data[j * 4 + 3]! - data[i * 4 + 3]!;
      const closing = rvx * nx + rvy * ny;
      if (closing >= 0) continue;
      const impulse = (-(1 + params.restitution) * closing) / 2;
      data[i * 4 + 2] = data[i * 4 + 2]! - impulse * nx;
      data[i * 4 + 3] = data[i * 4 + 3]! - impulse * ny;
      data[j * 4 + 2] = data[j * 4 + 2]! + impulse * nx;
      data[j * 4 + 3] = data[j * 4 + 3]! + impulse * ny;
      state.collisions++;
    }
  }

  // Chamber wall: circular, reflect the radial component.
  const wall = params.radius - r;
  for (let i = 0; i < n; i++) {
    const x = data[i * 4]!;
    const y = data[i * 4 + 1]!;
    const d2 = x * x + y * y;
    if (d2 <= wall * wall || d2 === 0) continue;
    const d = Math.sqrt(d2);
    const nx = x / d;
    const ny = y / d;
    data[i * 4] = nx * wall;
    data[i * 4 + 1] = ny * wall;
    const radial = data[i * 4 + 2]! * nx + data[i * 4 + 3]! * ny;
    if (radial <= 0) continue;
    data[i * 4 + 2] = data[i * 4 + 2]! - (1 + params.restitution) * radial * nx;
    data[i * 4 + 3] = data[i * 4 + 3]! - (1 + params.restitution) * radial * ny;
    state.collisions++;
  }

  state.time += dt;
}

/** Euclidean distance between two chamber states in position space. */
export function separation(a: ChamberState, b: ChamberState): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dx = a.data[i]! - b.data[i]!;
    const dy = a.data[i + 1]! - b.data[i + 1]!;
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum);
}

export interface LyapunovReport {
  /** Fitted exponent, 1/s: uncertainty grows as e^(λt). */
  lambda: number;
  /** Time for the uncertainty to double, seconds. */
  doublingTime: number;
  /** Initial perturbation applied, metres. */
  epsilon: number;
  /** Ball-ball and ball-wall collisions per second, per ball. */
  collisionRate: number;
  /** (t, log separation) samples of the divergence, for inspection. */
  trace: { t: number; separation: number }[];
  /** Seconds simulated. */
  duration: number;
}

/**
 * The twin experiment: two identical chambers, one ball nudged by `epsilon`.
 *
 * The fit uses only the exponential-growth region — after the perturbation has
 * had a first collision to act on, before the separation saturates at the size
 * of the chamber.
 */
export function measureLyapunov(
  params: ChamberParams = DEFAULT_CHAMBER,
  epsilon = 1e-9,
  duration = 3,
  settle = 2,
  seed = 7,
): LyapunovReport {
  // Let the chamber reach its churning steady state before perturbing.
  const reference = initialState(params, seed);
  const settleSteps = Math.round(settle / params.dt);
  for (let s = 0; s < settleSteps; s++) step(reference, params);
  reference.collisions = 0;
  reference.time = 0;

  const twin: ChamberState = {
    data: new Float64Array(reference.data),
    collisions: 0,
    time: 0,
  };
  twin.data[0] = twin.data[0]! + epsilon;

  const sampleEvery = Math.max(1, Math.round(0.005 / params.dt));
  const steps = Math.round(duration / params.dt);
  const trace: { t: number; separation: number }[] = [];
  for (let s = 0; s < steps; s++) {
    step(reference, params);
    step(twin, params);
    if (s % sampleEvery === 0) {
      trace.push({ t: reference.time, separation: separation(reference, twin) });
    }
  }

  // Fit log-separation against time in the clean growth window.
  const floor = epsilon * 10;
  const ceiling = params.radius / 10;
  const window = trace.filter((p) => p.separation > floor && p.separation < ceiling);
  let lambda = 0;
  if (window.length >= 2) {
    const n = window.length;
    const meanT = window.reduce((a, p) => a + p.t, 0) / n;
    const meanL = window.reduce((a, p) => a + Math.log(p.separation), 0) / n;
    let num = 0;
    let den = 0;
    for (const p of window) {
      num += (p.t - meanT) * (Math.log(p.separation) - meanL);
      den += (p.t - meanT) ** 2;
    }
    lambda = den > 0 ? num / den : 0;
  }

  return {
    lambda,
    doublingTime: lambda > 0 ? Math.LN2 / lambda : Infinity,
    epsilon,
    collisionRate: reference.collisions / duration / params.balls,
    trace,
    duration,
  };
}

/**
 * How long a prediction survives, given how precisely the start was known.
 *
 * Foresight ends when the propagated uncertainty reaches the scale of the
 * chamber: t = ln(L/δ)/λ. The table's last row is the point of the exercise —
 * even perfect knowledge down to the Planck length buys only a few seconds
 * against a machine that mixes for tens of seconds.
 */
export interface HorizonRow {
  label: string;
  /** Initial uncertainty, metres. */
  precision: number;
  /** Seconds of valid prediction. */
  horizon: number;
}

export function predictabilityHorizons(
  lambda: number,
  chamberScale = 0.35,
): HorizonRow[] {
  const rows: [string, number][] = [
    ["a millimetre (naked eye)", 1e-3],
    ["a tenth of a millimetre (camera)", 1e-4],
    ["a micron (microscope)", 1e-6],
    ["a nanometre (interferometry)", 1e-9],
    ["an atom's width", 1e-10],
    ["the Planck length (physical limit)", 1.6e-35],
  ];
  return rows.map(([label, precision]) => ({
    label,
    precision,
    horizon: lambda > 0 ? Math.log(chamberScale / precision) / lambda : Infinity,
  }));
}
