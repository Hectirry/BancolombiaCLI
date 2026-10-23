import { clearSession } from "../services/session.ts";
import { c } from "../ui/format.ts";

export async function logoutCommand(): Promise<void> {
  await clearSession();
  console.log(c.green("✓ Logged out. Session and stored state removed."));
}
