/**
 * A model whose only objective is hitting the Súper Balota.
 *
 * Every other picker in this suite optimises *payout* — choose combinations the
 * crowd avoids so a win is shared with fewer people. This one deliberately
 * discards that criterion. The single question here is: which Súper Balota
 * maximises the probability of matching it, and how much can a budget of N
 * tickets raise that probability?
 *
 * The answer has two halves, and they are different in kind.
 *
 * WITHIN ONE TICKET the honest posterior is flat. A Dirichlet posterior over
 * the sixteen balls is reported with credible intervals; on the real history
 * every interval covers 1/16, and a nine-method walk-forward tournament over
 * 861 draws found nothing that beats guessing (best 7.32 % against 6.25 %
 * expected, inside the ±1.65 pt band). So no ball is *established* as likelier.
 *
 * But a decision still has to be made, and "flat posterior" does not mean "no
 * action". Under a pure hit-maximising loss with no payout term, the Bayes
 * action is to play the ball with the highest posterior mean — the tiebreak
 * that a strict maximiser takes when the evidence is weak but not empty. The
 * prior strength controls how far that mean is allowed to drift from 1/16:
 * `priorStrength` of 1 is nearly uninformative, large values encode the
 * fairness the rest of this suite has repeatedly failed to reject.
 *
 * ACROSS TICKETS the lever is real and exact. Distinct Súper Balotas make the
 * events mutually exclusive, so N tickets hit with probability N/16 — a genuine
 * tripling from 6.25 % to 18.75 % at three tickets, with no assumption about
 * the machine at all.
 */

import { SUPER_POOL } from "./rules.ts";
import type { Draw } from "./dataset.ts";

/**
 * Normal quantile for a simultaneous interval over all sixteen balls:
 * Phi^-1(1 - 0.025/16). Without it, inspecting sixteen posteriors at 95 %
 * flags roughly one ball on a machine that is perfectly fair.
 */
const SIMULTANEOUS_Z = 2.8945;

export interface SuperPosterior {
  ball: number;
  /** Times this Súper Balota has been drawn. */
  count: number;
  /** Posterior mean probability under a Dirichlet prior. */
  mean: number;
  /** Credible interval for that probability, corrected for testing all sixteen. */
  low: number;
  high: number;
  /** True when the interval excludes 1/16 — evidence of a real preference. */
  distinguishable: boolean;
}

/**
 * Posterior over the sixteen Súper Balotas.
 *
 * `priorStrength` is the Dirichlet concentration per ball: 1 is the classic
 * uninformative choice, larger values encode prior confidence that the machine
 * is fair and shrink every estimate towards 1/16.
 */
export function superPosterior(draws: Draw[], priorStrength = 1): SuperPosterior[] {
  const counts = new Array(SUPER_POOL).fill(0);
  for (const draw of draws) counts[draw.super - 1]!++;
  const total = draws.length + priorStrength * SUPER_POOL;
  const uniform = 1 / SUPER_POOL;

  return counts.map((count, i) => {
    const alpha = count + priorStrength;
    const mean = alpha / total;
    // Normal approximation to the Beta(alpha, total-alpha) posterior; the
    // counts here are large enough for it, and it keeps the report readable.
    const sd = Math.sqrt((mean * (1 - mean)) / (total + 1));
    // Sixteen balls are inspected at once, so a plain 95 % interval flags about
    // one of them on a perfectly fair machine. The width is corrected for the
    // simultaneous look (1 - 0.05/16), which is what makes an empty
    // `distinguishable` list mean something.
    const z = SIMULTANEOUS_Z;
    const low = Math.max(0, mean - z * sd);
    const high = mean + z * sd;
    return {
      ball: i + 1,
      count,
      mean,
      low,
      high,
      distinguishable: low > uniform || high < uniform,
    };
  });
}

export interface SuperPlan {
  /** Súper Balotas to play, best posterior mean first. */
  balls: number[];
  /** Exact probability that one of them matches: tickets / 16. */
  hitProbability: number;
  /** Probability a single ticket hits, for comparison. */
  singleTicket: number;
  /** Balls whose posterior interval excludes 1/16. */
  distinguishable: number[];
  /** Posterior spread between the best and worst ball, in percentage points. */
  spreadPoints: number;
}

/**
 * The Bayes action for a pure hit-maximising objective: take the `tickets`
 * balls with the highest posterior mean, each on its own ticket.
 *
 * Distinct balls are what makes the arithmetic exact — the events cannot both
 * happen, so the probabilities add. Repeating a ball would waste a ticket.
 */
export function planSuperCoverage(
  draws: Draw[],
  tickets = 3,
  priorStrength = 1,
): SuperPlan {
  const posterior = superPosterior(draws, priorStrength);
  const ranked = [...posterior].sort((a, b) => b.mean - a.mean);
  const chosen = ranked.slice(0, Math.min(tickets, SUPER_POOL));

  return {
    balls: chosen.map((p) => p.ball),
    hitProbability: chosen.length / SUPER_POOL,
    singleTicket: 1 / SUPER_POOL,
    distinguishable: posterior.filter((p) => p.distinguishable).map((p) => p.ball),
    spreadPoints: (ranked[0]!.mean - ranked[ranked.length - 1]!.mean) * 100,
  };
}
