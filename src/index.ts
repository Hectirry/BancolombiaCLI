#!/usr/bin/env bun
/**
 * bancolombia-cli entry point.
 *
 * Usage:
 *   bancolombia login                              Interactive browser login
 *   bancolombia connect <user> <pin> [api-url]     Headless login via API proxy
 *   bancolombia accounts                           List accounts + net worth
 *   bancolombia balance [accountId]                Quick balance(s)
 *   bancolombia transactions <accountId> <from> <to>   Transaction history
 *   bancolombia whoami                             Show current session
 *   bancolombia logout                             Clear session
 *   bancolombia server [--port <n>]                Start local REST API
 *   bancolombia mcp                                Start the MCP server (stdio)
 */

import { Command } from "commander";
import { c } from "./ui/format.ts";

const program = new Command();

program
  .name("bancolombia")
  .description(
    "CLI + MCP server for your Bancolombia accounts. Log in once, then let " +
      "Claude act as a real-time financial advisor over your own data.",
  )
  .version("0.1.0");

program
  .command("login")
  .description("Interactive browser login on the Bancolombia portal")
  .action(async () => {
    const { loginCommand } = await import("./commands/login.ts");
    await loginCommand();
  });

program
  .command("connect")
  .description("Headless login via an API proxy")
  .argument("<username>", "Your Bancolombia username / document number")
  .argument("<pin>", "Your PIN / password")
  .argument("[api-url]", "Base URL of the API proxy")
  .action(async (username: string, pin: string, apiUrl?: string) => {
    const { connectCommand } = await import("./commands/connect.ts");
    await connectCommand(username, pin, apiUrl);
  });

program
  .command("accounts")
  .description("List all accounts with balances and net worth")
  .action(async () => {
    const { accountsCommand } = await import("./commands/accounts.ts");
    await accountsCommand();
  });

program
  .command("balance")
  .description("Show a quick balance for one or all accounts")
  .argument("[accountId]", "Account id (omit for all accounts)")
  .action(async (accountId?: string) => {
    const { balanceCommand } = await import("./commands/balance.ts");
    await balanceCommand(accountId);
  });

program
  .command("transactions")
  .description("List transactions for an account within a date range")
  .argument("<accountId>", "Account id")
  .argument("<from>", "Start date (YYYY-MM-DD)")
  .argument("<to>", "End date (YYYY-MM-DD)")
  .action(async (accountId: string, from: string, to: string) => {
    const { transactionsCommand } = await import("./commands/transactions.ts");
    await transactionsCommand(accountId, from, to);
  });

program
  .command("whoami")
  .description("Show details about the current session")
  .action(async () => {
    const { whoamiCommand } = await import("./commands/whoami.ts");
    await whoamiCommand();
  });

program
  .command("captures")
  .description("Show endpoints/data discovered during browser login")
  .action(async () => {
    const { capturesCommand } = await import("./commands/captures.ts");
    await capturesCommand();
  });

program
  .command("logout")
  .description("Clear the stored session and credentials")
  .action(async () => {
    const { logoutCommand } = await import("./commands/logout.ts");
    await logoutCommand();
  });

program
  .command("server")
  .description("Start the local REST API")
  .option("-p, --port <number>", "Port to listen on")
  .action(async (opts: { port?: string }) => {
    const { serverCommand } = await import("./commands/server.ts");
    serverCommand(opts.port ? Number.parseInt(opts.port, 10) : undefined);
  });

program
  .command("mcp")
  .description("Start the MCP server over stdio (for Claude Desktop)")
  .action(async () => {
    await import("./mcp/index.ts");
  });

async function run(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(c.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}

run();
