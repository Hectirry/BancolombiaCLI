# bancolombia-cli

A command-line tool **and** [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server for your Bancolombia accounts. Log in once, add the MCP server to
Claude Desktop, and Claude can read your accounts, balances and transactions in
real time — acting as a full financial advisor over **your own** banking data.

> ⚠️ **Personal use, your own account.** This tool automates access to your own
> Bancolombia account using your own credentials, the same way you would log in
> yourself. It never stores your password, and it sends your data only to the
> local Claude client you configure. Review Bancolombia's terms of service and
> use responsibly.

---

## The flow with Claude Desktop

1. **Install and log in**

   ```bash
   bun add -g @hectirry/bancolombia-cli   # or: git clone … && bun install && bun link
   bancolombia login                       # opens the portal; log in + OTP once
   ```

2. **Add the MCP server to Claude Desktop**

   Edit `claude_desktop_config.json` (see paths below) and add:

   ```json
   {
     "mcpServers": {
       "bancolombia": {
         "command": "bun",
         "args": ["run", "/absolute/path/to/bancolombia-cli/src/mcp/index.ts"]
       }
     }
   }
   ```

   Then restart Claude Desktop.

3. **Ask Claude about your money**

   Claude now has six tools (`login`, `logout`, `get_accounts`, `get_balance`,
   `get_transactions`, `session_info`) and queries your accounts live:

   > *"How much did I spend on food last month across all my accounts, and what's
   > my current net worth?"*

---

## Installation

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
# Global install
bun add -g @hectirry/bancolombia-cli

# …or from source
git clone https://github.com/hectirry/bancolombiacli.git
cd bancolombiacli
bun install
bun link          # exposes the `bancolombia` command globally
```

The `postinstall` step downloads the Chromium build Playwright needs for browser
login. If you only use headless `connect` mode, you can skip it.

## Authentication

Two ways to establish a session — both act on your own account:

| Mode | Command | When to use |
|------|---------|-------------|
| **Browser** | `bancolombia login` | Desktop / first login. Opens the real portal; you enter credentials and OTP yourself. Cookies are saved for reuse. |
| **Headless** | `bancolombia connect <username> <pin> [api-url]` | Servers / CI, or an API proxy. Exchanges credentials for a bearer token. |

Your session is stored under `~/.bancolombia/` with `0600` permissions.
**Credentials themselves are never written to disk** — only the resulting cookie
storage-state (browser mode) or bearer token (headless mode).

Run `bancolombia logout` to erase everything.

## CLI commands

```
bancolombia login                                   Interactive browser login
bancolombia connect <user> <pin> [api-url]          Headless login via API proxy
bancolombia accounts                                List accounts + net worth
bancolombia balance [accountId]                     Quick balance(s)
bancolombia transactions <accountId> <from> <to>    Transaction history (YYYY-MM-DD)
bancolombia whoami                                  Show the current session
bancolombia logout                                  Clear the session
bancolombia server [--port 3200]                    Start the local REST API
bancolombia mcp                                     Start the MCP server (stdio)
```

## REST API

`bancolombia server` starts a local [Hono](https://hono.dev) API on
`http://localhost:3200`:

| Method & path | Description |
|---------------|-------------|
| `GET /health` | Liveness check |
| `GET /api/whoami` | Session info |
| `GET /api/accounts` | Accounts with balances |
| `GET /api/accounts/:id/balance` | Balance for one account |
| `GET /api/transactions?accountId=…&from=…&to=…` | Transaction history |

## MCP server

The MCP server (`src/mcp/index.ts`, or `bancolombia mcp`) speaks JSON-RPC over
stdio and exposes:

| Tool | Description |
|------|-------------|
| `login` | Headless login (username / PIN / api-url) |
| `logout` | Clear the stored session |
| `session_info` | Current session details |
| `get_accounts` | All accounts + net total by currency |
| `get_balance` | Balance for a single account |
| `get_transactions` | Transactions in a date range |

### `claude_desktop_config.json` locations

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

## Configuration

All optional — see [`.env.example`](./.env.example). Notable variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BANCOLOMBIA_HOME` | `~/.bancolombia` | Where the session is stored |
| `BANCOLOMBIA_API_PORT` | `3200` | Local REST API port |
| `BANCOLOMBIA_PORTAL_URL` | Bancolombia portal | Site automated by browser login |
| `BANCOLOMBIA_API_URL` | — | Default headless proxy URL |
| `BANCOLOMBIA_HEADFUL` | `false` | Show the browser window during login |

## Architecture

```
src/
  index.ts          CLI entry (commander)
  constants.ts      Endpoints, selectors, defaults
  config.ts         Env-resolved runtime config
  http.ts           fetch wrapper (JSON, timeouts, typed errors)
  schemas/          Zod schemas (Account, Transaction, Session, …)
  services/
    session.ts      Load/save/clear session (0600)
    auth.ts         browserLogin() (Playwright) + connect() (headless)
    bancolombia.ts  Data access: accounts, balances, transactions, summary
  api/app.ts        Hono REST API
  mcp/index.ts      MCP server (6 tools)
  commands/         One file per CLI command
  ui/format.ts      Terminal tables & money formatting
```

## Development

```bash
bun install
bun run typecheck          # tsc --noEmit
bun run src/index.ts --help
bun run src/mcp/index.ts   # start the MCP server directly
```

## Security notes

- Credentials are entered by you (browser) or passed once to a proxy (headless)
  and are **never persisted**. Only session tokens / cookies are stored, locally,
  with restrictive permissions.
- The MCP server exposes data only over stdio to the client you configure; it
  opens no network ports of its own.
- Treat `~/.bancolombia/` like any other secret: a stored session grants access
  to your account until you `logout` or it expires.

## License

[MIT](./LICENSE)
