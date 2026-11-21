/**
 * Pagination for transaction history.
 *
 * Portals return long histories in pages, and their paging contract is not
 * always trustworthy: some ignore the page parameter and re-serve the same page,
 * some end with an empty page, some with a short one. `collectDistinctPages`
 * handles all of these safely with a single rule set:
 *
 *  - stop on an empty page (end of history);
 *  - stop when a page's CONTENT signature repeats a page already seen — this
 *    catches an endpoint that ignores paging and keeps returning page 1, so we
 *    never loop or duplicate;
 *  - stop after a short page when a `pageSize` is known (the natural last page);
 *  - never exceed `maxPages` (a safety valve), reporting `truncated` when hit.
 *
 * Crucially the stop decision is based on page CONTENT, not on record ids, so it
 * works even when the records carry no stable id (synthesised ids would collide
 * across pages and silently drop data if used for deduplication).
 */

export interface PageOptions {
  /**
   * Records per page requested from the endpoint. When provided, a page shorter
   * than this ends the walk. When omitted, the walk relies on the empty-page and
   * repeated-page signals instead.
   */
  pageSize?: number;
  /** Hard cap on pages fetched, as a safety valve. */
  maxPages?: number;
  /** First page index (portals use either 0 or 1). */
  startPage?: number;
}

export interface PagedResult<T> {
  rows: T[];
  /** True when the walk stopped at `maxPages` and more data may exist. */
  truncated: boolean;
}

const DEFAULT_MAX_PAGES = 50;

/**
 * Walk pages via `fetchPage(pageIndex)`, accumulating rows until a stop signal.
 * `signatureOf` produces a stable, content-derived signature for a page so a
 * re-served page can be detected regardless of record ids.
 */
export async function collectDistinctPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  signatureOf: (rows: T[]) => string,
  opts: PageOptions = {},
): Promise<PagedResult<T>> {
  const { pageSize, startPage = 0 } = opts;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const seen = new Set<string>();
  const out: T[] = [];
  let i = 0;
  for (; i < maxPages; i++) {
    const page = await fetchPage(startPage + i);
    if (page.length === 0) break; // end of history

    const sig = signatureOf(page);
    if (seen.has(sig)) break; // endpoint re-served a page -> stop, no duplication
    seen.add(sig);

    out.push(...page);

    // A short page (when we know the page size) is the natural last page.
    if (pageSize !== undefined && page.length < pageSize) break;
  }
  // Ran the full budget without a natural stop -> there may be more history.
  return { rows: out, truncated: i === maxPages };
}

/** Add or replace a query parameter on a URL, preserving the rest. */
export function withQueryParam(
  url: string,
  name: string,
  value: string,
): string {
  try {
    const u = new URL(url);
    u.searchParams.set(name, value);
    return u.toString();
  } catch {
    // Relative URL or unparseable: fall back to a naive append.
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  }
}

export interface TransactionQuery {
  accountId: string;
  from: string;
  to: string;
}

/** Does a (lowercased) query-param name look like an account selector? */
function isAccountParam(k: string): boolean {
  return k.includes("cuenta") || k.includes("account") || k.includes("producto");
}
/** …like a range start? */
function isFromParam(k: string): boolean {
  return (
    k === "from" ||
    k.includes("desde") ||
    k.includes("inicial") ||
    k.includes("inicio") ||
    k.includes("startdate")
  );
}
/** …like a range end? */
function isToParam(k: string): boolean {
  return (
    k === "to" ||
    k.includes("hasta") ||
    k.includes("final") ||
    k.includes("enddate") ||
    (k.includes("fecha") && k.includes("fin"))
  );
}

/**
 * Re-scope a captured transactions URL to the requested account and date range.
 *
 * The URL captured during login carries whatever account/period the user happened
 * to view, so replaying it verbatim for a different query would return stale data.
 * The portal's exact parameter names are unknown, so we override the VALUE of any
 * existing param whose name matches an account / from / to hint, leaving all other
 * params intact. Params we don't recognise are left as captured; the caller still
 * applies a local date filter as a backstop.
 */
export function applyTransactionQuery(url: string, q: TransactionQuery): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      const k = key.toLowerCase();
      if (isAccountParam(k)) u.searchParams.set(key, q.accountId);
      else if (isFromParam(k)) u.searchParams.set(key, q.from);
      else if (isToParam(k)) u.searchParams.set(key, q.to);
    }
    return u.toString();
  } catch {
    return url;
  }
}
