import { expect, test, describe } from "bun:test";
import {
  collectDistinctPages,
  withQueryParam,
  applyTransactionQuery,
} from "../src/services/pagination.ts";

const numSig = (rows: number[]): string => rows.join(",");

describe("collectDistinctPages", () => {
  test("walks pages until a short final page", async () => {
    const pages = [
      [1, 2, 3],
      [4, 5, 6],
      [7], // short -> stop after this
    ];
    const seen: number[] = [];
    const { rows, truncated } = await collectDistinctPages(
      async (p) => {
        seen.push(p);
        return pages[p] ?? [];
      },
      numSig,
      { pageSize: 3, startPage: 0 },
    );
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seen).toEqual([0, 1, 2]); // did not fetch a 4th page
    expect(truncated).toBe(false);
  });

  test("stops immediately on an empty first page", async () => {
    let calls = 0;
    const { rows } = await collectDistinctPages(
      async () => {
        calls++;
        return [];
      },
      numSig,
      { pageSize: 10 },
    );
    expect(rows).toEqual([]);
    expect(calls).toBe(1);
  });

  test("stops without duplication when the endpoint ignores paging", async () => {
    // MEDIUM regression: a proxy that re-serves a full page every call must not
    // loop maxPages times duplicating the data.
    let calls = 0;
    const { rows } = await collectDistinctPages(
      async () => {
        calls++;
        return [1, 2]; // same full page every time
      },
      numSig,
      { pageSize: 2 },
    );
    expect(rows).toEqual([1, 2]); // no duplication
    expect(calls).toBe(2); // page 0 (new) + page 1 (repeat -> stop)
  });

  test("keeps distinct pages whose records share synthetic ids", async () => {
    // HIGH regression: two genuinely different pages whose id-less records get
    // the same synthetic ids ("tx-1", "tx-2") must both be kept. The stop
    // decision is content-based, so it does not collapse them.
    const pages = [
      [{ id: "tx-1", c: "A" }, { id: "tx-2", c: "B" }],
      [{ id: "tx-1", c: "C" }, { id: "tx-2", c: "D" }],
      [],
    ];
    const { rows } = await collectDistinctPages(
      async (p) => pages[p] ?? [],
      (r) => r.map((x) => x.c).join(","),
      { pageSize: 2, startPage: 0 },
    );
    expect(rows.map((r) => r.c)).toEqual(["A", "B", "C", "D"]);
  });

  test("reports truncated and respects maxPages", async () => {
    let calls = 0;
    const { rows, truncated } = await collectDistinctPages(
      async (p) => {
        calls++;
        return [p * 10, p * 10 + 1]; // unique full page each time
      },
      numSig,
      { pageSize: 2, maxPages: 4 },
    );
    expect(calls).toBe(4);
    expect(rows).toHaveLength(8);
    expect(truncated).toBe(true);
  });

  test("works without a pageSize, relying on empty/repeat signals", async () => {
    const pages = [[1], [2], []];
    const { rows } = await collectDistinctPages(
      async (p) => pages[p] ?? [],
      numSig,
      { startPage: 0 },
    );
    expect(rows).toEqual([1, 2]);
  });
});

describe("withQueryParam", () => {
  test("adds a param to a bare URL", () => {
    expect(withQueryParam("https://x.co/api/tx", "page", "2")).toBe(
      "https://x.co/api/tx?page=2",
    );
  });

  test("replaces an existing param and preserves others", () => {
    const out = withQueryParam("https://x.co/api/tx?page=1&acc=5", "page", "3");
    expect(out).toContain("page=3");
    expect(out).toContain("acc=5");
    expect(out).not.toContain("page=1");
  });
});

describe("applyTransactionQuery", () => {
  const q = { accountId: "ACC-NEW", from: "2026-08-01", to: "2026-08-31" };

  test("overrides account and date params captured at login (ES names)", () => {
    const captured =
      "https://p.co/api/movimientos?numeroCuenta=OLD&fechaInicial=2026-07-01&fechaFinal=2026-07-31&x=keep";
    const u = new URL(applyTransactionQuery(captured, q));
    expect(u.searchParams.get("numeroCuenta")).toBe("ACC-NEW");
    expect(u.searchParams.get("fechaInicial")).toBe("2026-08-01");
    expect(u.searchParams.get("fechaFinal")).toBe("2026-08-31");
    expect(u.searchParams.get("x")).toBe("keep"); // unrelated params untouched
  });

  test("overrides EN-style params too", () => {
    const captured = "https://p.co/api/tx?account=OLD&from=2026-01-01&to=2026-01-31";
    const u = new URL(applyTransactionQuery(captured, q));
    expect(u.searchParams.get("account")).toBe("ACC-NEW");
    expect(u.searchParams.get("from")).toBe("2026-08-01");
    expect(u.searchParams.get("to")).toBe("2026-08-31");
  });

  test("leaves the URL unchanged when there are no recognisable params", () => {
    const captured = "https://p.co/api/movimientos?token=abc";
    expect(applyTransactionQuery(captured, q)).toBe(captured);
  });

  test("does not throw on an unparseable URL", () => {
    expect(applyTransactionQuery("not a url", q)).toBe("not a url");
  });
});
