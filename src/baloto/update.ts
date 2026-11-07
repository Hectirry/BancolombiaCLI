/**
 * Building and refreshing the local Baloto history.
 *
 * Two passes: the year index pages give every draw's numbers, then one request
 * per draw date collects the prize breakdown (winners and payout per category)
 * where the operator published it. The breakdown is optional for the randomness
 * tests but essential for the economics: it is the only public evidence of how
 * many people play and how they pick.
 */

import { FORMAT_START_DATE } from "./rules.ts";
import type { Dataset, Draw } from "./dataset.ts";
import type { DrawConflict } from "./dataset.ts";
import {
  appendConflicts,
  isValidDraw,
  loadDataset,
  reconcileDraws,
  saveDataset,
} from "./dataset.ts";
import {
  OFFICIAL_SOURCE,
  PRIMARY_SOURCE,
  SECONDARY_SOURCE,
  enrichWithPrizes,
  fetchLatestOfficial,
  fetchYear,
  verifyYear,
  type VerificationReport,
} from "./source.ts";

export interface UpdateOptions {
  /** Re-download everything instead of only the current and previous year. */
  full?: boolean;
  /** Skip the per-draw prize breakdown pass (much faster, fewer requests). */
  skipPrizes?: boolean;
  /** Cross-check the scraped numbers against a second archive. */
  verify?: boolean;
  /** Parallel requests for the prize pass. */
  concurrency?: number;
  /**
   * Read the latest draws from the operator's own pages (baloto.com) after the
   * archives, walking forward from the last draw number stored. On by default;
   * a failure there is reported, not fatal, because the archive passes stand
   * on their own.
   */
  official?: boolean;
  onProgress?: (message: string) => void;
}

export interface OfficialPassResult {
  /** Draws read from baloto.com in this run (both games). */
  fetched: number;
  /** Draw numbers read. */
  indices: number[];
  /** Last draw number known to exist on baloto.com after this run. */
  lastIndex?: number;
  /** Press-sourced rows confirmed by an official version with a prize table. */
  confirmed: number;
  warnings: string[];
  /** Set when the pass could not run; the dataset was still updated from the archives. */
  error?: string;
}

export interface UpdateResult {
  dataset: Dataset;
  /** Draws added or refreshed in this run. */
  fetched: number;
  /** Draws rejected because they do not fit the current game format. */
  rejected: number;
  /** How many draws now carry a prize breakdown. */
  withPrizes: number;
  verification: VerificationReport[];
  /** Source disagreements noticed in this run (also persisted in the dataset). */
  conflicts: DrawConflict[];
  official?: OfficialPassResult;
}

const FORMAT_START_YEAR = Number(FORMAT_START_DATE.slice(0, 4));

export async function updateHistory(options: UpdateOptions = {}): Promise<UpdateResult> {
  const {
    full = false,
    skipPrizes = false,
    verify = false,
    concurrency = 6,
    official = true,
  } = options;
  const startedAt = new Date().toISOString();
  const log = options.onProgress ?? (() => {});

  const existing = await loadDataset();
  const currentYear = new Date().getFullYear();
  const years = full || !existing
    ? range(FORMAT_START_YEAR, currentYear)
    : range(Math.max(FORMAT_START_YEAR, currentYear - 1), currentYear);

  log(`Downloading ${years.length} year(s) of results…`);
  const scraped: Draw[] = [];
  for (const year of years) {
    const draws = await fetchYear(year);
    scraped.push(...draws);
    log(`  ${year}: ${draws.length} rows`);
  }

  // Anything outside the current 5/43 + 1/16 format is a different game and
  // would silently corrupt every statistic that follows.
  const valid = scraped.filter(isValidDraw);
  const rejected = scraped.length - valid.length;

  const verification: VerificationReport[] = [];
  if (verify) {
    for (const year of years) {
      log(`  cross-checking ${year} against ${SECONDARY_SOURCE}…`);
      verification.push(await verifyYear(year, valid));
    }
  }

  const reconciled = reconcileDraws(existing?.draws ?? [], valid, startedAt);
  let merged = reconciled.draws;
  const conflicts = [...reconciled.conflicts];

  if (!skipPrizes) {
    const pending = new Set(merged.filter((d) => !d.tiers).map((d) => d.date)).size;
    log(`Fetching prize breakdowns for ${pending} draw date(s)…`);
    merged = await enrichWithPrizes(merged, concurrency, (done, total) => {
      if (done % 50 === 0 || done === total) log(`  ${done}/${total}`);
    });
  }

  let officialIndex = existing?.officialIndex;
  let officialPass: OfficialPassResult | undefined;
  if (official) {
    officialPass = { fetched: 0, indices: [], lastIndex: officialIndex, confirmed: 0, warnings: [] };
    try {
      log(
        officialIndex
          ? `Reading ${OFFICIAL_SOURCE} forward from draw ${officialIndex}…`
          : `Reading the latest draw from ${OFFICIAL_SOURCE}…`,
      );
      const result = await fetchLatestOfficial(officialIndex, { onProgress: log });
      const again = reconcileDraws(merged, result.draws, startedAt);
      merged = again.draws;
      conflicts.push(...again.conflicts);
      if (result.lastIndex > 0) officialIndex = result.lastIndex;
      officialPass = {
        fetched: result.draws.length,
        indices: result.indices,
        lastIndex: officialIndex,
        confirmed: again.confirmed,
        warnings: result.warnings,
      };
    } catch (err) {
      officialPass.error = (err as Error).message;
      log(`  baloto.com pass skipped: ${officialPass.error}`);
    }
  }

  // Provenance notes written by hand (e.g. a draw typed in from the press)
  // must survive the next update; only the scrapers' own entries are managed.
  const managed = new Set([PRIMARY_SOURCE, SECONDARY_SOURCE, OFFICIAL_SOURCE]);
  const sources = [PRIMARY_SOURCE];
  if (verify) sources.push(SECONDARY_SOURCE);
  if (officialPass && !officialPass.error) sources.push(OFFICIAL_SOURCE);
  for (const s of existing?.sources ?? []) if (!managed.has(s)) sources.push(s);

  const dataset: Dataset = {
    updatedAt: new Date().toISOString(),
    sources,
    draws: merged,
  };
  if (officialIndex !== undefined) dataset.officialIndex = officialIndex;
  const allConflicts = appendConflicts(existing?.conflicts, conflicts);
  if (allConflicts.length > 0) dataset.conflicts = allConflicts;
  await saveDataset(dataset);

  return {
    dataset,
    fetched: valid.length,
    rejected,
    withPrizes: merged.filter((d) => d.tiers && d.tiers.length > 0).length,
    verification,
    conflicts,
    official: officialPass,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
