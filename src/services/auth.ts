/**
 * Authentication. Two flows are supported, mirroring how people actually access
 * their Bancolombia data:
 *
 *  - `browserLogin()` drives the personal-banking portal with Playwright. You
 *    type your own credentials into the real site; the resulting cookies are
 *    saved as a Playwright storage state so subsequent commands reuse the login.
 *    OTP / MFA is handled interactively.
 *
 *  - `connect()` performs a headless login against an API proxy that speaks a
 *    simple `POST /login { username, pin }` -> `{ token }` contract. Use this on
 *    servers / CI where no browser is available.
 *
 * IMPORTANT: credentials are never written to disk. Only the resulting session
 * (a cookie storage-state file, or a bearer token) is persisted, with 0600
 * permissions. This tool acts on your own account, with your own credentials.
 */

import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { config } from "../config.ts";
import { LOGIN_TIMEOUT_MS, DEFAULT_SCOPES } from "../constants.ts";
import { request } from "../http.ts";
import { saveSession } from "./session.ts";
import {
  attachCapture,
  inferEndpoints,
  saveDiscovery,
} from "./discovery.ts";
import type { Session } from "../schemas/index.ts";

function maskUser(user: string): string {
  if (user.length <= 4) return "*".repeat(user.length);
  return `${user.slice(0, 2)}${"*".repeat(user.length - 4)}${user.slice(-2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface BrowserLoginOptions {
  /**
   * Called after the browser opens. Resolve it (e.g. when the user presses
   * Enter) once they have logged in AND opened their accounts / movements so the
   * network capture has seen the real data endpoints.
   */
  waitForUser?: () => Promise<void>;
}

/**
 * Launch a browser, let the user authenticate on the REAL portal themselves,
 * capture the JSON endpoints their session calls, and persist the storage state
 * plus the discovered endpoints for reuse.
 *
 * The user types their own credentials + OTP in the visible window — we never
 * handle them and never rely on guessed form selectors. What we keep is the
 * resulting cookies and the endpoint URLs observed during the session.
 */
export async function browserLogin(
  opts: BrowserLoginOptions = {},
): Promise<Session & { discovered: number }> {
  // Login is inherently interactive: force a visible window regardless of the
  // headless default so the user can actually authenticate.
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(LOGIN_TIMEOUT_MS);

    const capture = attachCapture(page);
    await page.goto(config.portalUrl, { waitUntil: "domcontentloaded" });

    // Hand control to the user. They log in and browse to their products; we
    // just wait until they tell us they are done.
    if (opts.waitForUser) await opts.waitForUser();

    // Ensure the home dir exists: Playwright's storageState write does NOT
    // create missing parent directories, so on a fresh install this would
    // otherwise fail after the user has already authenticated.
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    await context.storageState({ path: config.storageStatePath });

    const endpoints = inferEndpoints(capture.captures);
    await saveDiscovery(capture.captures, endpoints);

    const session: Session = {
      method: "browser",
      user: "browser-session",
      hasStorageState: true,
      createdAt: nowIso(),
    };
    await saveSession(session);
    return { ...session, discovered: capture.captures.length };
  } finally {
    await browser.close();
  }
}

export interface ConnectResult {
  token: string;
  expiresAt?: string;
}

/**
 * Headless login through an API proxy. The proxy is expected to expose:
 *   POST {apiUrl}/login  { username, pin, scopes } -> { token, expiresAt? }
 */
export async function connect(
  username: string,
  pin: string,
  apiUrl?: string,
): Promise<Session> {
  const base = (apiUrl ?? config.apiUrl).replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "No API URL provided. Pass it as the third argument " +
        "(`bancolombia connect <user> <pin> <api-url>`) or set BANCOLOMBIA_API_URL.",
    );
  }

  const result = await request<ConnectResult>(`${base}/login`, {
    method: "POST",
    body: { username, pin, scopes: DEFAULT_SCOPES },
  });

  if (!result?.token) {
    throw new Error("Login failed: the API proxy did not return a token.");
  }

  const session: Session = {
    method: "connect",
    user: maskUser(username),
    token: result.token,
    apiUrl: base,
    hasStorageState: false,
    createdAt: nowIso(),
    expiresAt: result.expiresAt,
  };
  await saveSession(session);
  return session;
}
