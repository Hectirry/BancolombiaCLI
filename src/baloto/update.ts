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
import { isValidDraw, loadDataset, mergeDraws, saveDataset } from "./dataset.ts";
import {
  PRIMARY_SOURCE,
  SECONDARY_SOURCE,
  enrichWithPrizes,
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
  onProgress?: (message: string) => void;
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
}

const FORMAT_START_YEAR = Number(FORMAT_START_DATE.slice(0, 4));

export async function updateHistory(options: UpdateOptions = {}): Promise<UpdateResult> {
  const { full = false, skipPrizes = false, verify = false, concurrency = 6 } = options;
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

  let merged = mergeDraws(existing?.draws ?? [], valid);

  if (!skipPrizes) {
    const pending = new Set(merged.filter((d) => !d.tiers).map((d) => d.date)).size;
    log(`Fetching prize breakdowns for ${pending} draw date(s)…`);
    merged = await enrichWithPrizes(merged, concurrency, (done, total) => {
      if (done % 50 === 0 || done === total) log(`  ${done}/${total}`);
    });
  }

  const dataset: Dataset = {
    updatedAt: new Date().toISOString(),
    sources: verify ? [PRIMARY_SOURCE, SECONDARY_SOURCE] : [PRIMARY_SOURCE],
    draws: merged,
  };
  await saveDataset(dataset);

  return {
    dataset,
    fetched: valid.length,
    rejected,
    withPrizes: merged.filter((d) => d.tiers && d.tiers.length > 0).length,
    verification,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
