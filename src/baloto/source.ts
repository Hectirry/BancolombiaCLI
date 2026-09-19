/**
 * Scrapers for the public Baloto result archives.
 *
 * There is no official API, so results are read from the published result
 * pages. Two independent archives are supported: one is the primary source, the
 * other exists purely so `baloto update --verify` can cross-check the primary
 * before we run statistics on it. Agreement between two independently operated
 * archives is the strongest integrity check available without an official feed.
 */

import { PRIZE_TIERS } from "./rules.ts";
import { breakdownIsConsistent } from "./dataset.ts";
import type { Draw, Game, TierResult } from "./dataset.ts";

/** Primary archive: year index pages plus a per-draw prize breakdown page. */
export const PRIMARY_SOURCE = "https://resultados-de-loteria.com";
/** Secondary archive, used only to cross-check the primary. */
export const SECONDARY_SOURCE = "https://www.colombialoterias.com";

const MONTHS_ABBR: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

const MONTHS_FULL: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const WEEKDAYS = "lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo";

/** Strip tags and collapse whitespace so the page can be read as a token stream. */
function toText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** How a URL is turned into HTML. Swappable so tests can serve fixtures. */
export type HttpGet = (url: string) => Promise<string>;

const defaultHttpGet: HttpGet = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "bancolombia-cli/baloto (+personal use)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
};

let httpGet: HttpGet = defaultHttpGet;

/**
 * Replace the HTTP transport. Tests inject fixtures with this; it is also the
 * escape hatch when the runtime's `fetch` cannot reach the network directly
 * (corporate TLS-terminating proxies, for instance).
 */
export function setHttpGet(fn: HttpGet | null): void {
  httpGet = fn ?? defaultHttpGet;
}

async function fetchText(url: string, attempts = 4): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await httpGet(url);
    } catch (err) {
      lastError = err;
      // Archives rate-limit bursts; back off before trying again.
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Could not fetch ${url}: ${(lastError as Error).message}`);
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
      onProgress?.(++done, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Parse a year index page into draws. Each row carries the Baloto numbers and
 * the Revancha numbers for the same night.
 */
export function parseYearPage(html: string): Draw[] {
  const text = toText(html);
  const start = text.indexOf("Fecha del sorteo");
  const body = start >= 0 ? text.slice(start) : text;

  const dateRe = new RegExp(`(?:${WEEKDAYS})\\s+(\\d{1,2})\\s+([a-zá]{3})\\.?\\s+(\\d{4})`, "gi");
  const marks = [...body.matchAll(dateRe)];
  const draws: Draw[] = [];

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const segment = body.slice(
      mark.index! + mark[0].length,
      i + 1 < marks.length ? marks[i + 1]!.index! : body.length,
    );
    const month = MONTHS_ABBR[mark[2]!.toLowerCase().slice(0, 3).replace("á", "a")];
    if (!month) continue;
    const date = `${mark[3]}-${pad(month)}-${pad(Number(mark[1]))}`;

    const [balotoPart, revanchaPart] = segment.split(/Revancha/i);
    const pairs: [Game, string | undefined][] = [
      ["baloto", balotoPart],
      ["revancha", revanchaPart],
    ];
    for (const [game, part] of pairs) {
      if (!part) continue;
      const nums = (part.match(/\b\d{1,2}\b/g) ?? []).map(Number);
      if (nums.length < 6) continue;
      const six = nums.slice(0, 6);
      draws.push({ date, game, main: six.slice(0, 5), super: six[5]! });
    }
  }
  return draws;
}

/** Parse "1.936.350" into 1936350. */
function parseAmount(raw: string): number {
  return Number(raw.replace(/\./g, "")) || 0;
}

/**
 * Parse the per-draw prize breakdown. The page renders one table per game with
 * a row per category: prize per winner, total paid, and winner count (the
 * jackpot row inserts the word "Acumulado" when it rolls over).
 */
export function parseDrawDetail(html: string): Record<Game, TierResult[]> {
  const text = toText(html);
  const revanchaAt = text.search(/Premios de Revancha/i);
  const sections: Record<Game, string> = {
    baloto: revanchaAt >= 0 ? text.slice(0, revanchaAt) : text,
    revancha: revanchaAt >= 0 ? text.slice(revanchaAt) : "",
  };

  const labels: Record<string, RegExp> = {
    "5+S": /5\s*Aciertos?\s*\+\s*S[úu]per\s*Balota/i,
    "5": /5\s*Aciertos?(?!\s*\+)/i,
    "4+S": /4\s*Aciertos?\s*\+\s*S[úu]per\s*Balota/i,
    "4": /4\s*Aciertos?(?!\s*\+)/i,
    "3+S": /3\s*Aciertos?\s*\+\s*S[úu]per\s*Balota/i,
    "3": /3\s*Aciertos?(?!\s*\+)/i,
    "2+S": /2\s*Aciertos?\s*\+\s*S[úu]per\s*Balota/i,
    // The eighth row spells out both cases it covers; the whole label has to be
    // consumed or the amounts that follow cannot be read.
    "1+S": /1\s*Aciertos?\s*\+\s*S[úu]per\s*Balota\s*y\s*0\s*\+\s*S[úu]per\s*Balota/i,
  };
  // "N $  N $  [Acumulado]  N" — prize per winner, total paid, winner count.
  const row = /^\s*([\d.]+)\s*\$\s*([\d.]+)\s*\$\s*(?:Acumulado\s*)?([\d.]+)/;

  const out: Record<Game, TierResult[]> = { baloto: [], revancha: [] };
  for (const game of ["baloto", "revancha"] as Game[]) {
    const section = sections[game];
    const head = section.search(/Categor[íi]a/i);
    if (head < 0) continue;
    let cursor = head;
    for (const tier of PRIZE_TIERS) {
      const rest = section.slice(cursor);
      const label = labels[tier.id]!.exec(rest);
      if (!label) continue;
      const after = rest.slice(label.index + label[0].length);
      const m = after.match(row);
      if (!m) continue;
      out[game].push({
        tier: tier.id,
        prizePerWinner: parseAmount(m[1]!),
        totalPaid: parseAmount(m[2]!),
        winners: parseAmount(m[3]!),
      });
      // Resume after the row we just consumed so later categories cannot
      // re-match earlier text.
      cursor += label.index + label[0].length + m[0].length;
    }
    // Reject a breakdown whose rows do not multiply out rather than feed
    // silently corrupted counts into the models downstream.
    if (!breakdownIsConsistent(out[game])) out[game] = [];
  }
  return out;
}

/**
 * Fetch every draw of a calendar year from the primary archive.
 *
 * A year page that parses to nothing means the archive answered with an error
 * or changed layout — never a real year without draws. Failing loudly here
 * stops a silent hole from reaching the statistics.
 */
export async function fetchYear(year: number): Promise<Draw[]> {
  const draws = parseYearPage(await fetchText(`${PRIMARY_SOURCE}/baloto/resultados/${year}`));
  if (draws.length === 0) {
    throw new Error(
      `The ${year} results page returned no draws — the archive may be rate-limiting ` +
        "or its layout changed. Try again before trusting the dataset.",
    );
  }
  return draws;
}

/**
 * Fetch the prize breakdown for one draw date. Older draws (and nights with no
 * draw) simply have no table, in which case both games come back empty.
 */
export async function fetchDrawDetail(date: string): Promise<Record<Game, TierResult[]>> {
  const [y, m, d] = date.split("-");
  const html = await fetchText(`${PRIMARY_SOURCE}/baloto/resultados/${d}-${m}-${y}`);
  return parseDrawDetail(html);
}

/** Attach prize breakdowns to draws that do not have one yet. */
export async function enrichWithPrizes(
  draws: Draw[],
  concurrency = 6,
  onProgress?: (done: number, total: number) => void,
): Promise<Draw[]> {
  const dates = [...new Set(draws.filter((d) => !d.tiers).map((d) => d.date))].sort();
  const details = await mapPool(
    dates,
    concurrency,
    async (date) => {
      try {
        return await fetchDrawDetail(date);
      } catch {
        // A missing breakdown is normal for older draws; keep the numbers.
        return { baloto: [], revancha: [] } as Record<Game, TierResult[]>;
      }
    },
    onProgress,
  );
  const byDate = new Map(dates.map((date, i) => [date, details[i]!]));
  return draws.map((draw) => {
    const tiers = byDate.get(draw.date)?.[draw.game];
    return tiers && tiers.length > 0 ? { ...draw, tiers } : draw;
  });
}

/**
 * Parse the secondary archive's year page. Rows read
 * "Resultado DD Mes <5 baloto> <super> <5 revancha> <super>".
 */
export function parseSecondaryYearPage(html: string, year: number): Draw[] {
  const text = toText(html);
  const months = Object.keys(MONTHS_FULL).join("|");
  const re = new RegExp(
    `Resultado\\s+(\\d{1,2})\\s+(${months})\\s+((?:(?:Premios:\\s*\\$\\s*[\\d,.]+\\s*)?\\d{2}\\s+){11}\\d{2})`,
    "gi",
  );
  const draws: Draw[] = [];
  for (const m of text.matchAll(re)) {
    const month = MONTHS_FULL[m[2]!.toLowerCase()]!;
    const date = `${year}-${pad(month)}-${pad(Number(m[1]))}`;
    const nums = (m[3]!.replace(/Premios:\s*\$\s*[\d,.]+/g, "").match(/\b\d{2}\b/g) ?? [])
      .map(Number);
    if (nums.length !== 12) continue;
    draws.push({ date, game: "baloto", main: nums.slice(0, 5), super: nums[5]! });
    draws.push({ date, game: "revancha", main: nums.slice(6, 11), super: nums[11]! });
  }
  return draws;
}

export interface Mismatch {
  date: string;
  game: Game;
  primary: number[];
  secondary: number[];
  /**
   * True when the disagreement is explained by a known defect of the secondary
   * archive: on many 2021–2024 pages it repeats the Baloto Súper Balota on the
   * Revancha row instead of Revancha's own. Such rows are evidence against the
   * secondary source, not against ours.
   */
  secondaryDefect: boolean;
}

export interface VerificationReport {
  year: number;
  compared: number;
  mismatches: Mismatch[];
  /** Draws the secondary archive did not cover at all. */
  unmatched: number;
}

/** Genuine disagreements: mismatches not attributable to the secondary's defect. */
export function realMismatches(report: VerificationReport): Mismatch[] {
  return report.mismatches.filter((m) => !m.secondaryDefect);
}

/** Cross-check one year of the primary archive against the secondary one. */
export async function verifyYear(year: number, primary: Draw[]): Promise<VerificationReport> {
  const html = await fetchText(`${SECONDARY_SOURCE}/baloto/${year}`);
  const secondary = parseSecondaryYearPage(html, year);
  const index = new Map(secondary.map((d) => [`${d.date}:${d.game}`, d]));

  const report: VerificationReport = { year, compared: 0, mismatches: [], unmatched: 0 };
  for (const draw of primary) {
    if (!draw.date.startsWith(String(year))) continue;
    const other = index.get(`${draw.date}:${draw.game}`);
    if (!other) {
      report.unmatched++;
      continue;
    }
    report.compared++;
    const mainAgrees = draw.main.join(",") === other.main.join(",");
    if (mainAgrees && draw.super === other.super) continue;

    const twin = index.get(`${draw.date}:baloto`);
    const secondaryDefect =
      mainAgrees && draw.game === "revancha" && twin?.super === other.super;
    report.mismatches.push({
      date: draw.date,
      game: draw.game,
      primary: [...draw.main, draw.super],
      secondary: [...other.main, other.super],
      secondaryDefect,
    });
  }
  return report;
}

export { fetchText, mapPool };
