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

import { chromium } from "playwright";
import { config } from "../config.ts";
import {
  LOGIN_TIMEOUT_MS,
  PORTAL_SELECTORS,
  DEFAULT_SCOPES,
} from "../constants.ts";
import { request } from "../http.ts";
import { saveSession } from "./session.ts";
import type { Session } from "../schemas/index.ts";

function maskUser(user: string): string {
  if (user.length <= 4) return "*".repeat(user.length);
  return `${user.slice(0, 2)}${"*".repeat(user.length - 4)}${user.slice(-2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface BrowserLoginOptions {
  /** Prompt used to pause for interactive OTP entry. */
  waitForOtp?: () => Promise<void>;
}

/**
 * Launch a browser, let the user authenticate on the real portal, then persist
 * the storage state for reuse. Returns the saved session.
 */
export async function browserLogin(
  opts: BrowserLoginOptions = {},
): Promise<Session> {
  const browser = await chromium.launch({ headless: !config.headful });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(LOGIN_TIMEOUT_MS);

    await page.goto(config.portalUrl, { waitUntil: "domcontentloaded" });

    // Wait until the user has completed login (credentials + OTP). We detect a
    // post-login marker; if the portal layout changes, update PORTAL_SELECTORS.
    await page
      .waitForSelector(PORTAL_SELECTORS.loggedInMarker, {
        timeout: LOGIN_TIMEOUT_MS,
      })
      .catch(() => {
        /* Fall through: some layouts have no obvious marker. */
      });

    if (opts.waitForOtp) await opts.waitForOtp();

    await context.storageState({ path: config.storageStatePath });

    const session: Session = {
      method: "browser",
      user: "browser-session",
      hasStorageState: true,
      createdAt: nowIso(),
    };
    await saveSession(session);
    return session;
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
