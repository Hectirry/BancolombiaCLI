import { expect, test, describe } from "bun:test";
import { summarizeAccounts } from "../src/services/bancolombia.ts";
import type { Account } from "../src/schemas/index.ts";

const acct = (over: Partial<Account>): Account => ({
  id: "x",
  name: "x",
  type: "savings",
  number: "****0000",
  balance: { amount: 0, currency: "COP" },
  ...over,
});

describe("summarizeAccounts (net worth)", () => {
  test("subtracts credit cards and loans from the per-currency total", () => {
    const { totalsByCurrency } = summarizeAccounts([
      acct({ type: "savings", balance: { amount: 4_250_000, currency: "COP" } }),
      acct({ type: "checking", balance: { amount: 1_120_500, currency: "COP" } }),
      acct({ type: "credit_card", balance: { amount: 890_000, currency: "COP" } }),
      acct({ type: "loan", balance: { amount: 2_000_000, currency: "COP" } }),
    ]);
    // 4_250_000 + 1_120_500 - 890_000 - 2_000_000
    expect(totalsByCurrency.COP).toBe(2_480_500);
  });

  test("keeps currencies separate", () => {
    const { totalsByCurrency } = summarizeAccounts([
      acct({ balance: { amount: 100, currency: "COP" } }),
      acct({ balance: { amount: 50, currency: "USD" } }),
    ]);
    expect(totalsByCurrency).toEqual({ COP: 100, USD: 50 });
  });

  test("empty portfolio yields empty totals", () => {
    expect(summarizeAccounts([]).totalsByCurrency).toEqual({});
  });
});
