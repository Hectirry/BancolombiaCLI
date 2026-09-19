/**
 * Local Baloto dataset: the historical draws plus, where the operator has
 * published them, the per-category winner counts and prize amounts.
 *
 * Winner counts are what make a *quantitative* answer possible: they reveal how
 * many players held each kind of ticket, which is the only public window into
 * how Colombians actually choose their numbers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { FORMAT_START_DATE, MAIN_PICK, MAIN_POOL, SUPER_POOL } from "./rules.ts";

/** Baloto and Revancha are drawn from separate machines on the same night. */
export type Game = "baloto" | "revancha";

export interface TierResult {
  /** Tier id, see `PRIZE_TIERS`. */
  tier: string;
  /** Number of tickets that won this category. */
  winners: number;
  /** Prize paid to each winner, in COP. For the jackpot this is the roll-over. */
  prizePerWinner: number;
  /** Total paid out in this category, used as a checksum against the other two. */
  totalPaid: number;
}

/**
 * A published breakdown is trustworthy only if every row multiplies out:
 * prize per winner × winners = total paid. The archive occasionally renders a
 * draw with its columns shifted, which turns a single winner of $37 521 175
 * into 37 million winners and would swamp any model fitted to the counts.
 */
export function breakdownIsConsistent(tiers: TierResult[] | undefined): boolean {
  if (!tiers || tiers.length === 0) return false;
  return tiers.every((t) => {
    if (t.winners < 0 || t.prizePerWinner < 0 || t.totalPaid < 0) return false;
    // Nobody wins nothing: a category with winners always pays each of them.
    if (t.winners > 0 && t.prizePerWinner <= 0) return false;
    const implied = t.prizePerWinner * t.winners;
    // Prizes are rounded per winner, so allow a peso of slack each.
    return Math.abs(implied - t.totalPaid) <= Math.max(1, t.winners, 0.001 * t.totalPaid);
  });
}

export interface Draw {
  /** Draw date, YYYY-MM-DD. */
  date: string;
  game: Game;
  /** Five distinct numbers 1..43, ascending. */
  main: number[];
  /** Súper Balota, 1..16. */
  super: number;
  /** Prize breakdown, when published for that draw. */
  tiers?: TierResult[];
}

export interface Dataset {
  /** ISO timestamp of the last successful update. */
  updatedAt: string;
  /** Where the data came from, for provenance. */
  sources: string[];
  draws: Draw[];
}

/** Path of the on-disk dataset, inside the CLI's home directory. */
export function datasetPath(): string {
  return config.balotoDatasetPath;
}

export async function saveDataset(dataset: Dataset): Promise<void> {
  const path = datasetPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(dataset), "utf8");
}

export async function loadDataset(): Promise<Dataset | null> {
  try {
    return JSON.parse(await readFile(datasetPath(), "utf8")) as Dataset;
  } catch {
    return null;
  }
}

/**
 * Load the dataset or fail with an actionable message — every analysis command
 * needs data before it can say anything.
 */
export async function requireDataset(): Promise<Dataset> {
  const dataset = await loadDataset();
  if (!dataset || dataset.draws.length === 0) {
    throw new Error(
      "No local Baloto history yet. Run `bancolombia baloto update` first.",
    );
  }
  return dataset;
}

/** True when a draw is well-formed for the current 5/43 + 1/16 format. */
export function isValidDraw(draw: Draw): boolean {
  if (draw.date < FORMAT_START_DATE) return false;
  if (draw.main.length !== MAIN_PICK) return false;
  if (new Set(draw.main).size !== MAIN_PICK) return false;
  for (const n of draw.main) {
    if (!Number.isInteger(n) || n < 1 || n > MAIN_POOL) return false;
  }
  // Ascending storage is an invariant the statistics rely on.
  for (let i = 1; i < draw.main.length; i++) {
    if (draw.main[i]! <= draw.main[i - 1]!) return false;
  }
  return Number.isInteger(draw.super) && draw.super >= 1 && draw.super <= SUPER_POOL;
}

/** A draw dropped by `cleanDraws`, kept so the CLI can disclose the edit. */
export interface Anomaly {
  date: string;
  game: Game;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
}

/**
 * Drop archive artefacts before anything is measured.
 *
 * Baloto is drawn on Monday, Wednesday and Saturday, so two draws are never
 * one day apart. The archive nevertheless repeats the 2022-11-09 result under
 * 2022-11-10 for both games. Left in, a duplicate invents an "exact repeat"
 * that makes replaying the previous draw look like a jackpot strategy.
 */
export function cleanDraws(draws: Draw[]): { draws: Draw[]; anomalies: Anomaly[] } {
  const kept: Draw[] = [];
  const anomalies: Anomaly[] = [];
  for (const draw of draws) {
    const previous = kept[kept.length - 1];
    const isEcho =
      previous !== undefined &&
      daysBetween(previous.date, draw.date) <= 1 &&
      previous.main.join() === draw.main.join() &&
      previous.super === draw.super;
    if (isEcho) {
      anomalies.push({
        date: draw.date,
        game: draw.game,
        reason: `duplicate of ${previous!.date} (no draw is held one day after another)`,
      });
      continue;
    }
    kept.push(draw);
  }
  return { draws: kept, anomalies };
}

/** Draws for one game, oldest first, with archive artefacts removed. */
export function drawsFor(dataset: Dataset, game: Game): Draw[] {
  const ordered = dataset.draws
    .filter((d) => d.game === game && isValidDraw(d))
    .sort((a, b) => a.date.localeCompare(b.date));
  return cleanDraws(ordered).draws;
}

/** Everything `drawsFor` silently discards, for disclosure in reports. */
export function datasetAnomalies(dataset: Dataset): Anomaly[] {
  return (["baloto", "revancha"] as Game[]).flatMap((game) => {
    const ordered = dataset.draws
      .filter((d) => d.game === game && isValidDraw(d))
      .sort((a, b) => a.date.localeCompare(b.date));
    return cleanDraws(ordered).anomalies;
  });
}

/** Merge freshly scraped draws into an existing dataset, newest data winning. */
export function mergeDraws(existing: Draw[], incoming: Draw[]): Draw[] {
  const byKey = new Map<string, Draw>();
  for (const draw of existing) byKey.set(`${draw.date}:${draw.game}`, draw);
  for (const draw of incoming) {
    const key = `${draw.date}:${draw.game}`;
    const prev = byKey.get(key);
    // Never drop a prize breakdown we already have because of a thinner refetch.
    byKey.set(key, prev?.tiers && !draw.tiers ? { ...draw, tiers: prev.tiers } : draw);
  }
  return [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.game.localeCompare(b.game),
  );
}
