/**
 * Zod schemas describing the shapes exchanged across the CLI, REST API and MCP
 * server. Using a single source of truth keeps the terminal output, HTTP
 * responses and MCP tool results consistent and validated.
 */

import { z } from "zod";

export const AccountTypeSchema = z.enum([
  "savings",
  "checking",
  "credit_card",
  "loan",
  "investment",
  "other",
]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const MoneySchema = z.object({
  amount: z.number(),
  currency: z.string().default("COP"),
});
export type Money = z.infer<typeof MoneySchema>;

export const AccountSchema = z.object({
  id: z.string(),
  /** Human-friendly name, e.g. "Ahorros a la mano". */
  name: z.string(),
  type: AccountTypeSchema,
  /** Masked account number, e.g. "****1234". */
  number: z.string(),
  balance: MoneySchema,
  /** Available balance when it differs from the ledger balance. */
  available: MoneySchema.optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  /** ISO-8601 date (YYYY-MM-DD) or full timestamp. */
  date: z.string(),
  description: z.string(),
  /** Positive for credits, negative for debits. */
  amount: MoneySchema,
  /** Running balance after the transaction, when the portal provides it. */
  balanceAfter: MoneySchema.optional(),
  category: z.string().optional(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const SessionSchema = z.object({
  /** How the session was established. */
  method: z.enum(["browser", "connect"]),
  /** Masked user identifier for display in `whoami`. */
  user: z.string(),
  /** Opaque bearer token for the headless proxy (connect mode). */
  token: z.string().optional(),
  /** Base URL of the headless proxy (connect mode). */
  apiUrl: z.string().optional(),
  /** Whether a Playwright storage state file exists (browser mode). */
  hasStorageState: z.boolean().default(false),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/** Date range used by transaction queries. `YYYY-MM-DD`. */
export const DateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
export type DateRange = z.infer<typeof DateRangeSchema>;
