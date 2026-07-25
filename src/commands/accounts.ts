import { getFinancialSummary } from "../services/bancolombia.ts";
import { accountsTable, formatMoney, c } from "../ui/format.ts";

export async function accountsCommand(): Promise<void> {
  const { accounts, totalsByCurrency } = await getFinancialSummary();
  console.log(accountsTable(accounts));
  console.log();
  for (const [currency, total] of Object.entries(totalsByCurrency)) {
    console.log(`${c.bold(`Net (${currency}):`)} ${formatMoney(total, currency)}`);
  }
}
