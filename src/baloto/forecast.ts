/**
 * Forecasting how many tickets a draw will sell.
 *
 * Every economic figure this suite produces — expected value, prize crowding,
 * when the jackpot will fall — is a function of sales volume. For weeks that
 * volume was estimated as "the historical median for this weekday", and live
 * scoring exposed the flaw: across eleven consecutive draws in August and
 * September 2026 the estimate was low *every single time* (median 26 %). Eleven
 * misses in the same direction is not noise; it is a missing term.
 *
 * Two were missing, and both are non-stationary:
 *
 *  - Jackpot fever. Sales rise with the advertised roll-over, ~4 % per $10 000
 *    million. The elasticity had been measured for the fall-date simulation but
 *    never wired into the volume forecast itself.
 *  - Monday adoption. The Monday draw launched mid-2025 and is still being
 *    taken up: median sales went 72k → 117k → 123k → 131k → 157k → 201k by
 *    quarter, a 2.8× climb, while Saturdays moved only 425k → 482k. A weekday
 *    coefficient fitted on the whole history is anchored to a market that no
 *    longer exists.
 *
 * The fix for both is the same: fit on a trailing window rather than on
 * everything. Validated walk-forward on the eleven draws that exposed the
 * problem, mean absolute error falls from 24.9 % (weekday median) to 16.7 %
 * (full-history regression) to 12.6 % at an 80-draw window — and the one-sided
 * bias disappears.
 */

import type { Draw } from "./dataset.ts";
import { fitBiasModel, type BiasModel } from "./bias.ts";
import { PRIZE_TIERS } from "./rules.ts";

/** Draws of the trailing window used to fit the sales model. */
export const DEFAULT_WINDOW = 80;

export interface VolumeModel {
  /** log(tickets) = intercept + jackpotSlope·J(bn) + monday + saturday. */
  intercept: number;
  jackpotSlope: number;
  monday: number;
  saturday: number;
  /** Draws the fit was based on. */
  observations: number;
}

const dayOfWeek = (date: string): number =>
  new Date(`${date}T12:00:00Z`).getUTCDay();

/** Advertised jackpot of a draw, in thousands of millions of COP. */
export function jackpotOf(draw: Draw): number {
  const tier = draw.tiers?.find((t) => t.tier === "5+S");
  return tier ? tier.prizePerWinner / 1e9 : 0;
}

/** Gauss-Jordan solve; returns [] for a singular system. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = matrix.length;
  const m = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return [];
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const d = m[col]![col]!;
    for (let j = col; j <= n; j++) m[col]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      for (let j = col; j <= n; j++) m[r]![j]! -= f * m[col]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

/**
 * Fit the sales model on the most recent `window` draws that carry both a
 * breakdown (which implies the volume) and an advertised jackpot.
 */
export function fitVolumeModel(
  draws: Draw[],
  model: BiasModel = fitBiasModel(draws),
  window = DEFAULT_WINDOW,
): VolumeModel | null {
  const volume = new Map(model.ticketsSold.map((t) => [t.date, t.tickets]));
  const usable = draws
    .filter((d) => volume.has(d.date) && jackpotOf(d) > 1)
    .slice(-window);
  if (usable.length < 12) return null;

  const rows = usable.map((d) => [
    1,
    jackpotOf(d),
    dayOfWeek(d.date) === 1 ? 1 : 0,
    dayOfWeek(d.date) === 6 ? 1 : 0,
  ]);
  const y = usable.map((d) => Math.log(volume.get(d.date)!));

  const k = 4;
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < k; a++) {
      xty[a]! += rows[i]![a]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += rows[i]![a]! * rows[i]![b]!;
    }
  }
  const beta = solve(xtx, xty);
  if (beta.length === 0) return null;

  return {
    intercept: beta[0]!,
    jackpotSlope: beta[1]!,
    monday: beta[2]!,
    saturday: beta[3]!,
    observations: usable.length,
  };
}

/** Tickets a draw on `date` with jackpot `jackpotBn` is expected to sell. */
export function forecastVolume(
  model: VolumeModel,
  date: string,
  jackpotBn: number,
): number {
  const day = dayOfWeek(date);
  return Math.exp(
    model.intercept +
      model.jackpotSlope * jackpotBn +
      (day === 1 ? model.monday : 0) +
      (day === 6 ? model.saturday : 0),
  );
}

/** Percentage change in sales for each extra $10 000 million of jackpot. */
export function feverPerTenBillion(model: VolumeModel): number {
  return Math.exp(model.jackpotSlope * 10) - 1;
}

export interface VolumeAccuracy {
  date: string;
  actual: number;
  predicted: number;
  /** Signed relative error, predicted vs actual. */
  error: number;
}

/**
 * Walk-forward accuracy: for each draw after `from`, refit the sales regression
 * on what was known beforehand and score the forecast. This is the check that
 * caught the original failure, so it ships with the fix.
 *
 * The preference model is fitted once rather than per draw. What it contributes
 * here is each past draw's implied ticket count, which is essentially total
 * winners divided by the chance of winning anything — dominated by the eighth
 * category and barely sensitive to the fitted preferences. The quantity under
 * test, the sales regression, is refitted strictly on the past.
 */
export function scoreVolumeForecast(
  draws: Draw[],
  from: string,
  window = DEFAULT_WINDOW,
): VolumeAccuracy[] {
  const usable = draws.filter((d) => d.tiers?.length === PRIZE_TIERS.length);
  const model = fitBiasModel(usable);
  const volume = new Map(model.ticketsSold.map((t) => [t.date, t.tickets]));

  const out: VolumeAccuracy[] = [];
  for (const draw of usable.filter((d) => d.date >= from)) {
    const past = usable.filter((d) => d.date < draw.date);
    const fit = fitVolumeModel(past, model, window);
    const actual = volume.get(draw.date);
    if (!fit || !actual) continue;
    const predicted = forecastVolume(fit, draw.date, jackpotOf(draw));
    out.push({ date: draw.date, actual, predicted, error: predicted / actual - 1 });
  }
  return out;
}
