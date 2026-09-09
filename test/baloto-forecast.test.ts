import { expect, test, describe } from "bun:test";
import {
  DEFAULT_WINDOW,
  feverPerTenBillion,
  fitVolumeModel,
  forecastVolume,
  jackpotOf,
  scoreVolumeForecast,
} from "../src/baloto/forecast.ts";
import { matchDistribution } from "../src/baloto/bias.ts";
import { makeRng, randInt, sampleDistinct } from "../src/baloto/random.ts";
import { MAIN_PICK, MAIN_POOL, PRIZE_TIERS, SUPER_POOL } from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

/**
 * A synthetic season whose sales follow a known law: a jackpot elasticity plus
 * a Monday discount that *shrinks over time*, imitating the adoption curve that
 * broke the original forecaster.
 */
function season(count: number, seed: number, options: { adoption?: boolean } = {}): Draw[] {
  const rng = makeRng(seed);
  const buffer = new Int32Array(MAIN_POOL);
  const draws: Draw[] = [];
  let jackpot = 10;
  // 2026-01-05 is a Monday; walk Mon/Wed/Sat from there.
  const date = new Date("2026-01-05T12:00:00Z");

  for (let i = 0; i < count; i++) {
    while (![1, 3, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    const iso = date.toISOString().slice(0, 10);
    const day = date.getUTCDay();

    const mondayEffect = options.adoption
      ? -0.9 + 0.7 * (i / count) // Monday catches up over the season
      : -0.9;
    const tickets = Math.exp(
      12.4 + 0.004 * jackpot + (day === 1 ? mondayEffect : 0) + (day === 6 ? 0.18 : 0),
    );

    const main = sampleDistinct(rng, MAIN_POOL, MAIN_PICK, buffer);
    const superBall = 1 + randInt(rng, SUPER_POOL);
    const drawnSet = new Set(main);
    const inside = main.map(() => 1);
    const outside: number[] = [];
    for (let n = 1; n <= MAIN_POOL; n++) if (!drawnSet.has(n)) outside.push(1);
    const pb = matchDistribution(inside, outside);

    const tiers = PRIZE_TIERS.map((tier) => {
      let mass = 0;
      for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
      const p = mass * (tier.superMatch ? 1 / SUPER_POOL : 1 - 1 / SUPER_POOL);
      const winners = Math.max(0, Math.round(tickets * p));
      const prizePerWinner =
        tier.id === "5+S" ? Math.round(jackpot * 1e9) : tier.kind === "fixed" ? 6_000 : 1_000;
      return { tier: tier.id, winners, prizePerWinner, totalPaid: prizePerWinner * winners };
    });

    draws.push({ date: iso, game: "baloto", main, super: superBall, tiers });
    jackpot += 0.5;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return draws;
}

describe("jackpotOf", () => {
  test("reads the advertised roll-over from the top tier", () => {
    const [draw] = season(1, 3);
    expect(jackpotOf(draw!)).toBeCloseTo(10, 6);
  });

  test("is zero when no breakdown was published", () => {
    expect(jackpotOf({ date: "2026-01-05", game: "baloto", main: [1, 2, 3, 4, 5], super: 1 })).toBe(0);
  });
});

describe("fitVolumeModel", () => {
  const draws = season(200, 11);
  const model = fitVolumeModel(draws)!;

  test("recovers the planted jackpot elasticity and weekday effects", () => {
    expect(model.jackpotSlope).toBeCloseTo(0.004, 3);
    expect(model.monday).toBeCloseTo(-0.9, 1);
    expect(model.saturday).toBeCloseTo(0.18, 1);
  });

  test("fits on the trailing window, not on everything", () => {
    expect(model.observations).toBe(DEFAULT_WINDOW);
    expect(fitVolumeModel(draws, undefined, 30)!.observations).toBe(30);
  });

  test("declines to fit when there is too little data", () => {
    expect(fitVolumeModel(season(6, 5))).toBeNull();
  });

  test("reports fever in readable units", () => {
    // 0.004 per bn compounds to about 4 % per ten billion.
    expect(feverPerTenBillion(model)).toBeCloseTo(Math.exp(0.04) - 1, 3);
  });
});

describe("forecastVolume", () => {
  const model = fitVolumeModel(season(200, 11))!;

  test("a bigger jackpot forecasts more tickets", () => {
    const low = forecastVolume(model, "2026-06-10", 20);
    const high = forecastVolume(model, "2026-06-10", 80);
    expect(high).toBeGreaterThan(low);
  });

  test("Mondays forecast fewer tickets than Saturdays", () => {
    // 2026-06-08 is a Monday, 2026-06-13 a Saturday.
    expect(forecastVolume(model, "2026-06-08", 40)).toBeLessThan(
      forecastVolume(model, "2026-06-13", 40),
    );
  });
});

describe("scoreVolumeForecast", () => {
  test("scores every draw after the cutoff, walk-forward", () => {
    const draws = season(160, 21);
    const cutoff = draws[120]!.date;
    const scored = scoreVolumeForecast(draws, cutoff);
    expect(scored.length).toBeGreaterThan(30);
    expect(scored.every((s) => s.date >= cutoff)).toBe(true);
  });

  test("tracks a market whose weekday effect drifts — the real failure mode", () => {
    // With adoption, a full-history fit lags; the trailing window keeps up.
    const draws = season(180, 7, { adoption: true });
    const cutoff = draws[140]!.date;
    const windowed = scoreVolumeForecast(draws, cutoff, 60);
    const everything = scoreVolumeForecast(draws, cutoff, 10_000);
    const mae = (rows: { error: number }[]) =>
      rows.reduce((a, r) => a + Math.abs(r.error), 0) / rows.length;
    expect(mae(windowed)).toBeLessThan(mae(everything));
  });

  test("a stationary market leaves no systematic bias", () => {
    const draws = season(180, 33);
    const scored = scoreVolumeForecast(draws, draws[140]!.date, 80);
    const bias = scored.reduce((a, r) => a + r.error, 0) / scored.length;
    expect(Math.abs(bias)).toBeLessThan(0.05);
  });
});
