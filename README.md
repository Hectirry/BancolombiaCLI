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
| Is *anything* predictable? | **Yes — the players.** Numbers 1–31 appear on tickets ~1.28× as often as 32–43, and 7 is played 1.27× as often as an average number. |
| Does that help? | **A little.** Every category is pari-mutuel, so an unpopular combination is shared with fewer winners. It raises the return per ticket by roughly 3–5 percentage points — it does not make Baloto profitable. |

```bash
bancolombia baloto update --full --verify   # download + cross-check the history
bancolombia baloto stats                    # is the machine fair?
bancolombia baloto backtest                 # do the popular systems work?
bancolombia baloto profile                  # real draws vs a simulated fair machine
bancolombia baloto pca                      # principal components + what predicts sharing
bancolombia baloto physical                 # hunt for a biased ball, and measure the power to find one
bancolombia baloto chaos                    # twin-simulate the chamber; measure how fast prediction dies
bancolombia baloto bias                     # how do players choose numbers?
bancolombia baloto ev "3,7,12,17,23+7" -j 52800000000
bancolombia baloto realized                 # selection rule backtested in actually-paid pesos
bancolombia baloto pick -n 5                # combinations the crowd avoids
bancolombia baloto super -n 3 --typical     # maximise P(hit the Súper Balota), and nothing else
```

### Súper Balota: six rules tried, none of them work — and one that does not need to

`baloto super` answers a narrower question than the rest of the suite: forget
payout, just hit the Súper Balota. Six selection rules were run walk-forward
over 564 draws — highest posterior, lowest posterior, avoid the last three,
repeat the last three, a fixed 1-2-3, and the least played. Every one lands
inside the noise band around the theoretical rate, best at z = +1.54 with six
comparisons on the table.

| Rule | Hits | Rate | z |
| --- | --- | --- | --- |
| lowest posterior (cold) | 120/564 | 21.3 % | +1.54 |
| highest posterior (hot) | 114/564 | 20.2 % | +0.89 |
| repeat the last three | 100/564 | 17.7 % | −0.62 |
| avoid the last three | 93/564 | 16.5 % | −1.38 |
| fixed 1-2-3 | 92/564 | 16.3 % | −1.48 |
| least played by the crowd | 92/564 | 16.3 % | −1.48 |

Nothing predicts the ball. What *is* exact is the coverage arithmetic: N
**distinct** Súper Balotas are mutually exclusive events, so they hit with
probability N/16 — 6.25 %, 12.50 %, 18.75 % — with no assumption about the
machine at all. That is the whole lever, and it is a real tripling at three
tickets.

Since the objective cannot separate the sixteen, the order among them is free.
An earlier version ranked by posterior mean and put Súper Balota 7 first, the
most-played ball in the country. The tiebreak now goes to the least-played
instead: out of sample the hit rate is statistically identical (14.8 % vs
19.4 %, both within 2σ of 18.75 %) while the +Súper tiers pay 1.53× more per
winner, on 19 % fewer co-winners. The five main numbers are left to `pick`,
because the Súper-Balota objective does not constrain them.

### The backtest that found a 19 % error: prizes are funded net of VAT

With the official allocations in hand, the money side becomes checkable: each
tier's published pool divided by its allocation is that draw's gross revenue,
and dividing by the winner-implied ticket count yields the revenue **per
ticket**. Across 695 draws that number is $4.790–4.858 before mid-2025 and
$5.072 after — which is $5.700/1,19 and $6.000/1,19. The regulation's
"ingresos brutos" is the bet net of the 19 % VAT, and the model had been
overstating every pool by that factor. Two backtests confirm the correction:

| Metric | before | after |
|---|---|---|
| Median error predicting each tier's payout per winner (2 780 tier-draws) | 18.0 % | **5.7 %** |
| Expected jackpot falls across 695 draws (14 observed) | 11.8 | **14.1** |

The corrected economics move the headline figures modestly: an unpopular
ticket returns ~68 % (was ~69–71 %), the break-even jackpot is ~$83 000 M, and
the chance the rolling jackpot crosses break-even before falling drops to
~32 %.

### The official regulation, verified at the source

The game is governed by Coljuegos acuerdos published as PDFs on baloto.com
(`static.baloto.com/static/docs/acuerdo-*.pdf`). The constants in `rules.ts`
now carry the regulation's exact values rather than press figures:

- **Prize plan** (Acuerdo 03 de 2021, art. 2.5.1): 36,744 % / 2,395 % /
  0,480 % / 0,525 % / 0,455 % / 1,485 % / 1,186 % / 6,730 % of gross sales —
  summing to exactly the 50 % return the regulation guarantees. Category 8 is
  officially "match the second-set number" with at most one main match, paying
  back the bet VAT included.
- **The jackpot grows slower than its headline share.** Of the 36,744 %
  assigned to the first category, only 34,244 % reaches the pot while the
  cumulative fall probability is under 40 %, and **32 %** once it passes 40 %
  (the regulation prescribes the same PAcum product formula this repo uses).
  The difference feeds a prize-reserve fund capped at $8.000 millones. A long
  roll-over is in the 32 % regime almost throughout — the EV model and the
  when-will-it-fall simulation use the effective rate.
- **Prices** (Acuerdo 02 de 2025, 28 April 2025): the Baloto bet rose from
  $5.700 to $6.000 and Revancha from $2.100 to **$3.000**, VAT included; the
  same acuerdo approved the additional Monday draw whose lower sales the
  dataset independently detects (~125k tickets vs ~360k on Saturdays).
- **Minimum jackpot**: $4.000 millones (art. 2.5.1, parágrafo 6).

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

### A calibration failure worth reading about

The first version of the preference model assumed a ticket's five slots were
independent, which makes the match count a Poisson-binomial. Fitting it to the
winner counts looked fine — the likelihood improved, the holdout validated —
and it was badly wrong in a way no in-sample score exposed. Comparing predicted
against actual winners *tier by tier* across 695 draws:

| Category | actual / predicted, before | after |
|---|---|---|
| 5 + Súper Balota | **0.052** | 0.976 |
| 4 + Súper Balota | 0.262 | 0.989 |
| 3 aciertos | 0.649 | 1.010 |
| 2 + Súper Balota | 1.014 | 1.003 |
| 1 ó 0 + Súper Balota | 1.085 | 0.998 |

Perfectly monotone, and a nineteen-fold over-prediction at the top. Independent
slots allow a ticket to hold more or fewer than five numbers, which fattens the
tail of the match distribution — exactly where the high-match categories live.
The likelihood never noticed because the eighth category holds ~20 000 winners
against ~100 in the fourth, so the fit optimised the categories that carry the
count mass and let the tail drift by a factor of nineteen.

The fix is the exact distribution: matching k of the drawn balls has probability
e_k(w_drawn)·e_{5−k}(w_rest) / e_5(w_all). Every tier now lands within 10 % of
its observed count, and the jackpot tier — 14 winners across 695 draws — is
predicted at 14.

The lesson generalises past this repo: a model can validate out of sample on the
statistic it was fitted to and still be wrong by more than an order of magnitude
on the quantity you actually care about. Checking predicted against observed
*per category*, rather than in aggregate, is what caught it.

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

### Do the balls "vibrate"? — the one folk theory that has ever worked

Physical bias is not superstition: biased roulette wheels were profitably
exploited in the 19th century, and gravity-pick lottery machines have been found
off-balance often enough that operators now rotate certified ball sets and weigh
them. `baloto physical` takes the idea seriously in two steps.

**A bias that comes and goes.** Every other test here assumes a bias constant
across all 952 draws — which would dilute a six-month problem into invisibility.
The scan instead sweeps every window of 50, 100 and 200 draws, 107 887
window-and-ball combinations, and compares the *largest* deviation found
anywhere against the largest a fair machine produces under the same search. The
real history reaches 3.61 σ; a fair machine typically reaches 4.48 σ and clears
4.93 σ one time in twenty. The draws are calmer than chance.

The hottest stretch it finds is instructive: ball 9 came up **14 times in the 50
draws** between 2025-10-20 and 2026-02-11, against 5.8 expected — a 3.61 σ
smoking gun. In the 78 draws since, it came up 9 times against 9.1 expected
(−0.02 σ). And betting the hottest ball of the previous 50 draws, every draw for
902 draws, hits 11.42 % of the time against 11.63 % expected by chance.

**How big a bias could hide here.** A clean result is worth only as much as the
test's power, so the second half simulates genuinely heavy balls:

| Ball is heavier by | Chance of noticing |
|---|---|
| +5 % | 2 % |
| +10 % | 5 % |
| +20 % | 32 % |
| +30 % | 74 % |
| +50 % | 100 % |

And the bias that would matter: five balls would each have to run **9.4 %**
heavy just to bring a ticket to break-even. That sits at about a 5 % chance of
detection — so a profitable bias genuinely cannot be ruled out with 952 draws.
It equally cannot be *located*, and a bias you cannot attribute to specific
balls is one you cannot bet on. `baloto backtest` is the direct test of trying
anyway, and it comes back at −1.26 σ.

### Simulating the machine itself — the attack that beat roulette

The most physically serious proposal is also historically credible: the balls
obey Newtonian mechanics in a controlled chamber, so simulate it. Thorp and
Shannon's wearable computer beat roulette exactly this way in 1961, and the
Eudaemons made it pay in the late 1970s.

`baloto chaos` answers with a measurement instead of an appeal to randomness.
It runs two bit-identical, fully deterministic simulations of the chamber —
43 balls, gravity, an air jet, elastic collisions — differing by **one
nanometre** in a single ball's position, and watches them diverge:

| Time | Separation between the twins |
|---|---|
| 0.0 s | 10⁻⁹ m |
| 0.2 s | 5×10⁻⁶ m |
| 0.4 s | 0.34 m |
| 0.5 s+ | fully decorrelated |

The fitted Lyapunov exponent is **λ ≈ 54 per second**: the error doubles every
13 ms (robust across perturbation sizes 10⁻¹² to 10⁻⁶ and across seeds).
Foresight ends when the amplified error fills the chamber, t = ln(L/δ)/λ, which
makes precision almost worthless — it only buys time logarithmically:

| Initial state known to… | Prediction survives |
|---|---|
| a millimetre (naked eye) | 0.11 s |
| a micron (microscope) | 0.24 s |
| an atom's width | 0.41 s |
| **the Planck length (physical limit)** | **1.46 s** |

A real draw mixes the balls for tens of seconds. This is the quantitative
difference between roulette and a lottery machine: a roulette ball undergoes a
handful of chaotic bounces (foresight of seconds is achievable and was
achieved); a lottery ball undergoes ~21 collisions per second for the whole
mixing cycle. And beyond the initial conditions, the real chamber is not even
isolated — every ball takes ~10²³ air-molecule impacts per second, injecting
fresh uncertainty far above the Planck scale continuously. The machine is not
hard to simulate; it is an entropy generator, and the mixing time is the
design parameter that makes it one. This is *why* the draws pass every
statistical test in this repo.

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
independent would make the number of matches against a drawn combination a
Poisson-binomial — but a ticket holds *exactly* five numbers, and that
distinction turned out to matter enormously (see below). The exact distribution
under weighted sampling without replacement is a ratio of elementary symmetric
polynomials, and that is what the model uses.
Fitting π to ~700 published breakdowns recovers the crowd's preferences, and the
unknown ticket volume drops out of the likelihood — so the estimate does not
depend on guessing how many tickets were sold.

Giving all 43 balls their own parameter *overfits*: it predicts unseen draws
worse than assuming no bias at all. The model therefore estimates a handful of
interpretable effects instead ("can this be a day of the month", "is it 7", a
smooth drift from low to high), and `baloto bias` re-runs the held-out check
every time so the claim is never taken on faith.

### The selection rule, backtested in pesos that were actually paid

Every other check scores selection against a *model* of the crowd. `baloto
realized` removes the model from the scoring side: a rule is evaluated against
the numbers that really came out and the per-winner prizes really published.
The rule's aggressiveness γ is learned on the first 347 draws and validated on
348 the model never saw:

| Rule | Realised $/ticket (unseen half) |
|---|---|
| imitate the crowd (γ = −1) | $589 |
| uniform quick-pick (γ = 0) | $593 |
| lean hard against (γ = 8, learned) | **$630 (+6.9 %)** |

The value is monotone in γ on both halves, and the win rate stays flat
(6.6 % vs 7.0 %) — the odds never move; only the pesos per win do, which is
precisely the sharing mechanism's signature. The jackpot tier is excluded from
the metric: it has fallen 14 times in the whole history, so its realised value
is noise (including it flips the γ ranking between halves — noise showing
itself). The mechanism is measured where thousands of payouts exist, and it is
the same mechanism the EV model applies to the jackpot.

### What "improving your odds" can and cannot mean

Nothing changes your probability of winning: every combination is 1 in
15 401 568 for the jackpot and 1 in 14.4 for any prize. What a player controls
is *how many people share the prize when it lands*. At a $52 800 million
jackpot, a typical birthday ticket returns about 66.4 % of its price; a
combination the crowd avoids returns about 71.1 %. Both are losing bets — the
break-even jackpot is roughly $81 000 million.

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
    physical.ts     Time-localised bias scan and detection-power curve
    chaos.ts        Deterministic chamber simulation and Lyapunov measurement
    backtest.ts     Walk-forward scoring of hot/cold/due/birthday systems
    bias.ts         Player-preference model fitted to winner counts
    ev.ts           Pari-mutuel expected value, sharing and break-even
    pick.ts         Generator for combinations the crowd avoids
    realized.ts     Selection rule backtested against real draws and payouts
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
