/**
 * Persistence for the authenticated session. The session file holds only what
 * is needed to reuse an existing login (a bearer token for connect mode, or a
 * pointer to the Playwright storage state for browser mode). It is written with
 * `0600` permissions so other users on the machine cannot read it.
 */

import { mkdir, readFile, writeFile, rm, chmod, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { config } from "../config.ts";
import { SessionSchema, type Session } from "../schemas/index.ts";

async function ensureHome(): Promise<void> {
  await mkdir(config.home, { recursive: true, mode: 0o700 });
}

export async function saveSession(session: Session): Promise<void> {
  await ensureHome();
  const parsed = SessionSchema.parse(session);
  await writeFile(config.sessionPath, JSON.stringify(parsed, null, 2), {
    mode: 0o600,
  });
  await chmod(config.sessionPath, 0o600);
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await readFile(config.sessionPath, "utf8");
    return SessionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<Session> {
  const session = await loadSession();
  if (!session) {
    throw new Error(
      "Not logged in. Run `bancolombia login` (browser) or " +
        "`bancolombia connect <user> <pin> [api-url]` (headless) first.",
    );
  }
  return session;
}

export async function clearSession(): Promise<void> {
  await Promise.allSettled([
    rm(config.sessionPath, { force: true }),
    rm(config.storageStatePath, { force: true }),
  ]);
}

export async function hasStorageState(): Promise<boolean> {
  try {
    await access(config.storageStatePath, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}
