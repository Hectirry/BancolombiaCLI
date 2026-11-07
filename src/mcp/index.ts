#!/usr/bin/env bun
/**
 * MCP server exposing your Bancolombia data to Claude Desktop (or any MCP
 * client) over stdio. This is the entry point referenced from
 * `claude_desktop_config.json`.
 *
 * Six tools are registered: login, logout, get_accounts, get_balance,
 * get_transactions and session_info. They reuse the session created by the CLI,
 * so Claude never sees your raw credentials.
 *
 * NOTE: everything written to stdout is JSON-RPC. All diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { connect } from "../services/auth.ts";
import { clearSession, loadSession } from "../services/session.ts";
import {
  getAccounts,
  getBalance,
  getTransactions,
  getFinancialSummary,
} from "../services/bancolombia.ts";
import { DateRangeSchema } from "../schemas/index.ts";

const server = new McpServer({
  name: "bancolombia",
  version: "0.1.0",
});

/** Wrap a handler so thrown errors become MCP tool errors, not crashes. */
function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>,
): void {
  const cb = async (args: unknown): Promise<CallToolResult> => {
    try {
      const result = await handler(args as z.objectOutputType<Shape, z.ZodTypeAny>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      };
    }
  };
  server.registerTool(
    name,
    { description, inputSchema: shape },
    cb as Parameters<typeof server.registerTool>[2],
  );
}

tool(
  "login",
  "Establish a headless session with the Bancolombia API proxy using a username, " +
    "PIN and API URL. For interactive browser login, run `bancolombia login` in a " +
    "terminal instead.",
  {
    username: z.string().describe("Your Bancolombia username / document number"),
    pin: z.string().describe("Your PIN / password"),
    apiUrl: z
      .string()
      .optional()
      .describe("Base URL of the API proxy (falls back to BANCOLOMBIA_API_URL)"),
  },
  async ({ username, pin, apiUrl }) => {
    const session = await connect(username, pin, apiUrl);
    return { ok: true, method: session.method, user: session.user };
  },
);

tool("logout", "Clear the stored session and credentials.", {}, async () => {
  await clearSession();
  return { ok: true };
});

tool(
  "session_info",
  "Return details about the current session (method, masked user, timestamps).",
  {},
  async () => {
    const session = await loadSession();
    if (!session) return { authenticated: false };
    return {
      authenticated: true,
      method: session.method,
      user: session.user,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt ?? null,
    };
  },
);

tool(
  "get_accounts",
  "List all accounts (savings, checking, credit cards, loans, investments) with " +
    "balances, plus a net total by currency. Use this to answer questions about " +
    "the user's overall financial position.",
  {},
  async () => getFinancialSummary(),
);

tool(
  "get_balance",
  "Get the current balance for a single account by its id.",
  { accountId: z.string().describe("Account id, as returned by get_accounts") },
  async ({ accountId }) => getBalance(accountId),
);

tool(
  "get_transactions",
  "List transactions for an account within a date range (inclusive). Dates are " +
    "YYYY-MM-DD. Positive amounts are credits, negative are debits.",
  {
    accountId: z.string().describe("Account id, as returned by get_accounts"),
    from: z.string().describe("Start date, YYYY-MM-DD"),
    to: z.string().describe("End date, YYYY-MM-DD"),
  },
  async ({ accountId, from, to }) => {
    const range = DateRangeSchema.parse({ from, to });
    return getTransactions(accountId, range);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[bancolombia] MCP server ready on stdio");
}

main().catch((err) => {
  console.error("[bancolombia] fatal:", err);
  process.exit(1);
});
