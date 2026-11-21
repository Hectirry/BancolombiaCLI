/**
 * The selection rule, backtested in pesos that were actually paid.
 *
 * Everything else in this suite scores selection rules against a *model* of
 * the crowd. This module removes the model from the scoring side entirely: a
 * selection rule is evaluated against the numbers that really came out and the
 * per-winner prizes the operator really published, draw by draw. If choosing
 * unpopular numbers works, a rule that leans against the crowd must realise
 * more pesos per ticket than one that imitates it — on draws it never saw.
 *
 * One tier is excluded and must be: the jackpot has fallen 14 times in the
 * whole history, so its realised value is noise from which numbers happened to
 * come out (the full-metric γ ranking flips sign between halves, which is that
 * noise showing itself). The pari-mutuel tiers below it pay out thousands of
 * times per draw; that is where sharing is measurable. The mechanism validated
 * there — same win rate, larger payouts — is the same mechanism the EV model
 * applies to the jackpot, where only 14 events exist to test it directly.
 */

import { PRIZE_TIERS, TIER_BY_ID, ECONOMICS, MAIN_POOL, SUPER_POOL, MAIN_PICK } from "./rules.ts";
import type { Draw } from "./dataset.ts";
import { fitBiasModel, matchDistribution, type BiasModel } from "./bias.ts";

const UNIFORM_MAIN = MAIN_PICK / MAIN_POOL;
const UNIFORM_SUPER = 1 / SUPER_POOL;
/** Tiers whose sales estimate anchors pots for the rare unclaimed cases. */
const ANCHOR_TIERS = ["4", "3+S", "3", "2+S"];

/**
 * Expected pesos a ticket drawn from the γ-family rule would have collected in
 * `draw`, using the published per-winner prizes. γ = 0 is a uniform quick-pick,
 * negative γ imitates the crowd, positive γ leans against it.
 */
function realizedInDraw(
  draw: Draw,
  model: BiasModel,
  gamma: number,
  includeJackpot: boolean,
): number {
  const weights = model.main.map((p) => (UNIFORM_MAIN / p) ** gamma);
  const superWeights = model.super.map((p) => (UNIFORM_SUPER / p) ** gamma);
  const superSum = superWeights.reduce((a, b) => a + b, 0);

  const drawnSet = new Set(draw.main);
  const inside = draw.main.map((n) => weights[n - 1]!);
  const outside: number[] = [];
  for (let n = 1; n <= MAIN_POOL; n++) if (!drawnSet.has(n)) outside.push(weights[n - 1]!);
  const pb = matchDistribution(inside, outside);
  const pSuper = superWeights[draw.super - 1]! / superSum;

  const byId = new Map(draw.tiers!.map((t) => [t.tier, t]));
  const anchors = ANCHOR_TIERS.map((id) => byId.get(id))
    .filter((t) => t && t.winners > 0 && t.totalPaid > 0)
    .map((t) => t!.totalPaid / TIER_BY_ID[t!.tier]!.allocation)
    .sort((a, b) => a - b);
  const salesNet = anchors[Math.floor(anchors.length / 2)] ?? 0;

  let total = 0;
  for (const tier of PRIZE_TIERS) {
    if (tier.id === "5+S" && !includeJackpot) continue;
    let mass = 0;
    for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
    const p = mass * (tier.superMatch ? pSuper : 1 - pSuper);
    const published = byId.get(tier.id)!;
    // What one extra ticket would have collected: the published per-winner
    // prize; for an unclaimed tier, the whole pot (or the refund).
    let prize = published.prizePerWinner;
    if (tier.id !== "5+S" && published.winners === 0) {
      prize = tier.kind === "fixed" ? ECONOMICS.ticketPrice : tier.allocation * salesNet;
    }
    total += p * prize;
  }
  return total;
}

export interface RealizedPoint {
  gamma: number;
  trainValue: number;
  testValue: number;
}

export interface RealizedReport {
  trainDraws: number;
  testDraws: number;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  points: RealizedPoint[];
  /** γ that maximised realised value on the training half. */
  learnedGamma: number;
  /** Realised pesos per ticket on the unseen half, by rule. */
  testLearned: number;
  testUniform: number;
  testCrowdLike: number;
  /** Win rate per draw on the test half (excluding jackpot), by rule. */
  winRateLearned: number;
  winRateCrowdLike: number;
}

/**
 * Learn the selection rule's aggressiveness on the first half of the history,
 * validate it in realised pesos on the second half.
 */
export function backtestSelection(
  draws: Draw[],
  gammas = [-1, 0, 1, 2, 3, 4, 6, 8],
): RealizedReport {
  const usable = draws.filter((d) => d.tiers?.length === PRIZE_TIERS.length);
  const half = Math.floor(usable.length / 2);
  const train = usable.slice(0, half);
  const test = usable.slice(half);
  const model = fitBiasModel(train);

  const evaluate = (subset: Draw[], gamma: number): number =>
    subset.reduce((a, d) => a + realizedInDraw(d, model, gamma, false), 0) / subset.length;

  const points: RealizedPoint[] = gammas.map((gamma) => ({
    gamma,
    trainValue: evaluate(train, gamma),
    testValue: evaluate(test, gamma),
  }));

  const learned = points.reduce((best, p) => (p.trainValue > best.trainValue ? p : best));

  const winRate = (gamma: number): number => {
    const weights = model.main.map((p) => (UNIFORM_MAIN / p) ** gamma);
    const superWeights = model.super.map((p) => (UNIFORM_SUPER / p) ** gamma);
    const superSum = superWeights.reduce((a, b) => a + b, 0);
    let total = 0;
    for (const d of test) {
      const drawnSet = new Set(d.main);
      const inside = d.main.map((n) => weights[n - 1]!);
      const outside: number[] = [];
      for (let n = 1; n <= MAIN_POOL; n++) if (!drawnSet.has(n)) outside.push(weights[n - 1]!);
      const pb = matchDistribution(inside, outside);
      const pSuper = superWeights[d.super - 1]! / superSum;
      for (const tier of PRIZE_TIERS) {
        if (tier.id === "5+S") continue;
        let mass = 0;
        for (let k = tier.minMain; k <= tier.maxMain; k++) mass += pb[k]!;
        total += mass * (tier.superMatch ? pSuper : 1 - pSuper);
      }
    }
    return total / test.length;
  };

  return {
    trainDraws: train.length,
    testDraws: test.length,
    trainFrom: train[0]?.date ?? "",
    trainTo: train.at(-1)?.date ?? "",
    testFrom: test[0]?.date ?? "",
    testTo: test.at(-1)?.date ?? "",
    points,
    learnedGamma: learned.gamma,
    testLearned: learned.testValue,
    testUniform: points.find((p) => p.gamma === 0)?.testValue ?? 0,
    testCrowdLike: points.find((p) => p.gamma === -1)?.testValue ?? 0,
    winRateLearned: winRate(learned.gamma),
    winRateCrowdLike: winRate(-1),
  };
}
