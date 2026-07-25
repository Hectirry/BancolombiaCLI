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

import { request as httpRequest } from "../http.ts";
import { config } from "../config.ts";
import { requireSession } from "./session.ts";
import {
  loadEndpoints,
  normalizeAccounts,
  normalizeTransactions,
} from "./discovery.ts";
import {
  AccountSchema,
  TransactionSchema,
  type Account,
  type Transaction,
  type DateRange,
  type Session,
} from "../schemas/index.ts";
import { z } from "zod";

/** Logical API paths, resolved against the session's base URL / portal. */
const PATHS = {
  accounts: "/api/accounts",
  balance: (accountId: string) =>
    `/api/accounts/${encodeURIComponent(accountId)}/balance`,
  transactions: "/api/transactions",
} as const;

const AccountListSchema = z.array(AccountSchema);
const TransactionListSchema = z.array(TransactionSchema);

/** Fetch an absolute URL in browser mode, reusing the saved portal cookies. */
async function browserGetJson(url: string): Promise<unknown> {
  const { request: pwRequest } = await import("playwright");
  const ctx = await pwRequest.newContext({
    storageState: config.storageStatePath,
  });
  try {
    const res = await ctx.get(url);
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
  return httpRequest<T>(`${base}${path}${qs}`, { token: session.token });
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
    return TransactionListSchema.parse(
      await connectGet<unknown>(session, PATHS.transactions, {
        accountId,
        from: range.from,
        to: range.to,
      }),
    );
  }

  // browser mode: replay the discovered transactions endpoint, filter by range.
  const endpoints = await loadEndpoints();
  if (!endpoints?.transactionsUrl) throw noEndpointError("transactions");
  const all = normalizeTransactions(
    await browserGetJson(endpoints.transactionsUrl),
    accountId,
  );
  return all.filter((t) => t.date >= range.from && t.date <= range.to);
}

/** Aggregate view handy for a "financial advisor" summary. */
export async function getFinancialSummary(): Promise<{
  accounts: Account[];
  totalsByCurrency: Record<string, number>;
}> {
  const accounts = await getAccounts();
  const totalsByCurrency: Record<string, number> = {};
  for (const acc of accounts) {
    const { currency, amount } = acc.balance;
    // Credit cards / loans represent debt; subtract them from net worth.
    const signed =
      acc.type === "credit_card" || acc.type === "loan" ? -amount : amount;
    totalsByCurrency[currency] = (totalsByCurrency[currency] ?? 0) + signed;
  }
  return { accounts, totalsByCurrency };
}
