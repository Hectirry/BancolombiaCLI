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

export async function pickCommand(opts: {
  game?: string;
  count?: string;
  contrarianism?: string;
  seed?: string;
  jackpot?: string;
}): Promise<void> {
  const game = parseGame(opts.game);
  const { model, fitted } = await loadBiasModel(game);
  const summary = summariseBias(model);

  const count = opts.count ? Number.parseInt(opts.count, 10) : 5;
  const tickets = pickTickets(model, {
    count,
    contrarianism: opts.contrarianism ? Number(opts.contrarianism) : 1.5,
    seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
  });

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
      pct(ev.returnToPlayer),
    ];
  });
  console.log(table(["NUMBERS", "POPULARITY", "RETURN"], rows));
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
  console.log(`  ${c.cyan("baloto bias")}      Measure how players choose their numbers`);
  console.log(`  ${c.cyan("baloto ev")}        Price a ticket, with pari-mutuel splitting and tax`);
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
