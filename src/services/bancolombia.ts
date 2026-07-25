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

/** Perform a GET against the active session, regardless of provider. */
async function get<T>(
  session: Session,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";

  if (session.method === "connect") {
    const base = (session.apiUrl ?? "").replace(/\/$/, "");
    return httpRequest<T>(`${base}${path}${qs}`, { token: session.token });
  }

  // browser mode: reuse cookies via an authenticated Playwright request context.
  const { request: pwRequest } = await import("playwright");
  const ctx = await pwRequest.newContext({
    baseURL: config.portalUrl,
    storageState: config.storageStatePath,
  });
  try {
    const res = await ctx.get(`${path}${qs}`);
    if (!res.ok()) {
      throw new Error(
        `Portal request failed (${res.status()} ${res.statusText()}) for ${path}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

export async function getAccounts(): Promise<Account[]> {
  const session = await requireSession();
  const raw = await get<unknown>(session, PATHS.accounts);
  return AccountListSchema.parse(raw);
}

export async function getBalance(accountId: string): Promise<Account> {
  const session = await requireSession();
  const raw = await get<unknown>(session, PATHS.balance(accountId));
  return AccountSchema.parse(raw);
}

export async function getTransactions(
  accountId: string,
  range: DateRange,
): Promise<Transaction[]> {
  const session = await requireSession();
  const raw = await get<unknown>(session, PATHS.transactions, {
    accountId,
    from: range.from,
    to: range.to,
  });
  return TransactionListSchema.parse(raw);
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
