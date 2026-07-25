/**
 * Static configuration and well-known endpoints.
 *
 * The exact internal endpoints of Bancolombia's personal-banking site are not
 * publicly documented and may change. They are centralised here so there is a
 * single place to update selectors / URLs if the portal evolves. Anything that
 * a user may reasonably want to override is also exposed through environment
 * variables in `config.ts`.
 */

export const APP_NAME = "bancolombia-cli";

/** Default directory (under $HOME) where the session is persisted. */
export const DEFAULT_HOME_DIRNAME = ".bancolombia";

/** File names inside the home directory. */
export const SESSION_FILE = "session.json";
export const STORAGE_STATE_FILE = "storage-state.json";

/** Default port for the local REST API (`bancolombia server`). */
export const DEFAULT_API_PORT = 3200;

/** Public entry point of the personal-banking portal automated by the login. */
export const DEFAULT_PORTAL_URL =
  "https://sucursalpersonas.transaccionesbancolombia.com";

/**
 * Selectors used by the Playwright login flow. Kept together so they can be
 * adjusted without touching control flow. These are best-effort defaults.
 */
export const PORTAL_SELECTORS = {
  usernameInput: 'input[name="username"], input#username',
  passwordInput: 'input[type="password"], input[name="password"]',
  submitButton: 'button[type="submit"], input[type="submit"]',
  otpInput: 'input[name="otp"], input[autocomplete="one-time-code"]',
  // A selector that only appears once the user is authenticated.
  loggedInMarker: '[data-authenticated], .dashboard, #home',
} as const;

/** How long (ms) to wait for interactive steps such as OTP entry. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Default OAuth-like scopes requested by the headless `connect` proxy. */
export const DEFAULT_SCOPES = ["accounts", "balances", "transactions"] as const;
