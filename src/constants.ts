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
/** Endpoints discovered from the real portal during an authenticated session. */
export const ENDPOINTS_FILE = "endpoints.json";
/** Raw JSON API responses captured during discovery (for mapping/debugging). */
export const CAPTURES_FILE = "captures.json";

/**
 * Heuristics used to recognise data endpoints in captured network traffic.
 * The real portal's internal API is undocumented; rather than hardcode guessed
 * paths, we watch the authenticated session and match on these signals.
 */
export const DISCOVERY_HINTS = {
  // URL fragments that suggest an accounts/products or movements endpoint.
  accountUrl: ["cuenta", "account", "producto", "product", "saldo", "balance"],
  transactionUrl: ["movimiento", "movim", "transaccion", "transaction", "extracto"],
  // Object keys that suggest a balance/account-like record (ES + EN).
  balanceKeys: ["saldo", "balance", "saldoDisponible", "availableBalance"],
  numberKeys: ["numero", "number", "cuenta", "account", "numeroProducto"],
  nameKeys: ["nombre", "name", "descripcion", "description", "alias", "producto"],
  amountKeys: ["valor", "amount", "monto", "importe"],
  dateKeys: ["fecha", "date", "fechaTransaccion", "fechaMovimiento"],
} as const;

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

/** How long (ms) to wait for interactive steps such as OTP entry. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Default OAuth-like scopes requested by the headless `connect` proxy. */
export const DEFAULT_SCOPES = ["accounts", "balances", "transactions"] as const;
