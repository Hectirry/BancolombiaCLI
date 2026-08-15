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

const baloto = program
  .command("baloto")
  .description("Statistical study of Colombia's Baloto lottery")
  .action(async () => {
    const { summaryCommand } = await import("./commands/baloto.ts");
    await summaryCommand();
  });

baloto
  .command("update")
  .description("Download the draw history and per-draw prize breakdowns")
  .option("--full", "Re-download every year instead of only recent ones")
  .option("--no-prizes", "Skip the per-draw prize breakdown (far fewer requests)")
  .option("--verify", "Cross-check the results against a second public archive")
  .action(async (opts: { full?: boolean; prizes?: boolean; verify?: boolean }) => {
    const { updateCommand } = await import("./commands/baloto.ts");
    await updateCommand(opts);
  });

baloto
  .command("stats")
  .description("Test whether the draws deviate from a fair random machine")
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .option("-s, --sims <number>", "Monte Carlo simulations per test", "5000")
  .action(async (opts: { game?: string; sims?: string }) => {
    const { statsCommand } = await import("./commands/baloto.ts");
    await statsCommand(opts);
  });

baloto
  .command("backtest")
  .description("Score hot / cold / due / birthday systems against pure chance")
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .option("-w, --window <number>", "Draws each system looks back over", "100")
  .option("--warmup <number>", "Draws reserved before scoring starts", "100")
  .action(async (opts: { game?: string; window?: string; warmup?: string }) => {
    const { backtestCommand } = await import("./commands/baloto.ts");
    await backtestCommand(opts);
  });

baloto
  .command("profile")
  .description("Compare every structural property of the draws to a fair machine")
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .option("-s, --sims <number>", "Draws simulated from the fair machine", "200000")
  .action(async (opts: { game?: string; sims?: string }) => {
    const { profileCommand } = await import("./commands/baloto.ts");
    await profileCommand(opts);
  });

baloto
  .command("pca")
  .description("Principal components of the draws, and what actually predicts prize sharing")
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .option("--histories <number>", "Fair machines simulated for the null spectrum", "200")
  .action(async (opts: { game?: string; histories?: string }) => {
    const { pcaCommand } = await import("./commands/baloto.ts");
    await pcaCommand(opts);
  });

baloto
  .command("bias")
  .description("Estimate how players pick numbers, from published winner counts")
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .action(async (opts: { game?: string }) => {
    const { biasCommand } = await import("./commands/baloto.ts");
    await biasCommand(opts);
  });

baloto
  .command("ev")
  .description("Expected value of a ticket, including prize splitting and tax")
  .argument("[ticket]", 'Your numbers, e.g. "3,7,12,17,23+7"')
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .option("-j, --jackpot <cop>", "Advertised accumulated jackpot")
  .option("-t, --tickets <number>", "Tickets sold in the draw")
  .option("-p, --price <cop>", "Ticket price")
  .option("--tax", "Apply the 20% withholding on prizes above 48 UVT")
  .action(async (ticket: string | undefined, opts: Record<string, string | boolean>) => {
    const { evCommand } = await import("./commands/baloto.ts");
    await evCommand(ticket, opts as never);
  });

baloto
  .command("pick")
  .description("Generate combinations that few other players choose")
  .option("-g, --game <game>", "baloto or revancha", "baloto")
  .option("-n, --count <number>", "How many tickets to generate", "5")
  .option("-p, --pool <number>", "Choose among the N least-played combinations", "400")
  .option("-j, --jackpot <cop>", "Jackpot to value the tickets at")
  .option("--typical", "Only combinations shaped like a plausible real result")
  .option("--coverage <fraction>", "How strictly 'typical' is read: 0.5 = the interquartile range of real draws, 0.8 = looser", "0.8")
  .option("--seed <number>", "Seed, for reproducible tickets")
  .action(async (opts: Record<string, string>) => {
    const { pickCommand } = await import("./commands/baloto.ts");
    await pickCommand(opts as never);
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
