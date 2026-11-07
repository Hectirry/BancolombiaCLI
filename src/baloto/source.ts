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
import { breakdownIsConsistent, isDrawDay, isValidDraw } from "./dataset.ts";
import type { Draw, Game, TierResult } from "./dataset.ts";

/** Primary archive: year index pages plus a per-draw prize breakdown page. */
export const PRIMARY_SOURCE = "https://resultados-de-loteria.com";
/** Secondary archive, used only to cross-check the primary. */
export const SECONDARY_SOURCE = "https://www.colombialoterias.com";
/**
 * The operator's own site. Tertiary because it publishes one page per draw
 * number with no year index, so it cannot rebuild the history; it is the
 * authority for the latest draws, which the archives sometimes post a day or
 * more late.
 */
export const OFFICIAL_SOURCE = "https://baloto.com";

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
      // A page that does not exist will not appear on retry.
      if (/\bHTTP (404|410)\b/.test((err as Error).message)) break;
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

// ---------------------------------------------------------------------------
// Tertiary source: baloto.com, one page per draw number.
// ---------------------------------------------------------------------------

/**
 * Why an official page could not be read. `not-found` is the normal end of a
 * forward walk (the operator answers a draw that does not exist yet with a
 * redirect to the results index, not a 404). `layout` means the page exists
 * but no longer looks the way the parser expects — the caller must stop and
 * say so, never store a guess.
 */
export class OfficialPageError extends Error {
  constructor(
    readonly kind: "not-found" | "layout",
    message: string,
  ) {
    super(message);
    this.name = "OfficialPageError";
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Parse "03 de Octubre de 2026" into "2026-10-03". The day must exist in that
 * month (no 31 de Febrero) and the result must be a Baloto night; anything
 * else is a transcription or parsing error and is refused.
 */
export function parseSpanishLongDate(raw: string): string {
  const m = /^\s*(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})\s*$/i.exec(raw);
  if (!m) throw new OfficialPageError("layout", `Unreadable date "${raw.trim()}"`);
  const day = Number(m[1]);
  const month = MONTHS_FULL[stripAccents(m[2]!)];
  const year = Number(m[3]);
  if (!month) throw new OfficialPageError("layout", `Unknown month in "${raw.trim()}"`);
  const date = `${year}-${pad(month)}-${pad(day)}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new OfficialPageError("layout", `Impossible calendar date "${raw.trim()}"`);
  }
  return date;
}

/** Read "NN - NN - NN - NN - NN - NN" as five main numbers and a Súper Balota. */
export function parseBallSequence(text: string): { main: number[]; super: number } | null {
  const m = /(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/.exec(text);
  if (!m) return null;
  const nums = m.slice(1, 7).map(Number);
  return { main: nums.slice(0, 5), super: nums[5]! };
}

/** The official page draws each ball in its own element, coloured by role. */
function parseBallElements(html: string): { main: number[]; super: number } | null {
  const yellow = [...html.matchAll(/class="yellow-ball(?:\s[^"]*)?"[^>]*>\s*(\d{1,2})\s*</g)].map((m) => Number(m[1]));
  const red = [...html.matchAll(/class="red-ball(?:\s[^"]*)?"[^>]*>\s*(\d{1,2})\s*</g)].map((m) => Number(m[1]));
  if (yellow.length !== 5 || red.length !== 1) return null;
  return { main: yellow, super: red[0]! };
}

/** "$61.200 MILLONES" → 61 200 000 000. */
function parseMillions(raw: string): number {
  return parseAmount(raw) * 1_000_000;
}

/**
 * Parse the operator's prize table. Columns, in the page's order: category,
 * total paid, winners, prize per winner. The last row is "0 + SB", which the
 * operator uses for the grouped "1 or 0 matches + Súper Balota" category.
 *
 * Returns an empty list — never a partial one — when the table is absent or
 * does not multiply out, with the reason in `warnings`.
 */
function parseOfficialTiers(
  text: string,
  jackpot: number | null,
  warnings: string[],
): TierResult[] {
  const head = /ACIERTOS\s+PREMIO TOTAL\s+GANADORES\s+PREMIO POR GANADOR/i.exec(text);
  if (!head) {
    warnings.push("prize table not found");
    return [];
  }
  const labels: Record<string, RegExp> = {
    "5+S": /^\s*5\s*\+\s*SB\b/,
    "5": /^\s*5\b(?!\s*\+)/,
    "4+S": /^\s*4\s*\+\s*SB\b/,
    "4": /^\s*4\b(?!\s*\+)/,
    "3+S": /^\s*3\s*\+\s*SB\b/,
    "3": /^\s*3\b(?!\s*\+)/,
    "2+S": /^\s*2\s*\+\s*SB\b/,
    "1+S": /^\s*(?:1\s*\+\s*SB\s*(?:y|ó|o|\/)\s*)?[01]\s*\+\s*SB\b/,
  };
  // "$total  winners  $perWinner"
  const row = /^\s*\$\s*([\d.]+)\s+([\d.]+)\s+\$\s*([\d.]+)/;
  const out: TierResult[] = [];
  let rest = text.slice(head.index + head[0].length);
  for (const tier of PRIZE_TIERS) {
    const label = labels[tier.id]!.exec(rest);
    if (!label) {
      warnings.push(`prize row "${tier.id}" not found`);
      return [];
    }
    const after = rest.slice(label.index + label[0].length);
    const m = row.exec(after);
    if (!m) {
      warnings.push(`prize row "${tier.id}" has no readable amounts`);
      return [];
    }
    const winners = parseAmount(m[2]!);
    let prizePerWinner = parseAmount(m[3]!);
    // An unclaimed jackpot prints $0; the archives record the pot that was at
    // stake, which is what the economics downstream expect.
    if (tier.id === "5+S" && winners === 0 && prizePerWinner === 0 && jackpot) {
      prizePerWinner = jackpot;
    }
    out.push({ tier: tier.id, prizePerWinner, totalPaid: parseAmount(m[1]!), winners });
    rest = after.slice(m.index + m[0].length);
  }
  if (!breakdownIsConsistent(out)) {
    warnings.push("prize table does not multiply out");
    return [];
  }
  return out;
}

export interface OfficialDetail {
  /** Draw number as printed, e.g. 2716. */
  index: number;
  game: Game;
  date: string;
  main: number[];
  super: number;
  /** Operator's prize table, empty when absent or inconsistent. */
  tiers: TierResult[];
  /** Jackpot at stake in this draw, when printed. */
  jackpot: number | null;
  warnings: string[];
}

/**
 * Parse one `/resultados-<game>/<n>` page. Fails loudly, with the reason, when
 * the page is the results index (draw not published), when the header is
 * missing or reports another draw number, when the date is malformed or not a
 * Baloto night, when the weekday printed contradicts the date, or when the
 * numbers do not form a valid draw. It never returns a guess.
 */
export function parseOfficialDetail(html: string, game: Game, expectedIndex?: number): OfficialDetail {
  const text = toText(html);

  if (/HIST[ÓO]RICO DE RESULTADOS/i.test(text) && !/\bSORTEO\s+[\d.]+\s/i.test(text)) {
    throw new OfficialPageError(
      "not-found",
      `baloto.com has no page for ${game} draw ${expectedIndex ?? "?"} yet (it answers with the results index)`,
    );
  }

  const header = new RegExp(
    `\\bSORTEO\\s+([\\d.]+)\\s+(${WEEKDAYS})\\s+(\\d{1,2}\\s+de\\s+[a-záéíóú]+\\s+de\\s+\\d{4})`,
    "i",
  ).exec(text);
  if (!header) {
    throw new OfficialPageError(
      "layout",
      `baloto.com ${game} page has no "SORTEO <n> <weekday> <date>" header — its layout may have changed`,
    );
  }
  const index = Number(header[1]!.replace(/\./g, ""));
  if (!Number.isInteger(index) || index <= 0) {
    throw new OfficialPageError("layout", `Unreadable draw number "${header[1]}"`);
  }
  if (expectedIndex !== undefined && index !== expectedIndex) {
    throw new OfficialPageError(
      "layout",
      `Requested ${game} draw ${expectedIndex} but the page reports draw ${index}`,
    );
  }

  const date = parseSpanishLongDate(header[3]!);
  const printedWeekday = WEEKDAY_INDEX[stripAccents(header[2]!)];
  const actualWeekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (printedWeekday !== actualWeekday) {
    throw new OfficialPageError(
      "layout",
      `Draw ${index}: page says "${header[2]}" but ${date} is not that weekday`,
    );
  }
  if (!isDrawDay(date)) {
    throw new OfficialPageError(
      "layout",
      `Draw ${index} is dated ${date}, which is not a Monday, Wednesday or Saturday`,
    );
  }

  const balls = parseBallElements(html) ?? parseBallSequence(text.slice(header.index));
  if (!balls) {
    throw new OfficialPageError("layout", `Draw ${index}: could not find the six balls on the page`);
  }
  const draw: Draw = { date, game, main: balls.main, super: balls.super };
  if (!isValidDraw(draw)) {
    throw new OfficialPageError(
      "layout",
      `Draw ${index}: ${[...balls.main, balls.super].join(" ")} is not a valid 5/43 + 1/16 result`,
    );
  }

  const jackpotMatch = /ACUMULADO DEL SORTEO:\s*\$\s*([\d.]+)\s*MILLONES/i.exec(text);
  const jackpot = jackpotMatch ? parseMillions(jackpotMatch[1]!) : null;
  const warnings: string[] = [];
  const tiers = parseOfficialTiers(text.slice(header.index), jackpot, warnings);

  return { index, game, date, main: balls.main, super: balls.super, tiers, jackpot, warnings };
}

export interface OfficialIndexRow {
  index: number;
  game: Game;
  date: string;
  main: number[];
  super: number;
}

/**
 * Parse the results index (`/resultados`): the latest draw number and the
 * rows of the history table, each linking to its detail page.
 */
export function parseOfficialIndexPage(html: string): { latestIndex: number; rows: OfficialIndexRow[] } {
  const text = toText(html);
  const latest = /Resultado sorteo\s*#\s*(\d+)/i.exec(text);
  if (!latest) {
    throw new OfficialPageError(
      "layout",
      'baloto.com results index has no "Resultado sorteo #<n>" banner — its layout may have changed',
    );
  }
  const rows: OfficialIndexRow[] = [];
  for (const tr of html.split(/<tr\b/i).slice(1)) {
    const link = /href="\/resultados-(baloto|revancha)\/(\d+)"/i.exec(tr);
    if (!link) continue;
    const rowText = toText(tr);
    const dateText = /(\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4})/i.exec(rowText);
    const balls = parseBallSequence(rowText);
    if (!dateText || !balls) continue;
    const game = link[1]!.toLowerCase() as Game;
    const row: OfficialIndexRow = {
      index: Number(link[2]),
      game,
      date: parseSpanishLongDate(dateText[1]!),
      main: balls.main,
      super: balls.super,
    };
    if (!isDrawDay(row.date) || !isValidDraw({ ...row })) continue;
    rows.push(row);
  }
  return { latestIndex: Number(latest[1]), rows };
}

async function fetchOfficialPage(url: string): Promise<string> {
  try {
    return await fetchText(url, 2);
  } catch (err) {
    if (/\bHTTP (404|410)\b/.test((err as Error).message)) {
      throw new OfficialPageError("not-found", `baloto.com has no page at ${url}`);
    }
    throw err;
  }
}

/** The latest draw number baloto.com advertises on its results index. */
export async function fetchOfficialLatestIndex(): Promise<number> {
  return parseOfficialIndexPage(await fetchOfficialPage(`${OFFICIAL_SOURCE}/resultados`)).latestIndex;
}

/**
 * Fetch draw `n` from the operator: Baloto and Revancha, with prize tables.
 * Both pages must report the same date — they are the same night — or the
 * result is refused. Throws `OfficialPageError` with `kind: "not-found"` when
 * the draw is not published yet.
 */
export async function fetchOfficialDetail(n: number): Promise<Record<Game, OfficialDetail>> {
  const [baloto, revancha] = await Promise.all(
    (["baloto", "revancha"] as Game[]).map(async (game) =>
      parseOfficialDetail(await fetchOfficialPage(`${OFFICIAL_SOURCE}/resultados-${game}/${n}`), game, n),
    ),
  );
  if (baloto!.date !== revancha!.date) {
    throw new OfficialPageError(
      "layout",
      `Draw ${n}: Baloto is dated ${baloto!.date} but Revancha ${revancha!.date}`,
    );
  }
  return { baloto: baloto!, revancha: revancha! };
}

export function officialDetailToDraw(detail: OfficialDetail): Draw {
  const draw: Draw = {
    date: detail.date,
    game: detail.game,
    main: detail.main,
    super: detail.super,
    provenance: "official",
  };
  if (detail.tiers.length > 0) draw.tiers = detail.tiers;
  return draw;
}

export interface OfficialFetch {
  /** New official draws, both games, oldest first. */
  draws: Draw[];
  /** Last draw number confirmed to exist. */
  lastIndex: number;
  /** Draw numbers read in this run. */
  indices: number[];
  warnings: string[];
}

/**
 * Walk forward from the last known draw number until the operator has no
 * page for the next one, or serves a page whose date does not advance (a
 * site that answered an unknown number with its latest draw would otherwise
 * duplicate it). Without a known index, the results index names the latest
 * draw and only that one is read.
 *
 * A layout error anywhere stops the walk and propagates: a page that cannot
 * be parsed is a reason to fix the parser, not to skip a draw.
 */
export async function fetchLatestOfficial(
  fromIndex?: number,
  options: { max?: number; onProgress?: (message: string) => void } = {},
): Promise<OfficialFetch> {
  const { max = 40, onProgress = () => {} } = options;
  const out: OfficialFetch = { draws: [], lastIndex: fromIndex ?? 0, indices: [], warnings: [] };

  let n: number;
  if (fromIndex === undefined) {
    n = await fetchOfficialLatestIndex();
    onProgress(`baloto.com advertises draw ${n}`);
  } else {
    n = fromIndex + 1;
  }

  let lastDate: string | null = null;
  for (let step = 0; step < max; step++, n++) {
    let detail: Record<Game, OfficialDetail>;
    try {
      detail = await fetchOfficialDetail(n);
    } catch (err) {
      if (err instanceof OfficialPageError && err.kind === "not-found") break;
      throw err;
    }
    if (lastDate !== null && detail.baloto.date <= lastDate) {
      out.warnings.push(
        `draw ${n} is dated ${detail.baloto.date}, not after ${lastDate}; stopped before storing it`,
      );
      break;
    }
    lastDate = detail.baloto.date;
    out.lastIndex = n;
    out.indices.push(n);
    out.draws.push(officialDetailToDraw(detail.baloto), officialDetailToDraw(detail.revancha));
    for (const game of ["baloto", "revancha"] as Game[]) {
      for (const w of detail[game].warnings) out.warnings.push(`draw ${n} ${game}: ${w}`);
    }
    onProgress(`  draw ${n} (${detail.baloto.date}): ${detail.baloto.tiers.length > 0 ? "numbers + prizes" : "numbers only"}`);
  }
  return out;
}

export { fetchText, mapPool };
