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

The package is published as **`@hectirry/bancolombia-cli`** (public), exposing a
single `bancolombia` binary.

```bash
# Global install (once published to npm)
bun add -g @hectirry/bancolombia-cli

# …or from source
git clone https://github.com/hectirry/bancolombiacli.git
cd bancolombiacli
bun install
bun link          # exposes the `bancolombia` command globally
```

Working from a clone without linking? Every command below also runs directly via
`bun run src/index.ts <command>` — for example `bun run src/index.ts accounts`.
Throughout this README, `bancolombia <command>` and `bun run src/index.ts
<command>` are interchangeable.

The `postinstall` step downloads the Chromium build Playwright needs for browser
login. If you only use headless `connect` mode, you can skip it.

## Authentication

Two ways to establish a session — both act on your own account:

| Mode | Command | When to use |
|------|---------|-------------|
| **Browser** | `bancolombia login` | Desktop / first login. Opens the **real** portal; you log in and open your accounts yourself. Cookies + the real data endpoints are captured for reuse. |
| **Headless** | `bancolombia connect <username> <pin> [api-url]` | Servers / CI against an API proxy that speaks the `connect` contract. Exchanges credentials for a bearer token. |

### How browser login learns the real endpoints

Bancolombia's internal portal API is undocumented and changes over time, so this
tool does **not** ship guessed URLs or form selectors. Instead, `bancolombia
login`:

1. Opens the real Sucursal Virtual Personas portal in a visible browser.
2. You log in with your own credentials + OTP and open your accounts / movements.
3. While you browse, the tool records the JSON API calls your session makes and
   saves the discovered endpoints to `~/.bancolombia/endpoints.json` (raw samples
   go to `captures.json` for debugging).
4. Later, `accounts` / `transactions` (and the MCP tools) replay those endpoints
   using your saved cookies, normalising the responses to a common shape.

Your credentials are typed only into the real site — the tool never sees or
stores them, only the resulting cookies and endpoint URLs.

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
bancolombia transactions <accountId> <from> <to>    Full transaction history (YYYY-MM-DD)
bancolombia whoami                                  Show the current session
bancolombia captures                                Show endpoints/data discovered at login
bancolombia logout                                  Clear the session
bancolombia server [--port 3200]                    Start the local REST API
bancolombia mcp                                     Start the MCP server (stdio)
bancolombia baloto <subcommand>                     Statistical study of Baloto
```

`transactions` fetches the **complete** history for the date range, not just the
first page — see [Transaction pagination](#transaction-pagination) below.

## Transaction pagination

`bancolombia transactions <accountId> <from> <to>` returns **every** page of
history for the range, not just the first. How it walks the pages depends on the
session mode:

- **Connect mode** — the proxy exposes an explicit page index, so the tool
  requests successive pages (`page` / `pageSize`, 100 records per page) until a
  page comes back short or empty.
- **Browser mode** — the real portal's paging contract is unknown, so the tool
  appends a best-effort page parameter to the discovered endpoint and stops as
  soon as a page yields no new transactions (deduplicated by id). This is safe
  even if the portal ignores paging entirely — a re-served first page simply adds
  nothing new and paging stops. The parameter name defaults to `page` and is
  configurable via `BANCOLOMBIA_TX_PAGE_PARAM`.

Both paths cap the number of pages fetched, so a misbehaving endpoint can never
hang the CLI.

## Session expiry

Sessions don't last forever, and the tool now fails with a clear, actionable
message instead of an opaque error when one lapses:

- **Connect mode** sessions record an `expiresAt`; once past it — or when the
  proxy rejects the saved token with `401` / `403` — commands raise
  *"Your Bancolombia session has expired … run `bancolombia connect` again"*.
- **Browser mode** sessions expire opaquely on the cookie side. Expiry is
  detected lazily: when the portal rejects the saved cookies (a `401` / `403`, or
  a redirect to the login page), the same actionable error is raised, pointing
  you at `bancolombia login`.

In both cases, re-run the matching login command to establish a fresh session.

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

## Baloto: can statistics improve your odds?

`bancolombia baloto` answers that question with the actual draw history rather
than folklore. The short version:

| Question | Answer |
|----------|--------|
| Can past results predict future ones? | **No.** Seven independent tests over 952 draws find nothing that distinguishes Baloto from a fair random machine. |
| Is there a hidden pattern in the shape of the results? | **No.** 19 structural properties — sum, spread, clustering, carry-over, parity, primes — compared against 200 000 simulated fair draws: not one deviates, before or after correcting for multiple comparisons. |
| Do hot / cold / "due" systems work? | **No.** Backtested over 852 draws, every system lands within 1.3 σ of a random ticket. |
| Is *anything* predictable? | **Yes — the players.** Numbers 1–31 appear on tickets ~1.36× as often as 32–43, and 7 is played 1.49× as often as an average number. |
| Does that help? | **A little.** Every category is pari-mutuel, so an unpopular combination is shared with fewer winners. It raises the return per ticket by roughly 3.5 percentage points — it does not make Baloto profitable. |

```bash
bancolombia baloto update --full --verify   # download + cross-check the history
bancolombia baloto stats                    # is the machine fair?
bancolombia baloto backtest                 # do the popular systems work?
bancolombia baloto profile                  # real draws vs a simulated fair machine
bancolombia baloto pca                      # principal components + what predicts sharing
bancolombia baloto bias                     # how do players choose numbers?
bancolombia baloto ev "3,7,12,17,23+7" -j 52800000000
bancolombia baloto pick -n 5                # combinations the crowd avoids
```

### Where the data comes from

Two independently operated public archives are scraped. `update --verify`
cross-checks one against the other: over 1 402 comparable draws they agree on
all but three, and each of those three is a defect in the *secondary* archive
(it repeats the Baloto Súper Balota on Revancha rows through parts of
2021–2024, and swaps the two games on one 2025 date). Only draws from
2018-01-03 onwards are kept — before that Baloto was a different game (six
balls from 1–45) and mixing the two would corrupt every statistic.

Two artefacts are removed automatically and disclosed in the output: a result
the archive repeats one day later (Baloto is drawn Monday, Wednesday and
Saturday, so two draws are never a day apart), and prize breakdowns whose
columns do not multiply out — `prize per winner × winners = total paid` is
checked on every row, which catches a 2021 page that renders one winner of
$37 521 175 as 37 million winners.

### Looking for a pattern, properly

`baloto profile` takes 19 structural properties of a result — the sum, how
spread out the numbers are, how many share a tens-block, how many carried over
from the previous draw, parity, primes, multiples of five, gaps — and compares
each against 200 000 draws from a machine that is fair by construction. Each
property is tested twice: once on its average, once on the shape of its whole
distribution.

That is 38 comparisons, and testing 38 things and reporting the best one is
precisely how lottery "systems" get invented, so Holm's correction is applied
across all of them. The result on the real data is that **nothing deviates** —
not even before the correction. The largest discrepancy in the whole table is
1.6 σ.

The same machinery feeds `pick --typical`, which keeps only combinations whose
shape a fair machine produces routinely. That changes no probability whatsoever
— it exists because a ticket reading `39 40 41 42 43` is hard to hand over, and
a naturally-shaped alternative costs less than a percentage point of return.

### Principal components, and the question they cannot answer

`baloto pca` exists partly to draw a line. PCA is unsupervised: it finds
directions of maximum variance and never sees an outcome, so it can never
identify "the variables that influence winning". What it *can* do is say
whether the draws contain latent structure at all — a hidden factor would carry
more variance than chance allows.

On the 952 × 43 matrix of which balls came out, the leading component carries
**3.30 %** of the variance against **3.39 %** for a simulated fair machine, with
a chance limit of 3.52 %. No component exceeds it. Note the comparison is
against simulated spectra rather than a flat line: in any finite sample the
first component is always the largest, which is exactly how a spurious "factor"
gets reported.

The supervised half of the same command asks a question that *does* have an
answer, because it has a real response variable: the share of winners who
matched three or more numbers. Regressed on the shape of the drawn combination
across 695 draws, it explains **35.7 %** of the variation in how crowded the
prizes are:

| Property of the drawn numbers | Effect | t | Meaning |
|---|---|---|---|
| how many are ≤ 31 | **+0.213** | 3.89 | more people share it |
| tens-blocks touched | **+0.219** | 4.63 | more people share it |
| sum | −0.386 | −7.14 | fewer people share it |
| spread | −0.224 | −5.61 | fewer people share it |
| how many are even | −0.140 | −4.63 | fewer people share it |
| biggest single-decade cluster | +0.019 | 0.45 | no effect once decades is controlled for |

That last row is a correction. An earlier specification omitted `decades` and
reported `biggest-cluster` at −0.105 (t = −3.14), which reads as "players avoid
clustered combinations". It does not survive: adding the number of tens-blocks
touched collapses it to +0.019 (t = 0.45). The real variable is how widely the
numbers are spread across the coupon, and `biggest-cluster` was proxying for it.
The qualitative reading survives — players spread their picks out, so spread-out
combinations are more crowded — but the coefficient that was quoted for it does
not.

Read the two halves together: nothing predicts *which* numbers come out;
several things predict *how many people already had them*.

### How the player-preference model works

Nobody publishes which combinations were bought, but the operator publishes
**how many tickets won each category**. That is enough. A random player's ticket
contains number *i* with probability π_i (Σπ = 5); treating the five slots as
independent makes the number of matches against a drawn combination a
Poisson-binomial, so the expected winners per category follow in closed form.
Fitting π to ~700 published breakdowns recovers the crowd's preferences, and the
unknown ticket volume drops out of the likelihood — so the estimate does not
depend on guessing how many tickets were sold.

Giving all 43 balls their own parameter *overfits*: it predicts unseen draws
worse than assuming no bias at all. The model therefore estimates a handful of
interpretable effects instead ("can this be a day of the month", "is it 7", a
smooth drift from low to high), and `baloto bias` re-runs the held-out check
every time so the claim is never taken on faith.

### What "improving your odds" can and cannot mean

Nothing changes your probability of winning: every combination is 1 in
15 401 568 for the jackpot and 1 in 14.4 for any prize. What a player controls
is *how many people share the prize when it lands*. At a $52 800 million
jackpot, a typical birthday ticket returns about 63.8 % of its price; a
combination the crowd avoids returns about 67.4 %. Both are losing bets — the
break-even jackpot is roughly $87 000 million.

## Configuration

All optional — see [`.env.example`](./.env.example). Notable variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BANCOLOMBIA_HOME` | `~/.bancolombia` | Where the session is stored |
| `BANCOLOMBIA_API_PORT` | `3200` | Local REST API port |
| `BANCOLOMBIA_PORTAL_URL` | Bancolombia portal | Site automated by browser login |
| `BANCOLOMBIA_API_URL` | — | Default headless proxy URL |
| `BANCOLOMBIA_HEADFUL` | `false` | Show the browser window during login |
| `BANCOLOMBIA_TX_PAGE_PARAM` | `page` | Query param appended when paging browser-mode transactions |

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
    discovery.ts    Capture + infer real endpoints; normalise responses
    bancolombia.ts  Data access: accounts, balances, transactions, summary
  api/app.ts        Hono REST API
  mcp/index.ts      MCP server (6 tools)
  baloto/
    rules.ts        Game format, prize categories, combinatorics, tax
    source.ts       Scrapers for the two public result archives
    dataset.ts      Local history: validation, de-duplication, checksums
    update.ts       Two-pass ingestion (draws, then prize breakdowns)
    random.ts       Seeded RNG for the Monte Carlo null distributions
    stats.ts        Fairness tests against simulated fair histories
    profile.ts      Structural comparison of real draws vs a fair machine
    pca.ts          Principal components + regression on prize crowding
    backtest.ts     Walk-forward scoring of hot/cold/due/birthday systems
    bias.ts         Player-preference model fitted to winner counts
    ev.ts           Pari-mutuel expected value, sharing and break-even
    pick.ts         Generator for combinations the crowd avoids
  commands/         One file per CLI command
  ui/format.ts      Terminal tables & money formatting
```

## Development

```bash
bun install
bun run typecheck          # tsc --noEmit
bun test                   # unit tests (endpoint discovery + normalisers)
bun run src/index.ts --help
bun run src/mcp/index.ts   # start the MCP server directly
```

### Try it without a real account

A mock API proxy under [`examples/mock-proxy.ts`](./examples/mock-proxy.ts)
implements the same contract as the headless `connect` flow and serves realistic
fake data, so you can exercise the whole CLI / REST / MCP pipeline end-to-end:

```bash
# Terminal 1 — start the mock backend on :4599
bun run examples/mock-proxy.ts

# Terminal 2 — connect to it (any username / PIN is accepted) and query
export BANCOLOMBIA_HOME=/tmp/bancolombia-demo      # keep it out of ~/.bancolombia
bun run src/index.ts connect 1234567890 0000 http://localhost:4599
bun run src/index.ts accounts
bun run src/index.ts transactions ahorros-01 2026-07-01 2026-07-31
```

The same session is used by the MCP tools, so pointing Claude Desktop at
`bun run src/mcp/index.ts` (with the same `BANCOLOMBIA_HOME`) lets you try the
`get_accounts` / `get_transactions` tools against the mock too.

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
