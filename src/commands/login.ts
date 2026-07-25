import { createInterface } from "node:readline/promises";
import { browserLogin } from "../services/auth.ts";
import { c } from "../ui/format.ts";

export async function loginCommand(): Promise<void> {
  console.log(
    c.cyan("Opening the Bancolombia portal. Log in with your own credentials."),
  );
  console.log(
    c.dim(
      "Complete any OTP / MFA in the browser, then return here and press Enter.",
    ),
  );

  const session = await browserLogin({
    waitForOtp: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(c.yellow("Press Enter once you are fully logged in… "));
      rl.close();
    },
  });

  console.log(c.green(`✓ Logged in (${session.method}). Session saved.`));
}
