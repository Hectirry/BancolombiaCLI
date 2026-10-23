#!/usr/bin/env bun
/**
 * A mock Bancolombia API proxy for local development and testing.
 *
 * It implements exactly the contract that `bancolombia connect` and the data
 * layer expect, returning realistic fake data. It lets you exercise the entire
 * CLI / REST / MCP flow WITHOUT a real account or credentials.
 *
 *   bun run examples/mock-proxy.ts                 # starts on :4599
 *   bancolombia connect 1234567890 0000 http://localhost:4599
 *   bancolombia accounts
 *
 * Any username / PIN is accepted — this is a stub, not a real backend.
 */

import { Hono } from "hono";
import { serve } from "bun";
import type { Account, Transaction } from "../src/schemas/index.ts";

const PORT = Number.parseInt(process.env.MOCK_PORT ?? "4599", 10);

const ACCOUNTS: Account[] = [
  {
    id: "ahorros-01",
    name: "Ahorros a la Mano",
    type: "savings",
    number: "****1234",
    balance: { amount: 4_250_000, currency: "COP" },
    available: { amount: 4_250_000, currency: "COP" },
  },
  {
    id: "corriente-01",
    name: "Cuenta Corriente",
    type: "checking",
    number: "****5678",
    balance: { amount: 1_120_500, currency: "COP" },
  },
  {
    id: "tc-visa-01",
    name: "Tarjeta de Crédito Visa",
    type: "credit_card",
    number: "****9012",
    balance: { amount: 890_000, currency: "COP" },
  },
];

const TRANSACTIONS: Record<string, Transaction[]> = {
  "ahorros-01": [
    {
      id: "t1",
      accountId: "ahorros-01",
      date: "2026-07-03",
      description: "Nómina julio",
      amount: { amount: 3_500_000, currency: "COP" },
      balanceAfter: { amount: 4_250_000, currency: "COP" },
      category: "income",
    },
    {
      id: "t2",
      accountId: "ahorros-01",
      date: "2026-07-10",
      description: "Éxito supermercado",
      amount: { amount: -215_400, currency: "COP" },
      category: "groceries",
    },
    {
      id: "t3",
      accountId: "ahorros-01",
      date: "2026-07-18",
      description: "Netflix",
      amount: { amount: -38_900, currency: "COP" },
      category: "subscriptions",
    },
    {
      id: "t4",
      accountId: "ahorros-01",
      date: "2026-07-20",
      description: "Transferencia PSE",
      amount: { amount: -120_000, currency: "COP" },
      category: "transfers",
    },
    {
      id: "t5",
      accountId: "ahorros-01",
      date: "2026-07-22",
      description: "Rappi",
      amount: { amount: -54_300, currency: "COP" },
      category: "delivery",
    },
  ],
};

const app = new Hono();

app.post("/login", async (ctx) => {
  const body = await ctx.req.json().catch(() => ({}));
  if (!body?.username || !body?.pin) {
    return ctx.json({ error: "username and pin are required" }, 400);
  }
  return ctx.json({
    token: "mock-token-" + body.username,
    expiresAt: "2026-12-31T23:59:59Z",
  });
});

function requireAuth(ctx: { req: { header: (n: string) => string | undefined } }) {
  const auth = ctx.req.header("authorization");
  return Boolean(auth?.startsWith("Bearer "));
}

app.get("/api/accounts", (ctx) => {
  if (!requireAuth(ctx)) return ctx.json({ error: "unauthorized" }, 401);
  return ctx.json(ACCOUNTS);
});

app.get("/api/accounts/:id/balance", (ctx) => {
  if (!requireAuth(ctx)) return ctx.json({ error: "unauthorized" }, 401);
  const account = ACCOUNTS.find((a) => a.id === ctx.req.param("id"));
  return account ? ctx.json(account) : ctx.json({ error: "not found" }, 404);
});

app.get("/api/transactions", (ctx) => {
  if (!requireAuth(ctx)) return ctx.json({ error: "unauthorized" }, 401);
  const accountId = ctx.req.query("accountId") ?? "";
  const from = ctx.req.query("from") ?? "0000-00-00";
  const to = ctx.req.query("to") ?? "9999-99-99";
  const matching = (TRANSACTIONS[accountId] ?? []).filter(
    (t) => t.date >= from && t.date <= to,
  );

  // Pagination: the client walks `page` (0-based) with a `pageSize`. Return the
  // requested slice so `collectPages` sees a short final page and stops.
  const pageSize = Number.parseInt(ctx.req.query("pageSize") ?? "100", 10);
  const page = Number.parseInt(ctx.req.query("page") ?? "0", 10);
  if (Number.isFinite(pageSize) && pageSize > 0) {
    const start = Math.max(0, page) * pageSize;
    return ctx.json(matching.slice(start, start + pageSize));
  }
  return ctx.json(matching);
});

serve({ port: PORT, fetch: app.fetch });
console.log(`[mock-proxy] listening on http://localhost:${PORT}`);
