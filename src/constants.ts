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

/**
 * Login page of Bancolombia's "Sucursal Virtual Personas" — the real personal
 * banking portal automated by `bancolombia login`.
 *
 * Alternative entry point: https://svpersonas.apps.bancolombia.com (redirects
 * here). Always confirm the domain in the address bar before entering
 * credentials. Override with BANCOLOMBIA_PORTAL_URL if the portal changes.
 */
export const DEFAULT_PORTAL_URL =
  "https://sucursalpersonas.transaccionesbancolombia.com/bancos/login/login";

/**
 * Selectors used by the Playwright login flow.
 *
 * ⚠️ UNVERIFIED against the live portal. These are generic best-effort guesses;
 * the real Sucursal Virtual Personas markup (input names, the post-login
 * marker) is not published and changes over time. Before the browser login can
 * drive the real site reliably, open the portal in a browser, inspect the login
 * form, and replace these values. They are isolated here for exactly that.
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
