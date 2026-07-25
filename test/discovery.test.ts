import { expect, test, describe } from "bun:test";
import {
  normalizeAccounts,
  normalizeTransactions,
  inferEndpoints,
  type Capture,
} from "../src/services/discovery.ts";

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
});
