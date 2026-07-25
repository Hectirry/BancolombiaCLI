import { expect, test, describe } from "bun:test";
import {
  normalizeAccounts,
  normalizeTransactions,
  inferEndpoints,
  toNumber,
  toIsoDate,
  guessType,
  foldText,
  type Capture,
} from "../src/services/discovery.ts";

describe("toNumber (Colombian COP parsing)", () => {
  test("passes through real numbers", () => {
    expect(toNumber(890000)).toBe(890000);
    expect(toNumber(-215400)).toBe(-215400);
    expect(toNumber(0)).toBe(0);
  });

  test("treats dots as thousands separators", () => {
    expect(toNumber("4.250.000")).toBe(4_250_000);
    expect(toNumber("1.234")).toBe(1_234);
    expect(toNumber("-215.400")).toBe(-215_400);
  });

  test("treats comma as the decimal separator", () => {
    expect(toNumber("1.234,50")).toBe(1_234.5);
    expect(toNumber("12,50")).toBe(12.5);
    expect(toNumber("1.234.567,89")).toBe(1_234_567.89);
  });

  test("strips currency symbols and whitespace", () => {
    expect(toNumber("$ 4.250.000")).toBe(4_250_000);
    expect(toNumber("COP 1.000")).toBe(1_000);
    expect(toNumber(" -1.500 ")).toBe(-1_500);
  });

  test("returns 0 for unparseable input", () => {
    expect(toNumber("abc")).toBe(0);
    expect(toNumber("")).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber({})).toBe(0);
  });
});

describe("foldText / guessType (diacritic-insensitive)", () => {
  test("folds accents and case", () => {
    expect(foldText("Crédito Hipotecario")).toBe("credito hipotecario");
    expect(foldText("Inversión")).toBe("inversion");
  });

  test("classifies accented Colombian product names", () => {
    expect(guessType("Ahorros a la Mano")).toBe("savings");
    expect(guessType("Cuenta Corriente")).toBe("checking");
    expect(guessType("Tarjeta de Crédito Visa")).toBe("credit_card");
    expect(guessType("Crédito Hipotecario")).toBe("loan");
    expect(guessType("Préstamo de Libre Inversión")).toBe("loan");
    expect(guessType("Crédito de Vivienda")).toBe("loan");
    expect(guessType("CDT a 360 días")).toBe("investment");
    expect(guessType("Inversión Fiduciaria")).toBe("investment");
    expect(guessType("Algo Raro")).toBe("other");
  });

  test("card tokens win over loan tokens for credit cards", () => {
    // Contains both "tarjeta" and "crédito"; must resolve to a card, not a loan.
    expect(guessType("Tarjeta de Crédito")).toBe("credit_card");
  });
});

describe("toIsoDate", () => {
  test("keeps ISO dates and truncates timestamps", () => {
    expect(toIsoDate("2026-07-03")).toBe("2026-07-03");
    expect(toIsoDate("2026-07-03T10:00:00")).toBe("2026-07-03");
    expect(toIsoDate("2026-07-03T10:00:00-05:00")).toBe("2026-07-03");
  });

  test("converts Colombian day-first dates to ISO", () => {
    expect(toIsoDate("03/07/2026")).toBe("2026-07-03");
    expect(toIsoDate("3/7/2026")).toBe("2026-07-03");
    expect(toIsoDate("03-07-2026")).toBe("2026-07-03");
    expect(toIsoDate("03/07/2026 14:30")).toBe("2026-07-03");
  });

  test("falls back safely for empty/unknown input", () => {
    expect(toIsoDate("")).toBe("1970-01-01");
    expect(toIsoDate(null)).toBe("1970-01-01");
    expect(toIsoDate(undefined)).toBe("1970-01-01");
  });
});

describe("normalizeAccounts", () => {
  test("maps Spanish-keyed, nested payloads and parses COP amounts", () => {
    const payload = {
      data: {
        productos: [
          {
            numeroProducto: "912345671234",
            nombre: "Ahorros a la Mano",
            saldoDisponible: "4.250.000",
          },
          {
            numeroProducto: "998877665678",
            descripcion: "Tarjeta de Credito Visa",
            saldo: 890000,
          },
        ],
      },
    };
    const accounts = normalizeAccounts(payload);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]!.balance.amount).toBe(4_250_000);
    expect(accounts[0]!.type).toBe("savings");
    expect(accounts[0]!.number).toBe("****1234");
    expect(accounts[1]!.type).toBe("credit_card");
  });

  test("skips records with no recognisable balance", () => {
    expect(normalizeAccounts([{ foo: "bar" }])).toHaveLength(0);
  });

  test("keeps a genuine zero balance but skips a null balance", () => {
    const accounts = normalizeAccounts([
      { nombre: "Cuenta Vacía", numeroProducto: "111122223333", saldo: 0 },
      { nombre: "Sin Saldo", numeroProducto: "444455556666", saldo: null },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.balance.amount).toBe(0);
    expect(accounts[0]!.name).toBe("Cuenta Vacía");
  });

  test("masks short account numbers without crashing", () => {
    const accounts = normalizeAccounts([
      { nombre: "Corta", numero: "12", saldo: 100 },
    ]);
    expect(accounts[0]!.number).toBe("****12");
  });
});

describe("normalizeTransactions", () => {
  test("parses amounts (incl. negatives) and dates", () => {
    const payload = [
      { referencia: "A1", fechaMovimiento: "2026-07-03T10:00:00", descripcion: "Nomina", valor: 3500000 },
      { referencia: "A2", fecha: "2026-07-10", nombre: "Exito", valor: "-215.400" },
    ];
    const txns = normalizeTransactions(payload, "ahorros-01");
    expect(txns).toHaveLength(2);
    expect(txns[0]!.amount.amount).toBe(3_500_000);
    expect(txns[0]!.date).toBe("2026-07-03");
    expect(txns[1]!.amount.amount).toBe(-215_400);
    expect(txns[1]!.accountId).toBe("ahorros-01");
  });

  test("normalises Colombian day-first dates to ISO", () => {
    const txns = normalizeTransactions(
      [{ referencia: "B1", fecha: "05/07/2026", descripcion: "Pago", valor: -50000 }],
      "acct",
    );
    expect(txns[0]!.date).toBe("2026-07-05");
  });

  test("skips records with no amount and falls back on id/description", () => {
    const txns = normalizeTransactions(
      [
        { fecha: "2026-07-01" }, // no amount -> skipped
        { fecha: "2026-07-02", valor: 1000 }, // no id/desc -> fallbacks
      ],
      "acct",
    );
    expect(txns).toHaveLength(1);
    expect(txns[0]!.id).toBe("tx-2");
    expect(txns[0]!.description).toBe("—");
  });
});

describe("inferEndpoints", () => {
  const cap = (url: string): Capture => ({ url, method: "GET", status: 200, sample: [] });

  test("does not confuse the portal hostname with a transactions path", () => {
    // Host contains 'transaccion' — matching must use the path only.
    const ep = inferEndpoints([
      cap("https://sucursalpersonas.transaccionesbancolombia.com/api/v1/productos/cuentas"),
      cap("https://sucursalpersonas.transaccionesbancolombia.com/api/v1/movimientos?x=1"),
    ]);
    expect(ep.accountsUrl).toContain("cuentas");
    expect(ep.transactionsUrl).toContain("movimientos");
    expect(ep.accountsUrl).not.toBe(ep.transactionsUrl);
  });

  test("returns undefined endpoints when nothing matches", () => {
    const ep = inferEndpoints([cap("https://sucursalpersonas.transaccionesbancolombia.com/assets/app.js")]);
    expect(ep.accountsUrl).toBeUndefined();
    expect(ep.transactionsUrl).toBeUndefined();
    expect(ep.discoveredAt).toBeTruthy();
  });

  test("matches transaction hints in the query string (extracto)", () => {
    const ep = inferEndpoints([
      cap("https://sucursalpersonas.transaccionesbancolombia.com/api/data?tipo=extracto"),
    ]);
    expect(ep.transactionsUrl).toContain("extracto");
  });

  test("does not claim the same URL as both accounts and transactions", () => {
    // A single URL matching both hint sets must not fill both slots.
    const ep = inferEndpoints([
      cap("https://sucursalpersonas.transaccionesbancolombia.com/api/cuenta/movimientos"),
    ]);
    expect(ep.transactionsUrl).toBeTruthy();
    expect(ep.accountsUrl).toBeUndefined();
  });
});
