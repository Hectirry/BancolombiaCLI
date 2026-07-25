/**
 * Endpoint discovery and response normalisation for browser mode.
 *
 * Bancolombia's internal portal API is undocumented and changes over time, so
 * instead of hardcoding guessed paths we LEARN them from the user's own
 * authenticated session: while the real portal is open and the user browses to
 * their accounts and movements, we record the JSON API calls the page makes.
 * The discovered endpoints are persisted and later replayed (with the saved
 * cookies) to fetch fresh data.
 *
 * Nothing here needs the user's credentials, and no data leaves the machine.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { config } from "../config.ts";
import { DISCOVERY_HINTS } from "../constants.ts";
import {
  AccountSchema,
  TransactionSchema,
  type Account,
  type Transaction,
  type AccountType,
} from "../schemas/index.ts";

export interface Capture {
  url: string;
  method: string;
  status: number;
  /** A small sample of the JSON body, for mapping/debugging. */
  sample: unknown;
}

export interface DiscoveredEndpoints {
  accountsUrl?: string;
  transactionsUrl?: string;
  discoveredAt: string;
}

const anyIncludes = (haystack: string, needles: readonly string[]): boolean => {
  const low = haystack.toLowerCase();
  return needles.some((n) => low.includes(n));
};

/**
 * Match hints against the URL path + query only, never the hostname — the
 * portal's own domain (transaccionesbancolombia.com) contains "transaccion",
 * which would otherwise make every URL look like a transactions endpoint.
 */
function urlMatches(url: string, needles: readonly string[]): boolean {
  try {
    const u = new URL(url);
    return anyIncludes(u.pathname + u.search, needles);
  } catch {
    return anyIncludes(url, needles);
  }
}

/** Pull the first array of objects out of an arbitrary JSON payload. */
function firstRecordArray(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body) && body.every((x) => x && typeof x === "object")) {
    return body as Record<string, unknown>[];
  }
  if (body && typeof body === "object") {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const found = firstRecordArray(value);
      if (found?.length) return found;
    }
  }
  return null;
}

function recordHasAnyKey(
  rec: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const lowered = Object.keys(rec).map((k) => k.toLowerCase());
  return keys.some((k) => lowered.includes(k.toLowerCase()));
}

/**
 * Attach network listeners to a page and collect JSON responses that look like
 * account or transaction data. Returns a getter for the captures collected so
 * far, so the caller can persist them after the interactive session ends.
 */
export function attachCapture(page: Page): { captures: Capture[] } {
  const captures: Capture[] = [];

  page.on("response", async (res) => {
    try {
      const req = res.request();
      const ct = (res.headers()["content-type"] ?? "").toLowerCase();
      if (!ct.includes("application/json")) return;

      const url = res.url();
      // Only same-origin API traffic under the portal, ignore assets/telemetry.
      if (!url.startsWith(new URL(config.portalUrl).origin)) return;

      const body = await res.json().catch(() => null);
      if (body == null) return;

      const records = firstRecordArray(body);
      const looksLikeData =
        urlMatches(url, DISCOVERY_HINTS.accountUrl) ||
        urlMatches(url, DISCOVERY_HINTS.transactionUrl) ||
        (records != null &&
          records.length > 0 &&
          (recordHasAnyKey(records[0]!, DISCOVERY_HINTS.balanceKeys) ||
            recordHasAnyKey(records[0]!, DISCOVERY_HINTS.amountKeys)));

      if (!looksLikeData) return;

      captures.push({
        url,
        method: req.method(),
        status: res.status(),
        sample: records ? records.slice(0, 3) : body,
      });
    } catch {
      /* best-effort: never let capture break the login flow */
    }
  });

  return { captures };
}

/** Infer which captured URLs are the accounts / transactions endpoints. */
export function inferEndpoints(captures: Capture[]): DiscoveredEndpoints {
  // Match transactions first (more specific); an accounts URL must not also be
  // claimed as the transactions URL.
  const transactions = captures.find((c) =>
    urlMatches(c.url, DISCOVERY_HINTS.transactionUrl),
  );
  const accounts = captures.find(
    (c) =>
      urlMatches(c.url, DISCOVERY_HINTS.accountUrl) &&
      c.url !== transactions?.url,
  );
  return {
    accountsUrl: accounts?.url,
    transactionsUrl: transactions?.url,
    discoveredAt: new Date().toISOString(),
  };
}

export async function saveDiscovery(
  captures: Capture[],
  endpoints: DiscoveredEndpoints,
): Promise<void> {
  await mkdir(config.home, { recursive: true, mode: 0o700 });
  await writeFile(config.capturesPath, JSON.stringify(captures, null, 2), {
    mode: 0o600,
  });
  await writeFile(config.endpointsPath, JSON.stringify(endpoints, null, 2), {
    mode: 0o600,
  });
}

export async function loadEndpoints(): Promise<DiscoveredEndpoints | null> {
  try {
    return JSON.parse(await readFile(config.endpointsPath, "utf8"));
  } catch {
    return null;
  }
}

// --- Heuristic normalisers -------------------------------------------------
// Map an unknown record onto our schema by trying known ES/EN field names.

function pick(rec: Record<string, unknown>, keys: readonly string[]): unknown {
  const entries = Object.entries(rec);
  for (const key of keys) {
    const hit = entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (hit) return hit[1];
  }
  return undefined;
}

/**
 * Parse an amount that may arrive as a number or a Colombian-formatted string,
 * where "." is the thousands separator and "," the decimal separator
 * (e.g. "4.250.000" -> 4250000, "1.234,50" -> 1234.5, "-215.400" -> -215400).
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;

  let s = value.trim().replace(/[^\d.,-]/g, "");
  const negative = s.startsWith("-");
  s = s.replace(/-/g, "");

  if (s.includes(",")) {
    // Comma present -> comma is the decimal separator, dots are thousands.
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    const parts = s.split(".");
    // Multiple dots, or a single dot with exactly 3 trailing digits, means the
    // dot(s) are thousands separators (COP has no cents in these responses).
    if (parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3)) {
      s = parts.join("");
    }
  }

  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

function guessType(name: string): AccountType {
  const n = name.toLowerCase();
  if (n.includes("ahorro") || n.includes("saving")) return "savings";
  if (n.includes("corriente") || n.includes("checking")) return "checking";
  if (n.includes("credito") || n.includes("tarjeta") || n.includes("card"))
    return "credit_card";
  if (n.includes("credito") || n.includes("loan") || n.includes("prestamo"))
    return "loan";
  if (n.includes("inversion") || n.includes("cdt") || n.includes("invest"))
    return "investment";
  return "other";
}

/**
 * Best-effort mapping of captured account records to Account[]. Records that
 * cannot be mapped are skipped rather than silently corrupting output; the raw
 * captures remain in captures.json for manual mapping.
 */
export function normalizeAccounts(raw: unknown): Account[] {
  const records = firstRecordArray(raw) ?? [];
  const out: Account[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const name = String(pick(rec, DISCOVERY_HINTS.nameKeys) ?? `Cuenta ${i + 1}`);
    const number = String(pick(rec, DISCOVERY_HINTS.numberKeys) ?? "");
    const balanceRaw = pick(rec, DISCOVERY_HINTS.balanceKeys);
    if (balanceRaw === undefined) continue; // not an account record
    const candidate = {
      id: number || String(pick(rec, ["id"]) ?? `acct-${i + 1}`),
      name,
      type: guessType(name),
      number: number ? `****${number.slice(-4)}` : "****",
      balance: { amount: toNumber(balanceRaw), currency: "COP" },
    };
    const parsed = AccountSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function normalizeTransactions(
  raw: unknown,
  accountId: string,
): Transaction[] {
  const records = firstRecordArray(raw) ?? [];
  const out: Transaction[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const amountRaw = pick(rec, DISCOVERY_HINTS.amountKeys);
    const dateRaw = pick(rec, DISCOVERY_HINTS.dateKeys);
    if (amountRaw === undefined) continue;
    const candidate = {
      id: String(pick(rec, ["id", "referencia", "reference"]) ?? `tx-${i + 1}`),
      accountId,
      date: String(dateRaw ?? "").slice(0, 10) || "1970-01-01",
      description: String(pick(rec, DISCOVERY_HINTS.nameKeys) ?? "—"),
      amount: { amount: toNumber(amountRaw), currency: "COP" },
    };
    const parsed = TransactionSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
