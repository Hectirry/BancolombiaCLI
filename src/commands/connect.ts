import { connect } from "../services/auth.ts";
import { c } from "../ui/format.ts";

export async function connectCommand(
  username: string,
  pin: string,
  apiUrl?: string,
): Promise<void> {
  const session = await connect(username, pin, apiUrl);
  console.log(
    c.green(`✓ Connected as ${session.user} via ${session.apiUrl}. Session saved.`),
  );
}
