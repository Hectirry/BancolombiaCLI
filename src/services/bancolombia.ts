/**
 * Data access for accounts, balances and transactions.
 *
 * The provider is chosen from the stored session:
 *  - connect mode  -> plain HTTPS calls to the API proxy with a bearer token.
 *  - browser mode  -> Playwright reuses the saved cookies (storage state) and
 *    calls the portal's JSON endpoints through an authenticated request context.
 *
 * Endpoint paths are the same in both modes and live in one place so they can be
 * adjusted if the portal changes. Raw responses are validated against the Zod
 * schemas, so downstream consumers (CLI, REST API, MCP) always get clean data.
 */

import { request as httpRequest, HttpError } from "../http.ts";
import { config } from "../config.ts";
import { requireSession } from "./session.ts";
import { SessionExpiredError } from "../errors.ts";
import {
  loadEndpoints,
  normalizeAccounts,
  normalizeTransactions,
} from "./discovery.ts";
import { collectDistinctPages, withQueryParam } from "./pagination.ts";
import {
  AccountSchema,
  TransactionSchema,
  type Account,
  type Transaction,
  type DateRange,
  type Session,
} from "../schemas/index.ts";
import { z } from "zod";

/** Records requested per transactions page. */
const TX_PAGE_SIZE = 100;
/** Query parameter the browser-mode paginator appends (portal-dependent). */
const BROWSER_PAGE_PARAM = process.env.BANCOLOMBIA_TX_PAGE_PARAM ?? "page";

/** Logical API paths, resolved against the session's base URL / portal. */
const PATHS = {
  accounts: "/api/accounts",
  balance: (accountId: string) =>
    `/api/accounts/${encodeURIComponent(accountId)}/balance`,
  transactions: "/api/transactions",
} as const;

const AccountListSchema = z.array(AccountSchema);
const TransactionListSchema = z.array(TransactionSchema);

/**
 * A rejected saved login shows up as HTTP 401/403 or a redirect to the login
 * page. Treat those as an expired session with an actionable message. The URL
 * check looks at the PATH only (never the query string) and requires a `/login`
 * path segment, so a data endpoint like `/login-info` or a `?redirect=/login`
 * query is not misread as an expiry.
 */
function isAuthRejection(status: number, finalUrl?: string): boolean {
  if (status === 401 || status === 403) return true;
  if (!finalUrl) return false;
  try {
    return /\/login(\/|$)/i.test(new URL(finalUrl).pathname);
  } catch {
    return /\/login(\/|$)/i.test(finalUrl);
  }
}

/** Content-derived signature of a transaction page (id-independent). */
function txPageSignature(rows: Transaction[]): string {
  return rows
    .map((t) => `${t.date}|${t.amount.amount}|${t.description}`)
    .join("");
}

/** Warn (on stderr, safe for MCP stdio) when a history walk was truncated. */
function warnIfTruncated(truncated: boolean, accountId: string): void {
  if (truncated) {
    console.error(
      `[bancolombia] warning: transaction history for ${accountId} hit the ` +
        `page cap; results may be incomplete.`,
    );
  }
}

/** Fetch an absolute URL in browser mode, reusing the saved portal cookies. */
async function browserGetJson(url: string): Promise<unknown> {
  const { request: pwRequest } = await import("playwright");
  const ctx = await pwRequest.newContext({
    storageState: config.storageStatePath,
  });
  try {
    const res = await ctx.get(url);
    if (isAuthRejection(res.status(), res.url())) {
      throw new SessionExpiredError(`portal returned ${res.status()}`);
    }
    if (!res.ok()) {
      throw new Error(
        `Portal request failed (${res.status()} ${res.statusText()}) for ${url}`,
      );
    }
    return await res.json();
  } finally {
    await ctx.dispose();
  }
}

/** GET a connect-mode proxy path with the bearer token. */
async function connectGet<T>(
  session: Session,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const base = (session.apiUrl ?? "").replace(/\/$/, "");
  try {
    return await httpRequest<T>(`${base}${path}${qs}`, { token: session.token });
  } catch (err) {
    if (err instanceof HttpError && isAuthRejection(err.status)) {
      throw new SessionExpiredError(`proxy returned ${err.status}`);
    }
    throw err;
  }
}

function noEndpointError(kind: "accounts" | "transactions"): Error {
  return new Error(
    `No ${kind} endpoint has been discovered yet. Run \`bancolombia login\`, ` +
      `open your ${kind} in the browser so the session is captured, then retry.`,
  );
}

export async function getAccounts(): Promise<Account[]> {
  const session = await requireSession();

  if (session.method === "connect") {
    return AccountListSchema.parse(await connectGet<unknown>(session, PATHS.accounts));
  }

  // browser mode: replay the endpoint discovered from the real portal session.
  const endpoints = await loadEndpoints();
  if (!endpoints?.accountsUrl) throw noEndpointError("accounts");
  return normalizeAccounts(await browserGetJson(endpoints.accountsUrl));
}

export async function getBalance(accountId: string): Promise<Account> {
  const session = await requireSession();

  if (session.method === "connect") {
    return AccountSchema.parse(await connectGet<unknown>(session, PATHS.balance(accountId)));
  }

  // browser mode: no dedicated balance endpoint — derive it from the accounts list.
  const account = (await getAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return account;
}

export async function getTransactions(
  accountId: string,
  range: DateRange,
): Promise<Transaction[]> {
  const session = await requireSession();

  if (session.method === "connect") {
    // Walk pages until a short/empty page, or a re-served page (proxy ignoring
    // the page param), whichever comes first.
    const { rows, truncated } = await collectDistinctPages<Transaction>(
      async (page) =>
        TransactionListSchema.parse(
          await connectGet<unknown>(session, PATHS.transactions, {
            accountId,
            from: range.from,
            to: range.to,
            page: String(page),
            pageSize: String(TX_PAGE_SIZE),
          }),
        ),
      txPageSignature,
      { pageSize: TX_PAGE_SIZE, startPage: 0 },
    );
    warnIfTruncated(truncated, accountId);
    return rows;
  }

  // browser mode: replay the discovered transactions endpoint. The portal's
  // paging contract is unknown, so append a best-effort page parameter and stop
  // as soon as a page's content repeats one already seen (safe even if the param
  // is ignored). Synthetic ids get a running offset so they stay unique.
  const endpoints = await loadEndpoints();
  if (!endpoints?.transactionsUrl) throw noEndpointError("transactions");
  const baseUrl = endpoints.transactionsUrl;
  let offset = 0;
  const { rows, truncated } = await collectDistinctPages<Transaction>(
    async (page) => {
      const pageRows = normalizeTransactions(
        await browserGetJson(withQueryParam(baseUrl, BROWSER_PAGE_PARAM, String(page))),
        accountId,
        offset,
      );
      offset += pageRows.length;
      return pageRows;
    },
    txPageSignature,
    { startPage: 1 },
  );
  warnIfTruncated(truncated, accountId);
  return rows.filter((t) => t.date >= range.from && t.date <= range.to);
}

export interface FinancialSummary {
  accounts: Account[];
  totalsByCurrency: Record<string, number>;
}

/**
 * Pure net-worth aggregation: credit cards and loans are debt, so their
 * balances are subtracted from the per-currency total. Kept separate from I/O
 * so it can be unit-tested directly.
 */
export function summarizeAccounts(accounts: Account[]): FinancialSummary {
  const totalsByCurrency: Record<string, number> = {};
  for (const acc of accounts) {
    const { currency, amount } = acc.balance;
    const signed =
      acc.type === "credit_card" || acc.type === "loan" ? -amount : amount;
    totalsByCurrency[currency] = (totalsByCurrency[currency] ?? 0) + signed;
  }
  return { accounts, totalsByCurrency };
}

/** Aggregate view handy for a "financial advisor" summary. */
export async function getFinancialSummary(): Promise<FinancialSummary> {
  return summarizeAccounts(await getAccounts());
}
