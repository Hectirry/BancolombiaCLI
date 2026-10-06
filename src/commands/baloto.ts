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
  official?: boolean;
}): Promise<void> {
  const result = await updateHistory({
    full: opts.full,
    skipPrizes: opts.prizes === false,
    verify: opts.verify,
    official: opts.official !== false,
    onProgress: (message) => console.log(c.dim(message)),
  });

  console.log("");
  console.log(c.bold("Dataset"));
  console.log(`  draws stored:        ${result.dataset.draws.length}`);
  console.log(`  with prize details:  ${result.withPrizes}`);
  if (result.rejected > 0) {
    console.log(c.yellow(`  rejected (old format): ${result.rejected}`));
  }
  const press = result.dataset.draws.filter((d) => d.provenance === "press").length;
  if (press > 0) {
    console.log(c.yellow(`  provisional (press):   ${press} — replaced when a version with a prize table arrives`));
  }

  const official = result.official;
  if (official) {
    if (official.error) {
      console.log(c.yellow(`  baloto.com:          not read — ${official.error}`));
    } else {
      const span =
        official.indices.length > 0
          ? `draw(s) ${official.indices[0]}–${official.indices[official.indices.length - 1]}`
          : "nothing new";
      console.log(
        c.green(
          `  baloto.com:          ${span} (${official.fetched} rows), last known draw ${official.lastIndex ?? "?"}` +
            (official.confirmed > 0 ? `, ${official.confirmed} press row(s) confirmed` : ""),
        ),
      );
      for (const w of official.warnings) console.log(c.yellow(`    ${w}`));
    }
  }

  if (result.conflicts.length > 0) {
    console.log("");
    console.log(c.yellow(c.bold(`Sources disagree on ${result.conflicts.length} draw(s) — recorded, not overwritten:`)));
    for (const k of result.conflicts) {
      console.log(
        c.yellow(
          `  ${k.date} ${k.game}: kept ${k.kept.join(" ")} (${k.keptProvenance}), ` +
            `rejected ${k.rejected.join(" ")} (${k.rejectedProvenance}) — ${k.reason}`,
        ),
      );
    }
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
  tiebreak?: string;
  warmup?: string;
  typical?: boolean;
  coverage?: string;
  seed?: string;
  record?: boolean;
  revancha?: boolean;
}): Promise<void> {
  const game = parseGame(opts.game);
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, game);
  const tickets = opts.tickets ? Number.parseInt(opts.tickets, 10) : 3;
  const priorStrength = opts.prior ? Number(opts.prior) : 1;
  const revancha = opts.revancha === true;

  const {
    bonferroniZ,
    nightCoverage,
    nightCoverageForBudget,
    planSuperCoverage,
    scoreSuperRules,
    standardSuperRules,
    superPosterior,
    winAnythingBudget,
    winAnythingProbability,
  } = await import("../baloto/superball.ts");
  const { model } = await loadBiasModel(game);

  console.log(c.bold(`Súper Balota — ${draws.length.toLocaleString("es-CO")} draws of ${game}`));
  console.log("");

  // 1. Does anything predict the ball at all?
  const warmup = opts.warmup ? Number.parseInt(opts.warmup, 10) : 400;
  const { algorithmSuperRules } = await import("../baloto/algorithms.ts");
  const { hmmSuperRule } = await import("../baloto/regime.ts");
  const { SuperChoiceCache, metaSuperRules } = await import("../baloto/meta.ts");
  // The meta-rules (follow the leader, Bayesian average, contrarian, recency
  // ensemble) read the base rules' nested walk-forward record; the shared cache
  // makes each base choice once for both the base entries and the meta entries.
  const baseRules = [...standardSuperRules(priorStrength, model.super), ...algorithmSuperRules(), hmmSuperRule()];
  const cache = new SuperChoiceCache(baseRules);
  const rules = [...cache.cached(), ...metaSuperRules(baseRules, { cache })];
  const scores = scoreSuperRules(draws, rules, tickets, warmup);
  const base = tickets / SUPER_POOL;
  console.log(
    c.dim(
      `  Walk-forward over ${scores[0]?.draws.toLocaleString("es-CO") ?? 0} draws. Any ${tickets} distinct balls hit at exactly ` +
        `${pct(base)};\n  a rule only means something if it clears that by more than the field allows: ` +
        `|z| > ${bonferroniZ(rules.length).toFixed(2)} (Bonferroni over ${rules.length} rules).`,
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
  if (opts.tiebreak !== undefined && opts.tiebreak !== "posterior" && opts.tiebreak !== "crowd") {
    throw new Error('--tiebreak must be "posterior" or "crowd".');
  }
  const plan = planSuperCoverage(draws, tickets, {
    priorStrength,
    tiebreak: opts.tiebreak === "crowd" ? "least-played" : "posterior",
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
  if (revancha) {
    const night = nightCoverage(tickets, true);
    console.log(
      c.bold(
        `  With Revancha the same tickets play the night's second draw: ${pct(night.superHit)} ` +
          `that some ticket hits its Súper Balota at least once (${money(night.cost)} for the night)`,
      ),
    );
  }
  const order =
    plan.rule === "posterior"
      ? plan.distinguishable.length > 0
        ? "ranked by posterior mean — a ball here is genuinely likelier"
        : `ranked by posterior mean, the Bayes action for a pure hit objective. The gap between\n` +
          `  them (${plan.spreadPoints.toFixed(2)} points) is inside noise: it is a tiebreak, not evidence`
      : plan.rule === "least-played"
        ? `ranked by how few people play them (${plan.crowding.toFixed(2)}× the average crowd), ` +
          "which costs nothing:\n  the hit probability above is exact whichever sixteenths you cover"
        : "in no particular order — nothing separates them";
  console.log(c.dim(`  Balls ${plan.balls.join(", ")}, ${order}.`));
  console.log("");

  // Disjoint main numbers are the exact optimum for "win anything" with N
  // tickets: two tickets can only both reach three matches if they share
  // numbers, so sharing none makes the events exclusive and their
  // probabilities add. Worth 20.58 % against 20.49 % at overlap 2 — small,
  // free, and a hit criterion rather than a payout one.
  const { pickReport } = await import("../baloto/pick.ts");
  const report = pickReport(model, {
    count: tickets,
    pool: 2000,
    maxOverlap: 0,
    typical: opts.typical === true,
    typicalCoverage: opts.coverage ? Number(opts.coverage) : 0.8,
    seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
  });
  // The crowd column is a payout figure; it only appears when the caller
  // chose the crowd tiebreak, so the default report stays about hitting.
  const showCrowd = plan.rule === "least-played";
  const rows = report.tickets.map((t, i) => {
    const ball = plan.balls[i] ?? t.ticket.super;
    const row = [
      t.ticket.main.map((n) => String(n).padStart(2, "0")).join(" "),
      String(ball).padStart(2, "0"),
    ];
    if (showCrowd) row.push(`${(model.super[ball - 1]! * SUPER_POOL).toFixed(2)}×`);
    return row;
  });
  console.log(
    table(showCrowd ? ["MAIN NUMBERS", "SÚPER", "CROWD ON THAT SÚPER"] : ["MAIN NUMBERS", "SÚPER"], rows),
  );
  console.log("");
  // P(win anything) for exactly these tickets, by exact enumeration of the
  // 962 598 main draws (coverage.ts). Disjoint tickets sit on the union bound
  // and are the proven optimum; beyond eight tickets no arrangement can be
  // disjoint, and the best minimal-overlap design found says how far the
  // recommendation is from it.
  const { optimiseCoverage, overlapProfile, winAnythingExact } = await import("../baloto/coverage.ts");
  const handed = report.tickets.map((t, i) => ({ main: t.ticket.main, super: plan.balls[i] ?? t.ticket.super }));
  const exactWin = winAnythingExact(handed);
  const overlap = overlapProfile(handed.map((t) => t.main));
  const seed = opts.seed ? Number.parseInt(opts.seed, 10) : 1;
  const bestPlan = overlap.maxOverlap === 0 ? null : optimiseCoverage(tickets, seed);
  console.log(
    c.dim(
      "  The five main numbers are free: the objective above does not constrain them,\n" +
        "  so they are taken from the least-played combinations" +
        (overlap.maxOverlap === 0
          ? `, sharing no number across\n  tickets — the exact optimum for winning anything with ${tickets} tickets: ${pct(exactWin)}.`
          : `, sharing at most ${overlap.maxOverlap} number(s)\n  between any two tickets — P(win anything) for exactly these tickets: ${pct(exactWin)}` +
            (bestPlan && bestPlan.winAnythingProbability > exactWin + 1e-12
              ? ` (the best\n  arrangement found for ${tickets} tickets reaches ${pct(bestPlan.winAnythingProbability)}).`
              : ".")) +
        "\n  A Súper Balota hit pays something at any number of main matches, so every hit is a winning ticket.",
    ),
  );
  console.log("");
  // The budget curve: the levers that move the objective are N and the number
  // of draws each ticket plays, so show exactly what each buys — in hit
  // probability, nothing else. Revancha is a second complete draw the same
  // night with the same numbers; independent of the first (regime: p = 0.25),
  // so it is coverage of the same kind as distinct balls: 1 − (1 − N/16)².
  console.log(c.bold("  What each ticket buys (exact, fair machine, distinct Súper Balotas, minimal overlap)"));
  console.log(
    table(
      ["TICKETS", "COST", "P(SÚPER BALOTA)", "P(WIN ANYTHING)", "+REVANCHA", "P(SÚPER BALOTA)", "P(WIN ANYTHING)"],
      [1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => {
        const plain = nightCoverage(n, false);
        const doubled = nightCoverage(n, true);
        // Up to eight tickets the figure is the exact optimum (disjoint numbers);
        // beyond, it is exact for the best minimal-overlap arrangement known,
        // strictly below the union bound (see coverage.ts for the search).
        const note = winAnythingBudget(n).exact ? "" : " (best found)";
        return [
          String(n),
          money(plain.cost),
          pct(plain.superHit),
          pct(plain.winAnything) + note,
          money(doubled.cost),
          pct(doubled.superHit),
          pct(doubled.winAnything),
        ];
      }),
    ),
  );
  console.log("");
  console.log(c.bold("  The same pesos, two ways: more tickets, or the same tickets in both draws"));
  console.log(
    table(
      ["BUDGET", "WITHOUT REVANCHA", "P(SÚPER BALOTA)", "P(WIN ANYTHING)", "WITH REVANCHA", "P(SÚPER BALOTA)", "P(WIN ANYTHING)"],
      [18_000, 36_000, 54_000, 72_000].map((budget) => {
        const { without, withRevancha } = nightCoverageForBudget(budget);
        const better = withRevancha.superHit > without.superHit;
        // Past eight tickets the main numbers can no longer be disjoint
        // (43/5), so "win anything" is a bound there, as in the table above.
        return [
          money(budget),
          `${without.tickets} tickets`,
          pct(without.superHit),
          pct(without.winAnything) + (without.tickets > 8 ? " (best found)" : ""),
          `${withRevancha.tickets} tickets`,
          better ? c.green(pct(withRevancha.superHit)) : pct(withRevancha.superHit),
          pct(withRevancha.winAnything),
        ];
      }),
    ),
  );
  console.log("");
  console.log(
    c.dim(
      "  Revancha is a second, complete draw (5 of 43 + 1 of 16) minutes later, with the same numbers,\n" +
        "  independent of the first. Per peso it buys more Súper Balota coverage than extra tickets do\n" +
        "  up to seven tickets, ties at eight (75 % either way) and loses beyond, where sixteen distinct\n" +
        "  balls are a certainty and a second draw never is. Pass --revancha to plan and record it.",
    ),
  );
  console.log("");
  console.log(
    c.yellow(
      `  ${pct(plan.hitProbability)} is the probability of hitting the Súper Balota, not of winning the jackpot.\n` +
        "  The jackpot still needs all five main numbers as well, at 1 in 962 598.",
    ),
  );

  if (opts.record === true) {
    const { loadLedger, saveLedger, recordRecommendation, nextDrawDate } = await import("../baloto/ledger.ts");
    const latest = draws[draws.length - 1]?.date;
    if (!latest) return;
    const target = nextDrawDate(latest);
    const night = nightCoverage(report.tickets.length, revancha);
    const ledger = recordRecommendation(await loadLedger(), {
      recordedAt: new Date().toISOString(),
      targetDate: target,
      game,
      model: `super/${plan.rule}`,
      tickets: report.tickets.map((t, i) => ({ main: t.ticket.main, super: plan.balls[i] ?? t.ticket.super })),
      note: `seed ${opts.seed ?? "none"}, typical ${opts.typical === true}`,
      revancha,
      cost: night.cost,
    });
    await saveLedger(ledger);
    console.log("");
    console.log(
      c.green(
        `  Recorded for the ${target} draw${revancha ? " (Baloto and Revancha)" : ""}: ${money(night.cost)} staked ` +
          `against a ${pct(night.superHit)} night. Score it afterwards with: bancolombia baloto score`,
      ),
    );
  }
}

/**
 * `baloto score` — the live half of the scoring discipline: every recorded
 * recommendation against the draw that followed, hit rate against its exact
 * expectation, and a p-value so that luck in either direction is named.
 */
export async function scoreCommand(opts: { game?: string }): Promise<void> {
  const game = parseGame(opts.game);
  const dataset = await requireDataset();
  // Both games: a night that played Revancha is scored against both draws.
  const draws = [...drawsFor(dataset, "baloto"), ...drawsFor(dataset, "revancha")];
  const { detectableDeparture, loadLedger, nightsToDistinguish, scoreLedger } = await import("../baloto/ledger.ts");
  const ledger = await loadLedger();
  const score = scoreLedger({ entries: ledger.entries.filter((e) => e.game === game) }, draws);

  console.log(c.bold(`Recommendation ledger — ${game}`));
  if (score.scored.length === 0 && score.pending.length === 0) {
    console.log(c.dim("  Nothing recorded yet. Run `baloto super --record` before a draw."));
    return;
  }
  console.log("");
  const result = (d: { main: number[]; super: number }) =>
    `${d.main.map((n) => String(n).padStart(2, "0")).join(" ")} + ${String(d.super).padStart(2, "0")}`;
  const anyRevancha = score.scored.some((s) => s.companion !== null);
  const nights = score.scored.length;
  console.log(
    table(
      ["DRAW", "RESULT", "TICKETS (matches)", "SÚPER", "BEST TIER", ...(anyRevancha ? ["REVANCHA", "SÚPER", "TIER"] : [])],
      score.scored.map((s) => {
        const row = [
          s.draw.date,
          result(s.draw),
          s.entry.tickets
            .map((t, i) => `${t.main.map((n) => String(n).padStart(2, "0")).join(" ")}+${String(t.super).padStart(2, "0")} (${s.matches[i]})`)
            .join("  "),
          s.superHitTicket >= 0 ? c.green(`hit #${s.superHitTicket + 1}`) : c.dim("—"),
          s.bestTier ?? c.dim("—"),
        ];
        if (anyRevancha) {
          row.push(
            s.companion ? result(s.companion.draw) : c.dim("not played"),
            s.companion && s.companion.superHitTicket >= 0 ? c.green(`hit #${s.companion.superHitTicket + 1}`) : c.dim("—"),
            s.companion?.bestTier ?? c.dim("—"),
          );
        }
        return row;
      }),
    ),
  );
  console.log("");
  console.log(
    `  Súper Balota hits: ${score.superHits} of ${nights} nights; expected ${score.superExpected.toFixed(2)}` +
      (score.superPValue !== null ? `; two-sided exact p = ${score.superPValue.toFixed(3)}` : ""),
  );
  console.log(`  Won anything: ${score.wins} of ${nights} nights.`);
  // The stake side of the record: pesos per hit, against what the model
  // implies. Not what a hit pays — how much it costs to be there when it comes.
  console.log(
    `  Staked: ${money(score.staked)} on ${score.tickets} tickets over ${nights} nights` +
      (score.stakePerHit.observed !== null
        ? `; ${money(score.stakePerHit.observed)} per Súper Balota hit against ${money(score.stakePerHit.expected)} implied by the model.`
        : `; no hit yet, the model implies one per ${money(score.stakePerHit.expected)}.`),
  );
  if (nights > 0) {
    const { current, longest, pCurrent } = score.streak;
    console.log(
      current > 0
        ? `  Drought: ${current} night(s) without a hit (longest ${longest}); a run this long or longer happens ${pct(pCurrent)} of the time under the model.`
        : `  The latest night hit. Longest drought so far: ${longest} night(s).`,
    );
  }
  if (score.pending.length > 0) {
    console.log(c.dim(`  Pending: ${score.pending.map((p) => p.targetDate).join(", ")} (a draw it played is not in the dataset yet).`));
  }
  console.log("");
  // What the ledger can and cannot see. Reading a streak into a sample this
  // size is the mistake this line exists to prevent.
  if (score.nightRate !== null && nights > 0) {
    const p0 = score.nightRate;
    const oneTicket = Math.min(1, p0 + 1 / SUPER_POOL);
    const smallest = detectableDeparture(nights, p0);
    console.log(
      c.dim(
        `  Sample size: with ${nights} night(s) this ledger can only detect a model that hits ${pct(p0 + smallest)} or more\n` +
          `  instead of ${pct(p0)} (80 % power, two-sided 5 %). Telling ${pct(p0)} from ${pct(oneTicket)} — a rule worth one\n` +
          `  more ticket of coverage — needs ${nightsToDistinguish(p0, oneTicket).toLocaleString("es-CO")} nights; ` +
          `from ${pct(p0 + 0.0225)}, ${nightsToDistinguish(p0, Math.min(1, p0 + 0.0225)).toLocaleString("es-CO")} nights.`,
      ),
    );
  }
  console.log(
    c.dim(
      "  A p-value near 1 is the model doing exactly what it promised; a small one in either\n" +
        "  direction is luck until the tournament says otherwise — the ledger never refits anything.",
    ),
  );
}

/**
 * `baloto regime` — two OPEN items from the research registry, run properly:
 * a two-state hidden Markov model against i.i.d. by BIC, and the dependence
 * between the Baloto and Revancha Súper Balotas drawn the same night.
 */
export async function regimeCommand(opts: { states?: string; sims?: string }): Promise<void> {
  const dataset = await requireDataset();
  const baloto = drawsFor(dataset, "baloto");
  const revancha = drawsFor(dataset, "revancha");
  const states = opts.states ? Number.parseInt(opts.states, 10) : 2;
  const sims = opts.sims ? Number.parseInt(opts.sims, 10) : 2000;
  const { regimeEvidence, crossGameDependence } = await import("../baloto/regime.ts");

  console.log(c.bold(`Regimes — ${baloto.length.toLocaleString("es-CO")} Súper Balotas`));
  const ev = regimeEvidence(baloto, states);
  console.log(
    table(
      ["MODEL", "LOG-LIK", "PARAMS", "BIC"],
      [
        ["i.i.d. (fair-or-loaded, no memory)", ev.iid.logLikelihood.toFixed(1), String(ev.iid.parameters), ev.iid.bic.toFixed(1)],
        [`hidden Markov, ${states} states`, ev.hmm.logLikelihood.toFixed(1), String(ev.hmm.parameters), ev.hmm.bic.toFixed(1)],
      ],
    ),
  );
  console.log("");
  console.log(
    ev.favoursRegimes
      ? c.yellow(`  BIC favours regimes by ${ev.deltaBic.toFixed(1)} nats; state separation ${ev.stateSeparation.toFixed(2)}, occupancy ${ev.occupancy.map((o) => pct(o)).join(" / ")}.`)
      : c.dim(
          `  BIC favours i.i.d. by ${(-ev.deltaBic).toFixed(1)} nats: the extra states do not earn their parameters.\n` +
            `  (Fitted separation ${ev.stateSeparation.toFixed(2)}, occupancy ${ev.occupancy.map((o) => pct(o)).join(" / ")} — what EM finds when there is nothing to find.)`,
        ),
  );
  console.log("");

  const dep = crossGameDependence(baloto, revancha, sims);
  console.log(c.bold(`  Baloto × Revancha Súper Balota, same night (${dep.pairs.toLocaleString("es-CO")} pairs)`));
  console.log(
    c.dim(
      `  16×16 χ² = ${dep.chiSquare.toFixed(1)}, permutation p = ${dep.pValue.toFixed(3)}; ` +
        `same ball ${dep.sameSuper} times vs ${dep.sameSuperExpected.toFixed(1)} expected (p = ${dep.sameSuperPValue.toFixed(3)}).`,
    ),
  );
  console.log(
    dep.pValue < 0.01
      ? c.yellow("  The two machines are not independent — investigate before trusting either as fair.")
      : c.dim("  Independent, as two separate machines should be."),
  );
}


/**
 * `baloto algorithms` — the "but have you tried machine learning?" command.
 *
 * Every algorithm that sounds like statistics is run walk-forward beside the
 * folk systems and scored on matches per ticket against 5·5/43. Then the
 * periodicity question gets its own exact test.
 */
export async function algorithmsCommand(opts: {
  game?: string;
  warmup?: string;
  repeats?: string;
}): Promise<void> {
  const game = parseGame(opts.game);
  const dataset = await requireDataset();
  const draws = drawsFor(dataset, game);
  const warmup = opts.warmup ? Number.parseInt(opts.warmup, 10) : 300;
  const repeats = opts.repeats ? Number.parseInt(opts.repeats, 10) : 3;

  const { algorithmStrategies, algorithmSuperRules, periodograms, fitLogistic, describeLogistic, CHANCE_MATCHES } =
    await import("../baloto/algorithms.ts");
  const { scoreSuperRules, standardSuperRules } = await import("../baloto/superball.ts");

  console.log(c.bold(`Prediction algorithms — ${draws.length.toLocaleString("es-CO")} draws of ${game}`));
  console.log(
    c.dim(
      `  Walk-forward from draw ${warmup}: each algorithm sees only the draws before the one it bets on.\n` +
        `  A blind guess matches ${CHANCE_MATCHES.toFixed(4)} numbers per ticket; anything inside ±2 z is that.`,
    ),
  );
  console.log("");

  const strategies = [...defaultStrategies().filter((s) => s.id === "random"), ...algorithmStrategies()];
  const report = backtest(draws, strategies, warmup, repeats);
  console.log(
    table(
      ["ALGORITHM", "MATCHES/TICKET", "Z", "PRIZES", "WHAT IT DOES"],
      [...report.results]
        .sort((a, b) => b.meanMatches - a.meanMatches)
        .map((r) => [
          r.id,
          r.meanMatches.toFixed(4),
          `${r.z >= 0 ? "+" : ""}${r.z.toFixed(2)}`,
          String(r.prizesWon),
          r.description,
        ]),
    ),
  );
  console.log("");

  const model = fitLogistic(draws);
  console.log(
    c.dim(
      "  Logistic coefficients (log-odds per unit ± standard error): " +
        describeLogistic(model)
          .map((x) => `${x.feature} ${x.weight >= 0 ? "+" : ""}${x.weight.toFixed(3)}±${x.standardError.toFixed(3)}`)
          .join("  "),
    ),
  );
  console.log("");

  const spectra = periodograms(draws);
  const significant = spectra.filter((p) => p.significant);
  const sharpest = [...spectra].sort((a, b) => a.pValue - b.pValue)[0];
  console.log(c.bold("  Periodicity (Fisher's g on each ball's on/off series)"));
  if (significant.length === 0) {
    console.log(
      c.dim(
        `  No ball has a significant cycle once the threshold is spread over ${spectra.length} balls` +
          (sharpest
            ? ` — the sharpest is ball ${sharpest.ball} at a ${sharpest.period.toFixed(1)}-draw period, p = ${sharpest.pValue.toFixed(3)}.`
            : "."),
      ),
    );
  } else {
    console.log(
      c.yellow(
        `  Significant cycles: ${significant.map((p) => `ball ${p.ball} (period ${p.period.toFixed(1)})`).join(", ")}`,
      ),
    );
  }
  console.log("");

  const superScores = scoreSuperRules(draws, [...standardSuperRules(1), ...algorithmSuperRules()], 3, 400);
  const added = superScores.slice(-2);
  console.log(c.bold("  The same ideas on the Súper Balota (3 distinct balls, 18.75 % expected)"));
  for (const s of added) {
    console.log(
      c.dim(`  ${s.name}: ${s.hits}/${s.draws} = ${pct(s.rate)}, z = ${s.z >= 0 ? "+" : ""}${s.z.toFixed(2)}`) +
        (s.beatsChance ? c.green("  real") : c.dim("  noise")),
    );
  }
  console.log("");
  console.log(
    c.yellow(
      "  Every one of these is a legitimate algorithm and every one is scored honestly.\n" +
        "  If a row ever clears ±2 z on fresh data, that is news; until then they are ways of guessing.",
    ),
  );
}
