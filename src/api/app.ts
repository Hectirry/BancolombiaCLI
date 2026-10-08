/**
 * Local REST API (Hono) started by `bancolombia server`. It exposes the same
 * data as the CLI over HTTP on http://localhost:<port>, which is convenient for
 * dashboards, scripts, or an alternative MCP transport. It reads the session
 * created by `login` / `connect`; it never handles raw credentials itself.
 */

import { Hono } from "hono";
import {
  getAccounts,
  getBalance,
  getTransactions,
} from "../services/bancolombia.ts";
import { loadSession } from "../services/session.ts";
import { DateRangeSchema } from "../schemas/index.ts";

export const app = new Hono();

app.get("/health", (ctx) => ctx.json({ ok: true }));

app.get("/api/whoami", async (ctx) => {
  const session = await loadSession();
  if (!session) return ctx.json({ authenticated: false }, 401);
  return ctx.json({
    authenticated: true,
    method: session.method,
    user: session.user,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt ?? null,
  });
});

app.get("/api/accounts", async (ctx) => {
  try {
    return ctx.json(await getAccounts());
  } catch (err) {
    return ctx.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/accounts/:id/balance", async (ctx) => {
  try {
    return ctx.json(await getBalance(ctx.req.param("id")));
  } catch (err) {
    return ctx.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/transactions", async (ctx) => {
  const accountId = ctx.req.query("accountId");
  if (!accountId) return ctx.json({ error: "accountId is required" }, 400);

  const parsed = DateRangeSchema.safeParse({
    from: ctx.req.query("from"),
    to: ctx.req.query("to"),
  });
  if (!parsed.success) {
    return ctx.json({ error: parsed.error.issues[0]?.message }, 400);
  }

  try {
    return ctx.json(await getTransactions(accountId, parsed.data));
  } catch (err) {
    return ctx.json({ error: (err as Error).message }, 500);
  }
});
