import { createInterface } from "node:readline/promises";
import { browserLogin } from "../services/auth.ts";
import { c } from "../ui/format.ts";

export async function loginCommand(): Promise<void> {
  console.log(c.cyan("Opening the Bancolombia portal in a browser window."));
  console.log(
    c.dim(
      "1) Log in with your own credentials + OTP.\n" +
        "2) Open your accounts and a couple of movements so the tool can learn\n" +
        "   the real data endpoints from your session.\n" +
        "3) Come back here and press Enter.",
    ),
  );

  const session = await browserLogin({
    waitForUser: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(
        c.yellow("Press Enter once you are logged in and have opened your accounts… "),
      );
      rl.close();
    },
  });

  console.log(c.green(`✓ Logged in. Session saved.`));
  if (session.discovered > 0) {
    console.log(
      c.green(`✓ Discovered ${session.discovered} data endpoint(s) from your session.`),
    );
  } else {
    console.log(
      c.yellow(
        "⚠ No data endpoints were captured. Re-run `bancolombia login` and make\n" +
          "  sure you open your accounts / movements before pressing Enter.",
      ),
    );
  }
}
