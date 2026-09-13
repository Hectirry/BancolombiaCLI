import { getAccounts, getBalance } from "../services/bancolombia.ts";
import { formatMoney, c } from "../ui/format.ts";

export async function balanceCommand(accountId?: string): Promise<void> {
  if (accountId) {
    const account = await getBalance(accountId);
    console.log(`${c.bold(account.name)}: ${formatMoney(account.balance.amount, account.balance.currency)}`);
    return;
  }

  // No id given: show a quick balance for every account.
  const accounts = await getAccounts();
  for (const account of accounts) {
    console.log(
      `${account.number.padEnd(10)} ${c.dim(account.name.padEnd(24))} ${formatMoney(account.balance.amount, account.balance.currency)}`,
    );
  }
}
