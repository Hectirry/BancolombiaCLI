import { expect, test, describe } from "bun:test";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionExpired } from "../src/services/session.ts";
import { SessionExpiredError } from "../src/errors.ts";
import type { Session } from "../src/schemas/index.ts";

const base: Session = {
  method: "connect",
  user: "12****90",
  hasStorageState: false,
  createdAt: "2026-07-01T00:00:00Z",
};

describe("isSessionExpired", () => {
  const now = new Date("2026-07-25T12:00:00Z");

  test("false when there is no expiry (browser sessions)", () => {
    expect(isSessionExpired({ ...base }, now)).toBe(false);
  });

  test("true when expiresAt is in the past", () => {
    expect(
      isSessionExpired({ ...base, expiresAt: "2026-07-20T00:00:00Z" }, now),
    ).toBe(true);
  });

  test("false when expiresAt is in the future", () => {
    expect(
      isSessionExpired({ ...base, expiresAt: "2026-12-31T23:59:59Z" }, now),
    ).toBe(false);
  });

  test("false for an unparseable expiresAt rather than throwing", () => {
    expect(isSessionExpired({ ...base, expiresAt: "not-a-date" }, now)).toBe(
      false,
    );
  });
});

describe("SessionExpiredError", () => {
  test("carries an actionable, re-login message", () => {
    const err = new SessionExpiredError("proxy returned 401");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionExpiredError");
    expect(err.message).toContain("bancolombia login");
    expect(err.message).toContain("proxy returned 401");
  });
});

describe("clearSession", () => {
  // Runs in a subprocess so a temporary BANCOLOMBIA_HOME is honoured (config is
  // resolved once per process from the env).
  test("removes session, storage-state, endpoints AND captures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "banco-clear-"));
    for (const f of [
      "session.json",
      "storage-state.json",
      "endpoints.json",
      "captures.json",
    ]) {
      await writeFile(join(dir, f), "{}");
    }

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        "const {clearSession} = await import('./src/services/session.ts'); await clearSession();",
      ],
      env: { ...process.env, BANCOLOMBIA_HOME: dir },
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;

    expect(await readdir(dir)).toHaveLength(0);
  });
});
