import { readFile } from "node:fs/promises";
import { config } from "../config.ts";
import { loadEndpoints, type Capture } from "../services/discovery.ts";
import { c } from "../ui/format.ts";

/**
 * Show what `bancolombia login` discovered from the real portal session: the
 * inferred accounts / transactions endpoints and a preview of the captured
 * responses. Useful for confirming the mapping worked before relying on it.
 */
export async function capturesCommand(): Promise<void> {
  const endpoints = await loadEndpoints();
  if (!endpoints) {
    console.log(
      c.yellow(
        "Nothing discovered yet. Run `bancolombia login`, open your accounts /\n" +
          "movements in the browser, then run this command again.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(c.bold("Discovered endpoints"));
  console.log(
    `  ${c.cyan("accounts:")}     ${endpoints.accountsUrl ?? c.red("not found")}`,
  );
  console.log(
    `  ${c.cyan("transactions:")} ${endpoints.transactionsUrl ?? c.red("not found")}`,
  );
  console.log(c.dim(`  discovered at ${endpoints.discoveredAt}`));

  let captures: Capture[] = [];
  try {
    captures = JSON.parse(await readFile(config.capturesPath, "utf8"));
  } catch {
    /* no captures file */
  }

  console.log("");
  console.log(c.bold(`Captured responses (${captures.length})`));
  for (const cap of captures) {
    const path = safePath(cap.url);
    console.log(`  ${c.green(String(cap.status))} ${cap.method} ${path}`);
    const preview = JSON.stringify(cap.sample).slice(0, 160);
    console.log(c.dim(`      ${preview}${preview.length >= 160 ? "…" : ""}`));
  }

  if (captures.length === 0) {
    console.log(
      c.dim("  (none — make sure you open your accounts before pressing Enter)"),
    );
  }
  console.log("");
  console.log(c.dim(`Raw data: ${config.capturesPath}`));
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
