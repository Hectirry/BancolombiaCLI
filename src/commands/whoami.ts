import { loadSession } from "../services/session.ts";
import { c } from "../ui/format.ts";

export async function whoamiCommand(): Promise<void> {
  const session = await loadSession();
  if (!session) {
    console.log(c.yellow("Not logged in. Run `bancolombia login` to start."));
    process.exitCode = 1;
    return;
  }
  console.log(`${c.bold("Method:")}    ${session.method}`);
  console.log(`${c.bold("User:")}      ${session.user}`);
  console.log(`${c.bold("Created:")}   ${session.createdAt}`);
  if (session.expiresAt) console.log(`${c.bold("Expires:")}   ${session.expiresAt}`);
  if (session.apiUrl) console.log(`${c.bold("API URL:")}   ${session.apiUrl}`);
}
