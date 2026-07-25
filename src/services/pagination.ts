/**
 * Pagination helpers for transaction history.
 *
 * Portals return long histories in pages. Two strategies are provided:
 *
 *  - `collectPages` — for endpoints with an explicit page index (connect mode):
 *    keep asking for the next page until one comes back short or empty.
 *
 *  - `collectUntilNoNew` — a defensive paginator for browser mode, where the
 *    discovered endpoint's paging contract is unknown. It keeps fetching pages
 *    but stops as soon as a page contributes no new records (deduplicated by a
 *    caller-supplied key). This is robust even when the portal ignores the page
 *    parameter and simply re-serves page 1: the second page adds nothing new, so
 *    we stop instead of looping forever.
 *
 * Both cap the number of pages so a misbehaving endpoint can never hang the CLI.
 */

export interface PageOptions {
  /** Records per page requested from the endpoint. */
  pageSize?: number;
  /** Hard cap on pages fetched, as a safety valve. */
  maxPages?: number;
  /** First page index (portals use either 0 or 1). */
  startPage?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;

/**
 * Fetch sequential pages until one returns fewer than `pageSize` rows (the last
 * page) or is empty, or until `maxPages` is reached. `fetchPage` receives the
 * page index and must return that page's rows.
 */
export async function collectPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  opts: PageOptions = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const startPage = opts.startPage ?? 0;

  const out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(startPage + i);
    out.push(...page);
    // A short or empty page means we've reached the end of the history.
    if (page.length < pageSize) break;
  }
  return out;
}

/**
 * Fetch pages until a page adds no new records. `keyOf` extracts a stable id per
 * record for deduplication. Safe against endpoints that ignore paging.
 */
export async function collectUntilNoNew<T>(
  fetchPage: (page: number) => Promise<T[]>,
  keyOf: (row: T) => string,
  opts: PageOptions = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const startPage = opts.startPage ?? 1;

  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(startPage + i);
    let added = 0;
    for (const row of page) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      added++;
    }
    // No new records on this page -> we're done (or the endpoint ignores paging).
    if (added === 0) break;
  }
  return out;
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
