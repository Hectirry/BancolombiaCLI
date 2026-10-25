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

/**
 * Where a draw's numbers were read from, in decreasing order of authority.
 *
 * - `official`: the operator's own page (baloto.com), with its prize table.
 * - `archive`: one of the public result archives we scrape. Rows written
 *   before this field existed carry no value and are read as `archive`.
 * - `press`: typed in from newspaper or radio reports because no archive had
 *   the draw yet. Provisional by definition: it is replaced as soon as a
 *   version with a prize breakdown arrives.
 */
export type Provenance = "official" | "archive" | "press";

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
  /** Origin of the numbers; absent means `archive`. */
  provenance?: Provenance;
}

/**
 * Two sources disagreed about the same draw. Recorded, never resolved
 * silently: the dataset keeps the better-evidenced version and this entry
 * says which one lost and why, so every report can disclose it.
 */
export interface DrawConflict {
  date: string;
  game: Game;
  /** The version kept in the dataset: five main numbers then the Súper Balota. */
  kept: number[];
  keptProvenance: Provenance;
  /** The version discarded. */
  rejected: number[];
  rejectedProvenance: Provenance;
  reason: string;
  /** ISO timestamp of the update that noticed the disagreement. */
  detectedAt: string;
}

export interface Dataset {
  /** ISO timestamp of the last successful update. */
  updatedAt: string;
  /** Where the data came from, for provenance. */
  sources: string[];
  draws: Draw[];
  /**
   * Last draw number confirmed on baloto.com (`/resultados-baloto/<n>`), so
   * the next update can walk forward from it instead of guessing.
   */
  officialIndex?: number;
  /** Disagreements between sources noticed by past updates. */
  conflicts?: DrawConflict[];
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

/**
 * True when the draw date falls on a night Baloto is actually drawn: Monday,
 * Wednesday or Saturday. A result dated any other day is a transcription or
 * parsing error, whatever source it came from.
 */
export function isDrawDay(date: string): boolean {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 1 || weekday === 3 || weekday === 6;
}

/** A draw dropped by `cleanDraws`, kept so the CLI can disclose the edit. */
export interface Anomaly {
  date: string;
  game: Game;
  reason: string;
  /** `duplicate` is an archive echo; `conflict` is a source disagreement. */
  kind?: "duplicate" | "conflict";
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

/**
 * Everything `drawsFor` silently discards, plus every recorded disagreement
 * between sources, for disclosure in reports.
 */
export function datasetAnomalies(dataset: Dataset): Anomaly[] {
  const echoes = (["baloto", "revancha"] as Game[]).flatMap((game) => {
    const ordered = dataset.draws
      .filter((d) => d.game === game && isValidDraw(d))
      .sort((a, b) => a.date.localeCompare(b.date));
    return cleanDraws(ordered).anomalies.map((a) => ({ ...a, kind: "duplicate" as const }));
  });
  const conflicts = (dataset.conflicts ?? []).map((c) => ({
    date: c.date,
    game: c.game,
    kind: "conflict" as const,
    reason:
      `sources disagree: kept ${c.kept.join(" ")} (${c.keptProvenance}), ` +
      `rejected ${c.rejected.join(" ")} (${c.rejectedProvenance}) — ${c.reason}`,
  }));
  return [...echoes, ...conflicts].sort((a, b) => a.date.localeCompare(b.date));
}

export function provenanceOf(draw: Draw): Provenance {
  return draw.provenance ?? "archive";
}

const PROVENANCE_RANK: Record<Provenance, number> = { press: 0, archive: 1, official: 2 };

function hasBreakdown(draw: Draw): boolean {
  return breakdownIsConsistent(draw.tiers);
}

function sameNumbers(a: Draw, b: Draw): boolean {
  return a.super === b.super && a.main.join() === b.main.join();
}

function numbersOf(draw: Draw): number[] {
  return [...draw.main, draw.super];
}

/**
 * Evidence ranking used when two sources disagree about one draw. A version
 * backed by the operator's own prize table outranks everything; any
 * consistent prize breakdown outranks bare numbers (a breakdown is published
 * once, against the real result, and it has to multiply out); then the
 * provenance order official > archive > press.
 */
function evidence(draw: Draw): number {
  const provenance = provenanceOf(draw);
  const breakdown = hasBreakdown(draw);
  return (
    (provenance === "official" && breakdown ? 100 : 0) +
    (breakdown ? 10 : 0) +
    PROVENANCE_RANK[provenance]
  );
}

export interface Reconciliation {
  draws: Draw[];
  /** Disagreements found in this merge, one per date and game. */
  conflicts: DrawConflict[];
  /** Press-sourced rows upgraded to a version with a prize breakdown. */
  confirmed: number;
}

/**
 * Merge freshly fetched draws into an existing dataset without ever
 * overwriting numbers silently.
 *
 * Same numbers: the two versions are combined — the best provenance is kept,
 * a prize breakdown is never lost, and an official breakdown replaces an
 * archive one. A `press` row whose numbers are confirmed by a version with a
 * breakdown is upgraded in place (`confirmed`).
 *
 * Different numbers: the version with more evidence (`evidence`) wins and the
 * disagreement is recorded. On equal evidence the existing row stays, because
 * a refetch that contradicts what we already checked is a reason to look, not
 * a reason to change the dataset.
 */
export function reconcileDraws(
  existing: Draw[],
  incoming: Draw[],
  detectedAt = new Date().toISOString(),
): Reconciliation {
  const byKey = new Map<string, Draw>();
  for (const draw of existing) byKey.set(`${draw.date}:${draw.game}`, draw);
  const conflicts: DrawConflict[] = [];
  let confirmed = 0;

  for (const draw of incoming) {
    const key = `${draw.date}:${draw.game}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, draw);
      continue;
    }

    if (sameNumbers(prev, draw)) {
      const prevRank = PROVENANCE_RANK[provenanceOf(prev)];
      const nextRank = PROVENANCE_RANK[provenanceOf(draw)];
      const best = nextRank > prevRank ? provenanceOf(draw) : provenanceOf(prev);
      // Never drop a prize breakdown we already have because of a thinner
      // refetch; let an official one replace an archive one.
      const incomingOfficial = provenanceOf(draw) === "official" && hasBreakdown(draw);
      const tiers = incomingOfficial
        ? draw.tiers
        : prev.tiers && prev.tiers.length > 0
          ? prev.tiers
          : draw.tiers;
      if (provenanceOf(prev) === "press" && !hasBreakdown(prev) && hasBreakdown(draw)) {
        confirmed++;
      }
      const merged: Draw = { ...prev, ...draw, main: draw.main, super: draw.super };
      if (tiers) merged.tiers = tiers;
      else delete merged.tiers;
      if (best === "archive") delete merged.provenance;
      else merged.provenance = best;
      byKey.set(key, merged);
      continue;
    }

    const prevEvidence = evidence(prev);
    const nextEvidence = evidence(draw);
    const winner = nextEvidence > prevEvidence ? draw : prev;
    const loser = winner === draw ? prev : draw;
    const reason =
      nextEvidence === prevEvidence
        ? "equal evidence on both sides; the version already stored was kept"
        : hasBreakdown(winner) && !hasBreakdown(loser)
          ? "the kept version carries a consistent prize breakdown"
          : `${provenanceOf(winner)} outranks ${provenanceOf(loser)}`;
    conflicts.push({
      date: draw.date,
      game: draw.game,
      kept: numbersOf(winner),
      keptProvenance: provenanceOf(winner),
      rejected: numbersOf(loser),
      rejectedProvenance: provenanceOf(loser),
      reason,
      detectedAt,
    });
    byKey.set(key, winner);
  }

  const draws = [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.game.localeCompare(b.game),
  );
  return { draws, conflicts, confirmed };
}

/** Merge freshly scraped draws into an existing dataset; see `reconcileDraws`. */
export function mergeDraws(existing: Draw[], incoming: Draw[]): Draw[] {
  return reconcileDraws(existing, incoming).draws;
}

/**
 * Append newly found conflicts to the ones already recorded, without
 * repeating an entry the previous update already wrote for the same
 * disagreement (an archive that keeps serving the wrong numbers would
 * otherwise add a line per run).
 */
export function appendConflicts(
  recorded: DrawConflict[] | undefined,
  found: DrawConflict[],
): DrawConflict[] {
  const out = [...(recorded ?? [])];
  const seen = new Set(out.map((c) => `${c.date}:${c.game}:${c.kept.join()}:${c.rejected.join()}`));
  for (const conflict of found) {
    const key = `${conflict.date}:${conflict.game}:${conflict.kept.join()}:${conflict.rejected.join()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(conflict);
  }
  return out;
}
