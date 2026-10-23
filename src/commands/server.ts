import { serve } from "bun";
import { app } from "../api/app.ts";
import { config } from "../config.ts";
import { c } from "../ui/format.ts";

export function serverCommand(port = config.apiPort): void {
  serve({ port, fetch: app.fetch });
  console.log(c.green(`✓ REST API listening on http://localhost:${port}`));
  console.log(c.dim("  GET /api/accounts | /api/transactions | /api/whoami"));
}
