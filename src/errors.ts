/**
 * Typed errors shared across the data layer so callers (CLI, REST, MCP) can
 * react to well-known failure modes instead of matching on message strings.
 */

/**
 * Thrown when the stored session is no longer valid — either it has passed its
 * `expiresAt` (connect mode) or the portal rejected the saved cookies with a
 * 401 / redirect to login (browser mode). The message is actionable: it tells
 * the user exactly how to re-authenticate.
 */
export class SessionExpiredError extends Error {
  constructor(detail?: string) {
    super(
      "Your Bancolombia session has expired. Run `bancolombia login` again " +
        "(browser) or `bancolombia connect <user> <pin> [api-url]` (headless) " +
        "to re-authenticate." + (detail ? ` (${detail})` : ""),
    );
    this.name = "SessionExpiredError";
  }
}
