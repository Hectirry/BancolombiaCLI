import { expect, test, describe } from "bun:test";
import {
  collectPages,
  collectUntilNoNew,
  withQueryParam,
} from "../src/services/pagination.ts";

describe("collectPages", () => {
  test("walks pages until a short final page", async () => {
    const pages = [
      [1, 2, 3],
      [4, 5, 6],
      [7], // short -> stop after this
    ];
    const seen: number[] = [];
    const out = await collectPages(
      async (p) => {
        seen.push(p);
        return pages[p] ?? [];
      },
      { pageSize: 3, startPage: 0 },
    );
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seen).toEqual([0, 1, 2]); // did not fetch a 4th page
  });

  test("stops immediately on an empty first page", async () => {
    let calls = 0;
    const out = await collectPages(
      async () => {
        calls++;
        return [];
      },
      { pageSize: 10 },
    );
    expect(out).toEqual([]);
    expect(calls).toBe(1);
  });

  test("respects maxPages as a safety cap", async () => {
    let calls = 0;
    const out = await collectPages(
      async () => {
        calls++;
        return [1, 2]; // always full -> would loop forever without the cap
      },
      { pageSize: 2, maxPages: 4 },
    );
    expect(calls).toBe(4);
    expect(out).toHaveLength(8);
  });
});

describe("collectUntilNoNew", () => {
  test("accumulates until a page adds no new keys", async () => {
    const pages = [
      [{ id: "a" }, { id: "b" }],
      [{ id: "c" }],
      [], // nothing new -> stop
    ];
    const out = await collectUntilNoNew(
      async (p) => pages[p - 1] ?? [],
      (r) => r.id,
      { startPage: 1 },
    );
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("stops when the endpoint ignores paging and re-serves page 1", async () => {
    let calls = 0;
    const firstPage = [{ id: "x" }, { id: "y" }];
    const out = await collectUntilNoNew(
      async () => {
        calls++;
        return firstPage; // same rows every time
      },
      (r) => r.id,
    );
    expect(out.map((r) => r.id)).toEqual(["x", "y"]);
    expect(calls).toBe(2); // page 1 (new) + page 2 (nothing new -> stop)
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
