/**
 * The seed for tickets that look like an ordinary draw.
 *
 * The owner finds tickets with an odd spread senseless (2026-11-16). The
 * amplitude of a draw (max − min) has its middle half between 24 and 35, and
 * tickets of every amplitude are exactly as likely as each other, so asking
 * for a typical one costs nothing (see README.md in this folder). The main
 * numbers stay chosen by structure only — disjoint tickets from
 * `optimiseCoverage` — and the amplitude only decides which seed is used:
 * the first one, counting up from the date seed (MMDD), whose tickets all
 * fall in the range.
 *
 *   bun experiments/amplitude/seed.ts <start seed> [tickets = 2] [low = 24] [high = 35]
 */
import { optimiseCoverage } from "../../src/baloto/coverage.ts";

const [startArg, ticketsArg, lowArg, highArg] = process.argv.slice(2);
const start = Number.parseInt(startArg ?? "", 10);
if (!Number.isInteger(start)) {
  console.error("usage: bun experiments/amplitude/seed.ts <start seed> [tickets = 2] [low = 24] [high = 35]");
  process.exit(1);
}
const tickets = Number.parseInt(ticketsArg ?? "2", 10);
const low = Number.parseInt(lowArg ?? "24", 10);
const high = Number.parseInt(highArg ?? "35", 10);
const amplitude = (main: number[]): number => Math.max(...main) - Math.min(...main);

for (let seed = start; seed < start + 500; seed++) {
  const mains = optimiseCoverage(tickets, seed).tickets.map((t) => t.main);
  const spreads = mains.map(amplitude);
  const typical = spreads.every((a) => a >= low && a <= high);
  console.log(
    `${seed}  ${mains.map((m) => m.map((n) => String(n).padStart(2, "0")).join(" ")).join(" | ")}  ` +
      `amplitudes ${spreads.join(", ")}${typical ? `  <- all within ${low}–${high}` : ""}`,
  );
  if (typical) process.exit(0);
}
console.error(`no seed in ${start}…${start + 499} gives ${tickets} tickets all within ${low}–${high}`);
process.exit(1);
