import { expect, test, describe } from "bun:test";
import {
  elementarySymmetric,
  fitBiasModel,
  poissonBinomial,
  scoreModel,
  summariseBias,
  ticketPopularity,
  uniformModel,
} from "../src/baloto/bias.ts";
import { expectedShare, expectedValue } from "../src/baloto/ev.ts";
import { pickTickets } from "../src/baloto/pick.ts";
import { parseTicket } from "../src/commands/baloto.ts";
import {
  MAIN_PICK,
  MAIN_POOL,
  PRIZE_TIERS,
  SUPER_POOL,
  TOTAL_COMBINATIONS,
  choose,
} from "../src/baloto/rules.ts";
import type { Draw } from "../src/baloto/dataset.ts";

describe("poissonBinomial", () => {
  test("reduces to the binomial when every probability is equal", () => {
    const p = 0.25;
    const dist = poissonBinomial(new Array(5).fill(p));
    for (let k = 0; k <= 5; k++) {
      const expected = choose(5, k) * p ** k * (1 - p) ** (5 - k);
      expect(dist[k]!).toBeCloseTo(expected, 12);
    }
  });

  test("is a probability distribution", () => {
    const dist = poissonBinomial([0.1, 0.5, 0.9, 0.3, 0.7]);
    expect(dist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  test("is certain when every probability is one", () => {
    expect(poissonBinomial([1, 1, 1])[3]!).toBeCloseTo(1, 12);
  });
});

describe("elementarySymmetric", () => {
  test("counts subsets when every weight is one", () => {
    expect(elementarySymmetric(new Array(43).fill(1), 5)).toBeCloseTo(choose(43, 5), 0);
  });

  test("matches a hand-computed case", () => {
    // e_2(2,3,5) = 2·3 + 2·5 + 3·5 = 31
    expect(elementarySymmetric([2, 3, 5], 2)).toBeCloseTo(31, 12);
  });
});

describe("ticketPopularity", () => {
  test("every ticket is equally likely when nobody has a preference", () => {
    const model = uniformModel();
    const a = ticketPopularity({ main: [1, 2, 3, 4, 5], super: 7 }, model);
    const b = ticketPopularity({ main: [11, 22, 33, 41, 43], super: 2 }, model);
    expect(a).toBeCloseTo(1 / TOTAL_COMBINATIONS, 15);
    expect(b).toBeCloseTo(a, 15);
  });

  test("the Súper Balota accounts for exactly its share of a combination", () => {
    const model = uniformModel();
    model.main = model.main.map((p, i) => (i < 10 ? p * 1.4 : p));
    const scale = MAIN_PICK / model.main.reduce((a, b) => a + b, 0);
    model.main = model.main.map((p) => p * scale);

    const main = [4, 9, 21, 33, 40];
    let overSupers = 0;
    for (let s = 1; s <= SUPER_POOL; s++) overSupers += ticketPopularity({ main, super: s }, model);

    // Summing over the 16 Súper Balotas must leave the main-combination weight.
    const weights = model.main.map((p) => p / (1 - p));
    const expected =
      main.reduce((acc, n) => acc * weights[n - 1]!, 1) / elementarySymmetric(weights, MAIN_PICK);
    expect(overSupers).toBeCloseTo(expected, 15);
  });

  test("summing over every combination of a small pool gives one", () => {
    // The identity that makes the 962 598 combinations unnecessary:
    // Σ over k-subsets of Π w = e_k(w).
    const weights = [0.4, 1.1, 2.3, 0.7, 1.9, 0.5];
    let bruteForce = 0;
    const walk = (start: number, depth: number, product: number) => {
      if (depth === 3) {
        bruteForce += product;
        return;
      }
      for (let i = start; i < weights.length; i++) walk(i + 1, depth + 1, product * weights[i]!);
    };
    walk(0, 0, 1);
    expect(bruteForce / elementarySymmetric(weights, 3)).toBeCloseTo(1, 12);
  });
});

/**
 * A synthetic season in which players demonstrably favour low numbers, used to
 * check that the estimator recovers a preference it was never told about.
 */
function biasedSeason(count: number): Draw[] {
  const draws: Draw[] = [];
  // Players put low numbers on their tickets twice as often as high ones.
  const truth = Array.from({ length: MAIN_POOL }, (_, i) => (i < 20 ? 2 : 1));
  const scale = MAIN_PICK / truth.reduce((a, b) => a + b, 0);
  const pi = truth.map((w) => w * scale);

  for (let d = 0; d < count; d++) {
    // Deterministic spread of drawn numbers across the pool.
    const main = [0, 1, 2, 3, 4]
      .map((k) => 1 + ((d * 7 + k * 9) % MAIN_POOL))
      .filter((n, i, arr) => arr.indexOf(n) === i);
    while (main.length < MAIN_PICK) {
      const candidate = 1 + ((main.length * 13 + d) % MAIN_POOL);
      if (!main.includes(candidate)) main.push(candidate);
    }
    main.sort((a, b) => a - b);
    const superBall = 1 + (d % SUPER_POOL);

    const dist = poissonBinomial(main.map((n) => pi[n - 1]!));
    const tickets = 400_000;
    const tiers = PRIZE_TIERS.map((tier) => {
      let mass = 0;
      for (let k = tier.minMain; k <= tier.maxMain; k++) mass += dist[k]!;
      const p = mass * (tier.superMatch ? 1 / SUPER_POOL : 1 - 1 / SUPER_POOL);
      return {
        tier: tier.id,
        winners: Math.round(tickets * p),
        prizePerWinner: 1,
        totalPaid: Math.round(tickets * p),
      };
    });
    draws.push({ date: `2020-01-${String((d % 28) + 1).padStart(2, "0")}`, game: "baloto", main, super: superBall, tiers });
  }
  return draws;
}

describe("fitBiasModel", () => {
  test("recovers a preference for low numbers that it was never told about", () => {
    const model = fitBiasModel(biasedSeason(300), { iterations: 400 });
    const summary = summariseBias(model);
    // The synthetic crowd favours 1..20; the fitted model must lean the same way.
    expect(summary.dateBiasRatio).toBeGreaterThan(1);
    const low = model.main.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    const high = model.main.slice(31).reduce((a, b) => a + b, 0) / (MAIN_POOL - 31);
    expect(low).toBeGreaterThan(high);
  });

  test("fits the data better than assuming no preference at all", () => {
    const draws = biasedSeason(300);
    const model = fitBiasModel(draws, { iterations: 400 });
    expect(model.logLikelihood).toBeGreaterThan(model.nullLogLikelihood);
    expect(scoreModel(draws, model.main, model.super)).toBeCloseTo(model.logLikelihood, 6);
  });

  test("falls back to uniform when there is nothing to learn from", () => {
    const model = fitBiasModel([]);
    expect(model.observations).toBe(0);
    expect(model.main.every((p) => Math.abs(p - MAIN_PICK / MAIN_POOL) < 1e-12)).toBe(true);
  });

  test("estimates how many tickets were sold", () => {
    const model = fitBiasModel(biasedSeason(120), { iterations: 300 });
    // The synthetic season sold 400 000 tickets per draw.
    expect(summariseBias(model).medianTickets).toBeGreaterThan(300_000);
    expect(summariseBias(model).medianTickets).toBeLessThan(500_000);
  });
});

describe("expectedShare", () => {
  test("a sole winner keeps everything", () => {
    expect(expectedShare(0, 0.5)).toBe(1);
    expect(expectedShare(1000, 0)).toBe(1);
  });

  test("shrinks as more players hold the same ticket", () => {
    expect(expectedShare(1000, 0.01)).toBeLessThan(expectedShare(1000, 0.001));
  });

  test("matches the analytic value for a small case", () => {
    // n = 2, q = 0.5: outcomes 0,1,2 other winners with weights .25,.5,.25
    const expected = 0.25 * 1 + 0.5 * (1 / 2) + 0.25 * (1 / 3);
    expect(expectedShare(2, 0.5)).toBeCloseTo(expected, 12);
  });
});

describe("expectedValue", () => {
  const model = fitBiasModel(biasedSeason(200), { iterations: 300 });
  const options = { jackpot: 50_000_000_000, ticketsSold: 300_000, samples: 300 };

  test("an unpopular ticket is worth more than a popular one", () => {
    const popular = expectedValue({ main: [1, 2, 3, 4, 5], super: 1 }, model, options);
    const unpopular = expectedValue({ main: [39, 40, 41, 42, 43], super: 1 }, model, options);
    expect(unpopular.popularityRatio).toBeLessThan(popular.popularityRatio);
    expect(unpopular.expectedValue).toBeGreaterThan(popular.expectedValue);
    expect(unpopular.expectedJackpotSharers).toBeLessThan(popular.expectedJackpotSharers);
  });

  test("a bigger jackpot is worth more", () => {
    const small = expectedValue({ main: [39, 40, 41, 42, 43], super: 1 }, model, options);
    const big = expectedValue({ main: [39, 40, 41, 42, 43], super: 1 }, model, {
      ...options,
      jackpot: 100_000_000_000,
    });
    expect(big.expectedValue).toBeGreaterThan(small.expectedValue);
  });

  test("the ticket is a losing bet at the minimum jackpot", () => {
    const report = expectedValue({ main: [39, 40, 41, 42, 43], super: 1 }, model, {
      ...options,
      jackpot: 4_000_000_000,
    });
    expect(report.returnToPlayer).toBeLessThan(1);
    expect(report.breakevenJackpot).toBeGreaterThan(report.jackpot);
  });

  test("the break-even jackpot really does break even", () => {
    const ticket = { main: [39, 40, 41, 42, 43], super: 1 };
    const base = expectedValue(ticket, model, options);
    const atBreakeven = expectedValue(ticket, model, {
      ...options,
      jackpot: base.breakevenJackpot!,
    });
    expect(atBreakeven.returnToPlayer).toBeCloseTo(1, 2);
  });

  test("withholding tax lowers the value", () => {
    const gross = expectedValue({ main: [39, 40, 41, 42, 43], super: 1 }, model, options);
    const net = expectedValue({ main: [39, 40, 41, 42, 43], super: 1 }, model, {
      ...options,
      afterTax: true,
    });
    expect(net.expectedValue).toBeLessThan(gross.expectedValue);
  });
});

describe("pickTickets", () => {
  const model = fitBiasModel(biasedSeason(200), { iterations: 300 });

  test("produces valid, unpopular, well-spread tickets", () => {
    const picks = pickTickets(model, { count: 4, pool: 120, seed: 5, maxOverlap: 2 });
    expect(picks).toHaveLength(4);
    for (const { ticket, popularityRatio } of picks) {
      expect(ticket.main).toHaveLength(MAIN_PICK);
      expect(new Set(ticket.main).size).toBe(MAIN_PICK);
      expect(Math.min(...ticket.main)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...ticket.main)).toBeLessThanOrEqual(MAIN_POOL);
      expect(ticket.super).toBeGreaterThanOrEqual(1);
      expect(ticket.super).toBeLessThanOrEqual(SUPER_POOL);
      expect(popularityRatio).toBeLessThan(1);
    }
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        const shared = picks[i]!.ticket.main.filter((n) => picks[j]!.ticket.main.includes(n));
        expect(shared.length).toBeLessThanOrEqual(2);
      }
    }
  });

  test("the same seed gives the same tickets", () => {
    const a = pickTickets(model, { count: 3, pool: 60, seed: 99 });
    const b = pickTickets(model, { count: 3, pool: 60, seed: 99 });
    expect(a.map((t) => t.ticket)).toEqual(b.map((t) => t.ticket));
  });
});

describe("parseTicket", () => {
  test("accepts the documented formats", () => {
    expect(parseTicket("3,7,12,17,23+7")).toEqual({ main: [3, 7, 12, 17, 23], super: 7 });
    expect(parseTicket("23 3 7 17 12 7")).toEqual({ main: [3, 7, 12, 17, 23], super: 7 });
  });

  test("rejects malformed tickets", () => {
    expect(() => parseTicket("1,2,3,4+5")).toThrow();
    expect(() => parseTicket("1,1,3,4,5+6")).toThrow();
    expect(() => parseTicket("1,2,3,4,44+6")).toThrow();
    expect(() => parseTicket("1,2,3,4,5+17")).toThrow();
  });
});
