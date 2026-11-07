/**
 * Terminal formatting helpers: money, simple tables and status lines. Kept
 * dependency-free (ANSI escape codes only) so the CLI stays lightweight.
 */

import type { Account, Transaction } from "../schemas/index.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: number, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s: string) => paint(1, s),
  dim: (s: string) => paint(2, s),
  green: (s: string) => paint(32, s),
  red: (s: string) => paint(31, s),
  cyan: (s: string) => paint(36, s),
  yellow: (s: string) => paint(33, s),
};

export function formatMoney(amount: number, currency = "COP"): string {
  const formatted = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "COP" ? 0 : 2,
  }).format(amount);
  return amount < 0 ? c.red(formatted) : c.green(formatted);
}

/** Render an array of rows as an aligned table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").replace(ANSI, "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const visibleLen = cell.replace(ANSI, "").length;
        return cell + " ".repeat(Math.max(0, widths[i]! - visibleLen));
      })
      .join("  ");
  const head = c.bold(line(headers));
  const sep = c.dim(widths.map((w) => "─".repeat(w)).join("  "));
  return [head, sep, ...rows.map(line)].join("\n");
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function accountsTable(accounts: Account[]): string {
  if (accounts.length === 0) return c.dim("No accounts found.");
  const rows = accounts.map((a) => [
    a.id,
    a.name,
    a.type,
    a.number,
    formatMoney(a.balance.amount, a.balance.currency),
  ]);
  return table(["ID", "NAME", "TYPE", "NUMBER", "BALANCE"], rows);
}

export function transactionsTable(txns: Transaction[]): string {
  if (txns.length === 0) return c.dim("No transactions in this period.");
  const rows = txns.map((t) => [
    t.date,
    t.description.slice(0, 40),
    formatMoney(t.amount.amount, t.amount.currency),
  ]);
  return table(["DATE", "DESCRIPTION", "AMOUNT"], rows);
}
