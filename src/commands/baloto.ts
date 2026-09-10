/**
 * `bancolombia baloto …` — a statistical study of Colombia's Baloto.
 *
 * The commands are deliberately ordered as an argument: the draws are fair
 * (`stats`), no strategy beats chance (`backtest`), but players are predictable
 * (`bias`), which makes some tickets worth more than others (`ev`, `pick`).
 */

import { c, table } from "../ui/format.ts";
import {
  datasetAnomalies,
  drawsFor,
  loadDataset,
  requireDataset,
  type Game,
} from "../baloto/dataset.ts";
import { updateHistory } from "../baloto/update.ts";
import { realMismatches } from "../baloto/source.ts";
import { analyse } from "../baloto/stats.ts";
import { backtest, defaultStrategies } from "../baloto/backtest.ts";
import {
  fitBiasModel,
  summariseBias,
  uniformModel,
  usableObservations,
  validateBiasModel,
  type BiasModel,
} from "../baloto/bias.ts";
import { expectedValue } from "../baloto/ev.ts";
import { pickTickets } from "../baloto/pick.ts";
import {
  ECONOMICS,
  MAIN_POOL,
  MAIN_PICK,
  SUPER_POOL,
  TOTAL_COMBINATIONS,
  anyPrizeProbability,
} from "../baloto/rules.ts";

const money = (value: number): string =>
  `$${Math.round(value).toLocaleString("es-CO")}`;

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function parseGame(value: string | undefined): Game {
  return value === "revancha" ? "revancha" : "baloto";
}

/** Parse "3,7,12,17,23+7" or "3 7 12 17 23 7" into a ticket. */
export function parseTicket(input: string): { main: number[]; super: number } {
  const numbers = (input.match(/\d+/g) ?? []).map(Number);
  if (numbers.length !== MAIN_PICK + 1) {
    throw new Error(
      `A ticket needs ${MAIN_PICK} numbers plus the Súper Balota, e.g. "3,7,12,17,23+7".`,
    );
  }
  const main = numbers.slice(0, MAIN_PICK).sort((a, b) => a - b);
  const superBall = numbers[MAIN_PICK]!;
  if (new Set(main).size !== MAIN_PICK) throw new Error("The five numbers must be different.");
  for (const n of main) {
    if (n < 1 || n > MAIN_POOL) throw new Error(`Numbers must be between 1 and ${MAIN_POOL}.`);
  }
  if (superBall < 1 || superBall > SUPER_POOL) {
    throw new Error(`The Súper Balota must be between 1 and ${SUPER_POOL}.`);
  }
  return { main, super: superBall };
}

export async function updateCommand(opts: {
  full?: boolean;
  prizes?: boolean;
  verify?: boolean;
}): Promise<void> {
  const result = await updateHistory({
    full: opts.full,
    skipPrizes: opts.prizes === false,
    verify: opts.verify,
    onProgress: (message) => console.log(c.dim(message)),
  });

  console.log("");
  console.log(c.bold("Dataset"));
  console.log(`  draws stored:        ${result.dataset.draws.length}`);
  console.log(`  with prize details:  ${result.withPrizes}`);
  if (result.rejected > 0) {
    console.log(c.yellow(`  rejected (old format): ${result.rejected}`));
  }

  for (const report of result.verification) {
    const real = realMismatches(report);
    const defects = report.mismatches.length - real.length;
    const line =
      `  ${report.year}: ${report.compared} cross-checked, ${real.length} genuine mismatch(es)` +
      (defects > 0 ? c.dim(` (+${defects} known defect(s) in the second archive)`) : "");
    console.log(real.length === 0 ? c.green(line) : c.yellow(line));
  }
  console.log("");
  console.log(c.dim("Next: `bancolombia baloto stats`"));
}

export async function statsCommand(opts: {
  game?: string;
  sims?: string;
}): Promise<void> {
  const dataset = await requireDataset();
  const game = parseGame(opts.game);
  const draws = drawsFor(dataset, game);
  const simulations = opts.sims ? Number.parseInt(opts.sims, 10) : 5000;

  const anomalies = datasetAnomalies(dataset).filter((a) => a.game === game);
  const report = analyse(draws, simulations);

  console.log(c.bold(`Baloto — ${game}, ${report.draws} draws (${report.from} → ${report.to})`));
  if (anomalies.length > 0) {
    console.log(c.dim(`  ${anomalies.length} archive artefact(s) removed:`));
    for (const a of anomalies) console.log(c.dim(`    ${a.date}: ${a.reason}`));
  }
  console.log("");

  console.log(c.bold("Is the machine fair?"));
  console.log(
    c.dim(`  Each statistic is compared against ${report.simulations.toLocaleString()} simulated fair histories.`),
  );
  console.log(
    table(
      ["TEST", "STATISTIC", "IF FAIR", "P-VALUE", "READING"],
      report.tests.map((t) => [
        t.id,
        t.statistic.toFixed(1),
        t.expected.toFixed(1),
        t.pValue.toFixed(3),
        t.verdict === "consistent with chance" ? c.green(t.verdict) : c.yellow(t.verdict),
      ]),
    ),
  );
  console.log("");

  const hottest = [...report.mainFrequencies].sort((a, b) => b.count - a.count);
  console.log(c.bold("Most and least drawn numbers"));
  console.log(
    table(
      ["", "NUMBER", "TIMES", "DEVIATION"],
      [
        ...hottest.slice(0, 3).map((f) => ["hot", String(f.number), String(f.count), `${f.z >= 0 ? "+" : ""}${f.z.toFixed(2)} σ`]),
        ...hottest.slice(-3).map((f) => ["cold", String(f.number), String(f.count), `${f.z >= 0 ? "+" : ""}${f.z.toFixed(2)} σ`]),
      ],
    ),
  );
  const extreme = Math.max(...report.mainFrequencies.map((f) => Math.abs(f.z)));
  console.log("");
  console.log(
    c.dim(
      `  The largest deviation is ${extreme.toFixed(2)} standard deviations. With ${MAIN_POOL} numbers,\n` +
        "  a fair machine produces a spread like this almost every time.",
    ),
  );

  const failing = report.tests.filter((t) => t.verdict !== "consistent with chance");
  console.log("");
  if (failing.length === 0) {
    console.log(
      c.green("Verdict: nothing in this history distinguishes Baloto from a fair random draw."),
    );
    console.log(
      c.dim("Past results therefore carry no information about future ones — see `baloto backtest`."),
    );
  } else {
    console.log(c.yellow(`Verdict: ${failing.length} test(s) worth a second look: ${failing.map((t) => t.id).join(", ")}.`));
    console.log(c.dim("Re-run with a larger --sims before drawing conclusions."));
  }
}

export async function backtestCommand(opts: {
  game?: string;
  window?: string;
  warmup?: string;
}): Promise<void> {
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, parseGame(opts.game));
  const window = opts.window ? Number.parseInt(opts.window, 10) : 100;
  const warmup = opts.warmup ? Number.parseInt(opts.warmup, 10) : 100;

  const report = backtest(draws, defaultStrategies(window), warmup);

  console.log(c.bold(`Do the popular systems work? ${report.evaluated} draws scored`));
  console.log(
    c.dim(
      `  Every strategy sees only the draws before the one it bets on.\n` +
        `  Pure chance yields ${report.chanceMatches.toFixed(4)} matched numbers per ticket.`,
    ),
  );
  console.log("");
  console.log(
    table(
      ["STRATEGY", "MATCHES/TICKET", "VS CHANCE", "PRIZES", "DESCRIPTION"],
      report.results.map((r) => [
        r.id,
        `${r.meanMatches.toFixed(4)} ± ${r.standardError.toFixed(4)}`,
        `${r.z >= 0 ? "+" : ""}${r.z.toFixed(2)} σ`,
        `${((r.prizesWon / r.tickets) * 100).toFixed(1)}%`,
        c.dim(r.description),
      ]),
    ),
  );

  const significant = report.results.filter((r) => Math.abs(r.z) > 2);
  console.log("");
  if (significant.length === 0) {
    console.log(
      c.green("No strategy beats a random ticket: every one sits within 2 σ of pure chance."),
    );
  } else {
    console.log(c.yellow(`Outside 2 σ: ${significant.map((s) => s.id).join(", ")}. Treat with suspicion — with ${report.results.length} strategies tested, the occasional 2 σ result is expected.`));
  }
  console.log(
    c.dim(
      `  Note the "birthdays" row: choosing dates does not change your odds at all.\n` +
        "  It changes how many people you split the prize with — see `baloto bias`.",
    ),
  );
}

/** Fit the preference model, or explain why it cannot be fitted. */
async function loadBiasModel(game: Game): Promise<{ model: BiasModel; fitted: boolean }> {
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, game);
  if (usableObservations(draws) < 50) {
    console.log(
      c.yellow(
        "Not enough published prize breakdowns to estimate how players pick.\n" +
          "Run `bancolombia baloto update --full` (without --no-prizes) first.\n" +
          "Falling back to assuming everybody plays random quick-picks.",
      ),
    );
    return { model: uniformModel(), fitted: false };
  }
  return { model: fitBiasModel(draws), fitted: true };
}

export async function biasCommand(opts: { game?: string }): Promise<void> {
  const game = parseGame(opts.game);
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, game);
  const { model, fitted } = await loadBiasModel(game);
  if (!fitted) return;

  const summary = summariseBias(model);
  const holdout = validateBiasModel(draws);

  console.log(c.bold(`How Colombians pick their numbers — ${model.observations} draws with published winner counts`));
  console.log(
    c.dim(
      "  Nobody publishes what people played, but the number of winners in each\n" +
        "  category does. A draw full of low numbers pays out to far more tickets,\n" +
        "  and that is enough to recover the crowd's preferences.",
    ),
  );
  console.log("");

  console.log(c.bold("Estimated preferences"));
  console.log(
    table(
      ["EFFECT", "WEIGHT", "MEANING"],
      model.mainCoefficients.map((coefficient) => [
        coefficient.name,
        `${coefficient.value >= 0 ? "+" : ""}${coefficient.value.toFixed(3)}`,
        c.dim(coefficient.description),
      ]),
    ),
  );
  console.log("");

  console.log(
    `  Numbers 1–31 are played ${c.bold(`${summary.dateBiasRatio.toFixed(2)}×`)} as often as 32–43 — the birthday effect.`,
  );
  console.log(
    `  Most over-played: ${summary.overPicked.slice(0, 5).map((o) => `${o.number} (${o.lift.toFixed(2)}×)`).join(", ")}`,
  );
  console.log(
    `  Most neglected:  ${summary.underPicked.slice(0, 5).map((o) => `${o.number} (${o.lift.toFixed(2)}×)`).join(", ")}`,
  );
  console.log(
    `  Súper Balota favourite: ${summary.superLift[0]!.number} (${summary.superLift[0]!.lift.toFixed(2)}×), least played: ${summary.superLift.at(-1)!.number} (${summary.superLift.at(-1)!.lift.toFixed(2)}×)`,
  );
  console.log("");
  console.log(`  Implied tickets sold per draw (median): ${c.bold(Math.round(summary.medianTickets).toLocaleString("es-CO"))}`);
  console.log("");

  console.log(c.bold("Does this generalise?"));
  console.log(
    c.dim(
      `  Fitted on the first ${holdout.trainDraws} draws, scored on the last ${holdout.testDraws}.`,
    ),
  );
  const line = holdout.generalises
    ? c.green("  Yes — the preferences predict draws the model never saw.")
    : c.yellow("  No — the fitted preferences do not transfer. Treat them as noise.");
  console.log(line);
  console.log("");
  console.log(
    c.dim(
      "This is the one exploitable fact about Baloto: the balls are unpredictable,\n" +
        "but the players are not. Every category is pari-mutuel, so an unpopular\n" +
        "combination is split between fewer winners. See `baloto ev` and `baloto pick`.",
    ),
  );
}

export async function evCommand(
  ticketInput: string | undefined,
  opts: { game?: string; jackpot?: string; tickets?: string; price?: string; tax?: boolean },
): Promise<void> {
  const game = parseGame(opts.game);
  const { model } = await loadBiasModel(game);
  const summary = summariseBias(model);

  const ticket = ticketInput ? parseTicket(ticketInput) : { main: [1, 2, 3, 4, 5], super: 6 };
  const jackpot = opts.jackpot
    ? Number(opts.jackpot.replace(/[^\d]/g, ""))
    : ECONOMICS.minimumJackpot;
  const ticketsSold = opts.tickets
    ? Number(opts.tickets.replace(/[^\d]/g, ""))
    : Math.round(summary.medianTickets) || 300_000;
  const ticketPrice = opts.price ? Number(opts.price.replace(/[^\d]/g, "")) : ECONOMICS.ticketPrice;

  const report = expectedValue(ticket, model, {
    jackpot,
    ticketsSold,
    ticketPrice,
    afterTax: opts.tax === true,
  });

  console.log(
    c.bold(`Ticket ${ticket.main.join("-")} + Súper Balota ${ticket.super}`),
  );
  console.log(
    c.dim(
      `  Jackpot ${money(jackpot)} · ${ticketsSold.toLocaleString("es-CO")} tickets sold · ` +
        `${money(ticketPrice)} per ticket${report.taxed ? " · after 20% withholding" : ""}`,
    ),
  );
  console.log("");

  console.log(
    table(
      ["CATEGORY", "ODDS", "CO-WINNERS", "VALUE"],
      report.tiers.map((t) => [
        t.label,
        `1 in ${Math.round(1 / t.probability).toLocaleString("es-CO")}`,
        t.expectedWinners.toFixed(t.expectedWinners < 10 ? 3 : 0),
        money(t.contribution),
      ]),
    ),
  );
  console.log("");

  console.log(
    `  This combination is played ${c.bold(`${report.popularityRatio.toFixed(2)}×`)} as often as an average one.`,
  );
  console.log(
    `  Expected people sharing your jackpot: ${report.expectedJackpotSharers.toFixed(4)} ` +
      c.dim(`(an average ticket: ${report.averageJackpotSharers.toFixed(4)})`),
  );
  console.log("");
  console.log(
    `  ${c.bold("Expected value")}: ${money(report.expectedValue)} per ${money(ticketPrice)} ticket ` +
      `— you get back ${c.bold(pct(report.returnToPlayer))} of what you stake.`,
  );
  if (report.breakevenJackpot !== null) {
    console.log(
      `  A ticket only breaks even once the jackpot passes ${c.bold(money(report.breakevenJackpot))}.`,
    );
  }
  console.log("");
  console.log(
    c.dim(
      `  Chance of winning something: 1 in ${(1 / anyPrizeProbability()).toFixed(1)}.\n` +
        `  Chance of the jackpot: 1 in ${TOTAL_COMBINATIONS.toLocaleString("es-CO")}.`,
    ),
  );
}

export async function profileCommand(opts: {
  game?: string;
  sims?: string;
}): Promise<void> {
  const dataset = await requireDataset();
  const game = parseGame(opts.game);
  const draws = drawsFor(dataset, game);
  const simulated = opts.sims ? Number.parseInt(opts.sims, 10) : 200_000;

  const { profileDraws } = await import("../baloto/profile.ts");
  const report = profileDraws(draws, simulated);

  console.log(
    c.bold(
      `${report.draws} real draws vs ${report.simulatedDraws.toLocaleString("es-CO")} from a machine that is fair by construction`,
    ),
  );
  console.log(
    c.dim(
      "  Every structural property someone might notice in a result, compared\n" +
        "  against a simulated fair machine — on its average and on the shape of\n" +
        "  its whole distribution.",
    ),
  );
  console.log("");

  console.log(
    table(
      ["PROPERTY", "REAL", "IF FAIR", "DIFF", "P (ADJ.)", "WHAT IT MEASURES"],
      report.features.map((f) => [
        f.name,
        f.observed.toFixed(2),
        f.expected.toFixed(2),
        `${f.z >= 0 ? "+" : ""}${f.z.toFixed(2)} σ`,
        f.adjustedPValue >= 0.999 ? "1.00" : f.adjustedPValue.toFixed(3),
        c.dim(f.description),
      ]),
    ),
  );
  console.log("");
  console.log(
    c.dim(
      `  ${report.features.length} properties × 2 tests each = ${report.features.length * 2} comparisons,\n` +
        "  with Holm's correction applied so that testing many things at once cannot\n" +
        "  manufacture a discovery.",
    ),
  );
  console.log("");

  if (report.patternsFound === 0) {
    console.log(
      c.green(
        "No pattern. Every property of the real draws sits where a fair machine puts it.",
      ),
    );
    if (report.falseLeads > 0) {
      console.log(
        c.dim(
          `  ${report.falseLeads} would have looked like a finding at p < 0.05 without the correction —\n` +
            "  which is exactly how lottery 'systems' get invented.",
        ),
      );
    }
  } else {
    console.log(
      c.yellow(
        `${report.patternsFound} property still stands out after correction: ` +
          report.features.filter((f) => f.significant).map((f) => f.name).join(", "),
      ),
    );
    console.log(c.dim("  Worth re-running with a larger --sims before believing it."));
  }
}

export async function physicalCommand(opts: {
  game?: string;
  windows?: string;
  sims?: string;
}): Promise<void> {
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, parseGame(opts.game));
  const windows = (opts.windows ?? "50,100,200")
    .split(",")
    .map((w) => Number.parseInt(w.trim(), 10))
    .filter((w) => Number.isFinite(w) && w > 0);
  const sims = opts.sims ? Number.parseInt(opts.sims, 10) : 300;

  const { scanForLocalBias, biasPowerCurve, breakevenBias } = await import(
    "../baloto/physical.ts"
  );

  console.log(c.bold("1. Is a ball running hot in some stretch of the history?"));
  console.log(
    c.dim(
      "  Ball sets get rotated and retired, so a bias lasting a few months would\n" +
        "  be averaged into invisibility across eight years. This scans every window\n" +
        "  instead, and compares the largest deviation found against the largest a\n" +
        "  fair machine produces under the same search.",
    ),
  );
  console.log("");

  const scan = scanForLocalBias(draws, windows, sims);
  console.log(`  ${scan.comparisons.toLocaleString("es-CO")} window-and-ball combinations examined`);
  console.log(`  largest deviation found:        ${scan.observedMaxZ.toFixed(2)} σ`);
  console.log(`  a fair machine typically gives: ${scan.expectedMaxZ.toFixed(2)} σ`);
  console.log(`  it exceeds ${scan.criticalMaxZ.toFixed(2)} σ only 5% of the time`);
  console.log("");
  if (scan.hottest) {
    const hot = scan.hottest;
    console.log(
      `  Hottest stretch: ball ${c.bold(String(hot.number))} came up ${hot.count} times in the ` +
        `${hot.windowSize} draws\n  between ${hot.from} and ${hot.to} — ${hot.expected.toFixed(1)} expected, ${hot.z.toFixed(2)} σ.`,
    );
    console.log(
      c.dim(
        "  This is what a biased ball would look like. Check whether it kept running\n" +
          "  hot afterwards before believing it — a scan this wide always finds one.",
      ),
    );
  }
  console.log("");
  console.log(
    scan.biasFound
      ? c.yellow("  A stretch exceeds what chance explains. Worth a closer look.")
      : c.green("  Nothing exceeds chance — the real history is calmer than a fair machine."),
  );

  console.log("");
  console.log(c.bold("2. How large would a bias have to be before this data could see it?"));
  console.log(
    c.dim(
      "  A clean result is only worth as much as the test's power. This simulates\n" +
        "  five genuinely heavy balls and asks how often the test notices.",
    ),
  );
  console.log("");
  const curve = biasPowerCurve(draws.length, [0.05, 0.1, 0.15, 0.2, 0.3, 0.5], Math.min(sims, 200));
  console.log(
    table(
      ["BALL IS HEAVIER BY", "CHANCE OF NOTICING", "DEVIATION IT WOULD LEAVE"],
      curve.map((point) => [
        `+${(point.bias * 100).toFixed(0)}%`,
        `${(point.detectionRate * 100).toFixed(0)}%`,
        `${point.typicalZ.toFixed(2)} σ`,
      ]),
    ),
  );

  console.log("");
  console.log(c.bold("3. And how large would it have to be to matter?"));
  const { model } = await loadBiasModel(parseGame(opts.game));
  const summary = summariseBias(model);
  const reference = expectedValue({ main: [6, 23, 32, 37, 38], super: 2 }, model, {
    jackpot: 53_200_000_000,
    ticketsSold: Math.round(summary.medianTickets) || 300_000,
    samples: 1200,
  });
  const jackpotPart = reference.tiers[0]!.contribution;
  const rest = reference.expectedValue - jackpotPart;
  const needed = breakevenBias(jackpotPart, rest, reference.ticketPrice);
  console.log("");
  console.log(
    `  A ticket returns ${pct(reference.returnToPlayer)} today. Five balls would each have to be\n` +
      `  ${c.bold(`${(needed * 100).toFixed(1)}% heavier`)} than they should be just to reach break-even.`,
  );
  console.log("");
  console.log(
    c.dim(
      "  Read rows 2 and 3 together. A bias that size would be spotted only a few\n" +
        "  percent of the time — so it cannot be ruled out. But it equally cannot be\n" +
        "  located, and a bias you cannot attribute to specific balls is one you\n" +
        "  cannot bet on. `baloto backtest` is the direct test of trying anyway.",
    ),
  );
}

export async function realizedCommand(opts: { game?: string }): Promise<void> {
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, parseGame(opts.game));
  const { backtestSelection } = await import("../baloto/realized.ts");
  const report = backtestSelection(draws);

  console.log(c.bold("Number selection, backtested in pesos that were actually paid"));
  console.log(
    c.dim(
      `  A selection rule is scored against the numbers that really came out and\n` +
        `  the per-winner prizes really published. Learned on ${report.trainDraws} draws\n` +
        `  (${report.trainFrom} → ${report.trainTo}), validated on ${report.testDraws} unseen ones\n` +
        `  (${report.testFrom} → ${report.testTo}). The jackpot tier is excluded: it has\n` +
        "  fallen 14 times ever, which is noise, not signal.",
    ),
  );
  console.log("");
  console.log(
    table(
      ["RULE (γ)", "TRAIN $/TICKET", "TEST $/TICKET"],
      report.points.map((p) => [
        p.gamma === -1 ? "-1 imitate the crowd" : p.gamma === 0 ? " 0 uniform quick-pick" : ` ${p.gamma} lean against`,
        money(p.trainValue),
        money(p.testValue),
      ]),
    ),
  );
  console.log("");
  console.log(`  Learned on TRAIN: γ = ${c.bold(String(report.learnedGamma))} (the most contrarian in range).`);
  console.log(
    `  On unseen draws it realised ${c.bold(money(report.testLearned))} per ticket against ` +
      `${money(report.testCrowdLike)} for a crowd-like ticket — ${c.bold(pct(report.testLearned / report.testCrowdLike - 1))} more, in real payouts.`,
  );
  console.log(
    `  Win rate on the same draws: ${pct(report.winRateLearned)} vs ${pct(report.winRateCrowdLike)} — ` +
      c.dim("the odds never moved; only the pesos per win did."),
  );
  console.log("");
  console.log(
    c.dim(
      "  This is the sharing mechanism, measured where it can be (thousands of\n" +
        "  pari-mutuel payouts) — the same mechanism the EV model applies to the\n" +
        "  jackpot, where only 14 events exist to test it directly.",
    ),
  );
}

export async function chaosCommand(opts: {
  epsilon?: string;
  duration?: string;
}): Promise<void> {
  const { DEFAULT_CHAMBER, measureLyapunov, predictabilityHorizons } = await import(
    "../baloto/chaos.ts"
  );
  const epsilon = opts.epsilon ? Number(opts.epsilon) : 1e-9;
  const duration = opts.duration ? Number(opts.duration) : 3;

  console.log(c.bold("Could the machine be simulated? The twin experiment"));
  console.log(
    c.dim(
      "  Two identical, fully deterministic simulations of the ball chamber —\n" +
        `  ${DEFAULT_CHAMBER.balls} balls, gravity, an air jet, elastic collisions — with a single\n` +
        `  ball displaced by ${epsilon.toExponential(0)} metres in one of them.`,
    ),
  );
  console.log("");

  const report = measureLyapunov(DEFAULT_CHAMBER, epsilon, duration);
  console.log(`  collisions per ball per second: ${report.collisionRate.toFixed(0)}`);
  console.log(
    `  Lyapunov exponent λ = ${c.bold(report.lambda.toFixed(1))} per second — the error ` +
      `${c.bold(`doubles every ${(report.doublingTime * 1000).toFixed(0)} ms`)}.`,
  );

  const landmarks = report.trace.filter(
    (point, i) => i > 0 && i % Math.max(1, Math.floor(report.trace.length / 6)) === 0,
  );
  console.log("");
  console.log(
    table(
      ["TIME", "SEPARATION BETWEEN THE TWINS"],
      landmarks.map((point) => [
        `${point.t.toFixed(2)} s`,
        point.separation < 1e-3
          ? `${point.separation.toExponential(1)} m`
          : c.yellow(`${point.separation.toFixed(2)} m — fully decorrelated`),
      ]),
    ),
  );

  console.log("");
  console.log(c.bold("How long a prediction survives"));
  console.log(
    c.dim("  Foresight ends when the amplified error fills the chamber: t = ln(L/δ)/λ."),
  );
  console.log("");
  console.log(
    table(
      ["IF THE START WERE KNOWN TO…", "PREDICTION SURVIVES"],
      predictabilityHorizons(report.lambda).map((row) => [
        row.label,
        `${row.horizon.toFixed(2)} s`,
      ]),
    ),
  );

  console.log("");
  console.log(
    c.yellow(
      "  A real draw mixes the balls for tens of seconds. Even knowledge at the\n" +
        "  Planck length — beyond which position has no physical meaning — buys a\n" +
        "  second or two. This is why roulette was beatable (a few bounces) and a\n" +
        "  lottery machine is not (thousands of collisions): the machine is not\n" +
        "  merely hard to simulate, it is an entropy generator by design.",
    ),
  );
}

export async function pcaCommand(opts: {
  game?: string;
  histories?: string;
}): Promise<void> {
  const dataset = await requireDataset();
  const game = parseGame(opts.game);
  const draws = drawsFor(dataset, game);
  const histories = opts.histories ? Number.parseInt(opts.histories, 10) : 200;

  const { comparePcaToFair, regressWinnerCrowding } = await import("../baloto/pca.ts");

  console.log(c.bold("1. Principal components of the draws — is there latent structure?"));
  console.log(
    c.dim(
      "  PCA on which balls came out in each of the " + draws.length + " draws.\n" +
        "  A hidden factor would show up as a component carrying more variance than\n" +
        "  chance allows — so each is compared against fair machines, not against a\n" +
        "  flat line (in any finite sample the first component is always the largest).",
    ),
  );
  console.log("");

  const pca = comparePcaToFair(draws, histories);
  console.log(
    table(
      ["COMPONENT", "REAL", "IF FAIR", "CHANCE LIMIT"],
      pca.components.map((component) => [
        `PC${component.index}`,
        `${(component.observed * 100).toFixed(2)}%`,
        `${(component.expected * 100).toFixed(2)}%`,
        `${(component.upperBound * 100).toFixed(2)}%`,
      ]),
    ),
  );
  console.log("");
  if (pca.structureFound === 0) {
    console.log(
      c.green("  No component carries more variance than a fair machine produces."),
    );
    console.log(
      c.dim(
        "  There is no latent factor to find, so there is nothing for a predictive\n" +
          "  model to learn. PCA cannot say more than this: it never sees an outcome.",
      ),
    );
  } else {
    console.log(
      c.yellow(`  ${pca.structureFound} component(s) exceed chance — worth investigating.`),
    );
  }

  console.log("");
  console.log(c.bold("2. What DOES have an answer: why some winning numbers are worth less"));
  console.log(
    c.dim(
      "  Same draws, but now with a real response variable — the share of winners\n" +
        "  who matched three or more numbers. It rises when the numbers that came out\n" +
        "  were ones many players had already written down.",
    ),
  );
  console.log("");

  const regression = regressWinnerCrowding(draws);
  if (regression.terms.length === 0) {
    console.log(c.yellow("  Not enough published prize breakdowns for this regression."));
    return;
  }

  console.log(
    table(
      ["PROPERTY", "EFFECT", "t", "READING"],
      regression.terms.map((term) => [
        term.name,
        `${term.beta >= 0 ? "+" : ""}${term.beta.toFixed(3)}`,
        term.tStatistic.toFixed(2),
        term.significant
          ? c.yellow(term.beta > 0 ? "more people share it" : "fewer people share it")
          : c.dim("no clear effect"),
      ]),
    ),
  );
  console.log("");
  console.log(
    `  ${regression.observations} draws · the model explains ${c.bold(pct(regression.rSquared))} of how much prizes are shared.`,
  );
  console.log("");
  console.log(
    c.dim(
      "  Read the two halves together: nothing predicts WHICH numbers come out,\n" +
        "  but several things predict HOW MANY people already had them.",
    ),
  );
}

export async function pickCommand(opts: {
  game?: string;
  count?: string;
  pool?: string;
  seed?: string;
  jackpot?: string;
  typical?: boolean;
  coverage?: string;
}): Promise<void> {
  const game = parseGame(opts.game);
  const { model, fitted } = await loadBiasModel(game);
  const summary = summariseBias(model);

  const count = opts.count ? Number.parseInt(opts.count, 10) : 5;
  const { pickReport } = await import("../baloto/pick.ts");
  const report = pickReport(model, {
    count,
    pool: opts.pool ? Number.parseInt(opts.pool, 10) : 400,
    typical: opts.typical === true,
    typicalCoverage: opts.coverage ? Number(opts.coverage) : 0.8,
    seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
  });
  const tickets = report.tickets;

  const jackpot = opts.jackpot
    ? Number(opts.jackpot.replace(/[^\d]/g, ""))
    : ECONOMICS.minimumJackpot;
  const ticketsSold = Math.round(summary.medianTickets) || 300_000;

  console.log(c.bold(`${tickets.length} ticket(s) chosen to be split with as few people as possible`));
  console.log(
    c.dim(
      "  These are NOT more likely to win — no combination is. They are combinations\n" +
        "  other players avoid, so a prize would be divided between fewer winners.",
    ),
  );
  console.log("");

  const rows = tickets.map((t) => {
    const ev = expectedValue(t.ticket, model, { jackpot, ticketsSold, samples: 800 });
    return [
      `${t.ticket.main.map((n) => String(n).padStart(2, "0")).join(" ")}  +  ${String(t.ticket.super).padStart(2, "0")}`,
      `${t.popularityRatio.toFixed(2)}×`,
      `#${t.rank}`,
      pct(ev.returnToPlayer),
    ];
  });
  console.log(table(["NUMBERS", "POPULARITY", "RANK", "RETURN"], rows));
  console.log("");
  console.log(
    c.dim(
      `  Chosen from the ${report.eligible.toLocaleString("es-CO")} least-played combinations that meet the
` +
        `  constraints; the very best of them is ${report.floor.toFixed(2)}×.` +
        (opts.typical === true
          ? ` Dropping the "looks plausible" rule
  would reach ${report.unconstrainedFloor.toFixed(2)}× — that is what appearance costs.`
          : ""),
    ),
  );
  console.log("");

  if (fitted) {
    const average = expectedValue({ main: [3, 7, 12, 17, 23], super: 7 }, model, {
      jackpot,
      ticketsSold,
      samples: 800,
    });
    console.log(
      c.dim(
        `  For comparison, a typical "birthdays" ticket (3-7-12-17-23 + 7) is played ` +
          `${average.popularityRatio.toFixed(2)}× as often\n  and returns ${pct(average.returnToPlayer)} at the same jackpot.`,
      ),
    );
    console.log("");
  }
  console.log(
    c.yellow(
      "  Even the best ticket here is a losing bet in expectation. The edge is real\n" +
        "  but small; it makes the loss smaller, not the game profitable.",
    ),
  );
}

export async function summaryCommand(): Promise<void> {
  const dataset = await loadDataset();
  console.log(c.bold("bancolombia baloto — what the data says"));
  console.log("");
  console.log(`  ${c.cyan("baloto update")}    Download and cross-check the draw history`);
  console.log(`  ${c.cyan("baloto stats")}     Test whether the machine is fair`);
  console.log(`  ${c.cyan("baloto backtest")}  Score hot/cold/due systems against chance`);
  console.log(`  ${c.cyan("baloto profile")}   Compare the real draws to a simulated fair machine`);
  console.log(`  ${c.cyan("baloto physical")}  Hunt for a biased ball, and measure the power to find one`);
  console.log(`  ${c.cyan("baloto chaos")}     Simulate the chamber itself and measure its predictability`);
  console.log(`  ${c.cyan("baloto pca")}       Principal components, and what predicts prize sharing`);
  console.log(`  ${c.cyan("baloto bias")}      Measure how players choose their numbers`);
  console.log(`  ${c.cyan("baloto ev")}        Price a ticket, with pari-mutuel splitting and tax`);
  console.log(`  ${c.cyan("baloto realized")}  Backtest the selection rule in actually-paid pesos`);
  console.log(`  ${c.cyan("baloto pick")}      Generate combinations the crowd avoids`);
  console.log("");
  if (dataset) {
    console.log(
      c.dim(
        `  ${dataset.draws.length} draws stored, last updated ${new Date(dataset.updatedAt).toLocaleDateString("es-CO")}.`,
      ),
    );
  } else {
    console.log(c.yellow("  No data yet — start with `bancolombia baloto update`."));
  }
}

/**
 * `baloto super` — the model whose only objective is hitting the Súper Balota.
 *
 * It reports three things in order of how much they matter: the tournament
 * (nothing predicts which ball comes out), the coverage arithmetic (the only
 * real lever, and it is exact), and the tickets that follow from both.
 */
export async function superCommand(opts: {
  game?: string;
  tickets?: string;
  prior?: string;
  warmup?: string;
  typical?: boolean;
  seed?: string;
}): Promise<void> {
  const game = parseGame(opts.game);
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, game);
  const tickets = opts.tickets ? Number.parseInt(opts.tickets, 10) : 3;
  const priorStrength = opts.prior ? Number(opts.prior) : 1;

  const { planSuperCoverage, scoreSuperRules, superPosterior } = await import(
    "../baloto/superball.ts"
  );
  const { model } = await loadBiasModel(game);

  console.log(c.bold(`Súper Balota — ${draws.length.toLocaleString("es-CO")} draws of ${game}`));
  console.log("");

  // 1. Does anything predict the ball at all?
  const warmup = opts.warmup ? Number.parseInt(opts.warmup, 10) : 400;
  const rules = [
    {
      name: "highest posterior (hot)",
      choose: (past: typeof draws, n: number) =>
        superPosterior(past, priorStrength)
          .sort((a, b) => b.mean - a.mean)
          .slice(0, n)
          .map((p) => p.ball),
    },
    {
      name: "lowest posterior (cold)",
      choose: (past: typeof draws, n: number) =>
        superPosterior(past, priorStrength)
          .sort((a, b) => a.mean - b.mean)
          .slice(0, n)
          .map((p) => p.ball),
    },
    {
      name: "avoid the last three drawn",
      choose: (past: typeof draws, n: number) => {
        const recent = new Set(past.slice(-3).map((d) => d.super));
        return Array.from({ length: SUPER_POOL }, (_, i) => i + 1)
          .filter((b) => !recent.has(b))
          .slice(0, n);
      },
    },
    {
      name: "repeat the last three drawn",
      choose: (past: typeof draws, n: number) =>
        [...new Set(past.slice(-6).map((d) => d.super))].slice(0, n),
    },
    {
      name: "fixed 1-2-3",
      choose: (_: typeof draws, n: number) => [1, 2, 3].slice(0, n),
    },
    {
      name: "least played by the crowd",
      choose: (_: typeof draws, n: number) =>
        model.super
          .map((w, i) => ({ ball: i + 1, w }))
          .sort((a, b) => a.w - b.w)
          .slice(0, n)
          .map((x) => x.ball),
    },
  ];
  const scores = scoreSuperRules(draws, rules, tickets, warmup);
  const base = tickets / SUPER_POOL;
  console.log(
    c.dim(
      `  Walk-forward over ${scores[0]?.draws.toLocaleString("es-CO") ?? 0} draws. Any ${tickets} distinct balls hit at exactly ` +
        `${pct(base)};\n  a rule only means something if it clears that by more than the field allows.`,
    ),
  );
  console.log("");
  console.log(
    table(
      ["RULE", "HITS", "RATE", "Z", "REAL?"],
      scores
        .slice()
        .sort((a, b) => b.rate - a.rate)
        .map((s) => [
          s.name,
          `${s.hits}/${s.draws}`,
          pct(s.rate),
          `${s.z >= 0 ? "+" : ""}${s.z.toFixed(2)}`,
          s.beatsChance ? c.green("yes") : c.dim("no"),
        ]),
    ),
  );
  console.log("");

  // 2. The posterior, and whether any ball is separable at all.
  const posterior = superPosterior(draws, priorStrength);
  const plan = planSuperCoverage(draws, tickets, {
    priorStrength,
    superWeights: model.super,
  });
  if (plan.distinguishable.length === 0) {
    console.log(
      c.dim(
        `  No ball is distinguishable from 1/16 once all sixteen intervals are read at once.\n` +
          `  The posterior spans ${plan.spreadPoints.toFixed(2)} points best to worst, which is what a fair machine gives.`,
      ),
    );
  } else {
    console.log(
      c.yellow(`  Distinguishable from 1/16: ${plan.distinguishable.join(", ")}`),
    );
  }
  console.log("");

  // 3. The plan.
  console.log(
    c.bold(
      `  ${tickets} ticket(s) → ${pct(plan.hitProbability)} chance of matching the Súper Balota ` +
        `(${pct(plan.singleTicket)} on one)`,
    ),
  );
  const order =
    plan.rule === "posterior"
      ? "ranked by posterior mean — a ball here is genuinely likelier"
      : plan.rule === "least-played"
        ? `ranked by how few people play them (${plan.crowding.toFixed(2)}× the average crowd), ` +
          "which costs nothing:\n  the hit probability above is exact whichever sixteenths you cover"
        : "in no particular order — nothing separates them";
  console.log(c.dim(`  Balls ${plan.balls.join(", ")}, ${order}.`));
  console.log("");

  const { pickReport } = await import("../baloto/pick.ts");
  const report = pickReport(model, {
    count: tickets,
    pool: 400,
    typical: opts.typical === true,
    seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
  });
  const rows = report.tickets.map((t, i) => [
    t.ticket.main.map((n) => String(n).padStart(2, "0")).join(" "),
    String(plan.balls[i] ?? t.ticket.super).padStart(2, "0"),
    `${(model.super[(plan.balls[i] ?? t.ticket.super) - 1]! * SUPER_POOL).toFixed(2)}×`,
  ]);
  console.log(table(["MAIN NUMBERS", "SÚPER", "CROWD ON THAT SÚPER"], rows));
  console.log("");
  console.log(
    c.dim(
      "  The five main numbers are free: the objective above does not constrain them,\n" +
        "  so they are taken from the least-played combinations. A Súper Balota hit pays\n" +
        "  something at any number of main matches, so every hit is a winning ticket.",
    ),
  );
  console.log("");
  console.log(
    c.yellow(
      `  ${pct(plan.hitProbability)} is the probability of hitting the Súper Balota, not of winning the jackpot.\n` +
        "  The jackpot still needs all five main numbers as well, at 1 in 962 598.",
    ),
  );
}
