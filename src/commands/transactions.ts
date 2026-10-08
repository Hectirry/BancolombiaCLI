import { getTransactions } from "../services/bancolombia.ts";
import { DateRangeSchema } from "../schemas/index.ts";
import { transactionsTable } from "../ui/format.ts";

export async function transactionsCommand(
  accountId: string,
  from: string,
  to: string,
): Promise<void> {
  const range = DateRangeSchema.parse({ from, to });
  const txns = await getTransactions(accountId, range);
  console.log(transactionsTable(txns));
}
