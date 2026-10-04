# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Bun + TypeScript. `bancolombia` CLI (`commander`) plus an MCP server. Run
tests with `bun test`; typecheck with `bunx tsc --noEmit`. The Baloto study
lives in `src/baloto/`, its commands in `src/commands/baloto.ts`, and the
dataset on disk at `~/.bancolombia/baloto-draws.json` (not committed).

## Baloto: the Súper Balota model has ONE objective

`baloto super` (`src/baloto/superball.ts`) exists to answer exactly one
question: **how to maximise the probability of matching the Súper Balota.**
Nothing else. This was decided by the owner of the repository, twice, after
two versions drifted. Do not drift it again.

Rules that follow from that objective, all of them measured:

1. **Payout is not a criterion.** Not prize size, not co-winners, not
   crowding, not return-to-player. If a change to `superball.ts` or to the
   `super` command is justified by "it pays more", it does not belong there.
   The payout-optimising tools are `pick`, `ev` and `realized`; keep them
   separate.
2. **The only lever on the objective is coverage.** N tickets carrying N
   *distinct* Súper Balotas hit with probability exactly N/16 — 6.25 %,
   12.5 %, 18.75 %, 25 % … 100 % at sixteen. This holds with no assumption
   about the machine. Never repeat a ball across tickets.
3. **No selection rule beats that.** A walk-forward tournament over 573 draws
   (`scoreSuperRules` over `standardSuperRules` + `algorithmSuperRules`) has
   tried highest posterior, lowest posterior, hot-last-100, most overdue,
   Markov successors, avoid the recent, repeat the recent, fixed 1-2-3,
   least-played, a logistic regression on lag features and a periodogram
   projection: every one lands inside the noise band around N/16 (best
   z = +1.56 with eleven comparisons).
   No ball is distinguishable from 1/16 once all sixteen intervals are read
   simultaneously (`SIMULTANEOUS_Z`). Any new rule must be entered in that
   tournament and clear its Bonferroni threshold before it changes a
   recommendation.
4. **The order among equally likely balls is the objective's own tiebreak:
   highest posterior mean first.** That is the Bayes action for a pure hit
   objective, and the report must say in the same breath that the gap is
   inside noise. `--tiebreak crowd` (least-played balls) is opt-in only,
   because it is a payout criterion — it never becomes the default.
5. **The five main numbers are free, and disjoint across tickets.** The
   Súper Balota objective does not constrain them. They are filled from
   `pick` with `maxOverlap: 0`: two tickets can only both reach three matches
   if they share numbers, so sharing none makes those events exclusive and
   "win anything" reaches its exact maximum (20.58 % with 3 tickets, against
   20.49 % at overlap 2 and 19.36 % for three copies —
   `winAnythingProbability`). That is a hit criterion, not a payout one. The
   report says the main numbers are free.

When asked for "combinaciones para hoy", run
`bun src/index.ts baloto super -n 3 --typical --seed <n> --record` and report
the coverage probability (N/16), P(win anything) from the budget curve, the
balls, and the honest caveat in rule 4.
Do not present RTP, breakeven jackpot or co-winner figures alongside it
unless asked; the owner has said that reads as optimising payout again.

## Baloto: "have you tried machine learning?" — yes, it is measured

`baloto algorithms` (`src/baloto/algorithms.ts`) runs the predictors that
sound like statistics — Markov transitions, pairwise affinity, k-nearest
neighbours, the delta system, a per-ball logistic regression on lag features,
a periodogram projection and their ensemble — walk-forward through
`backtest()` against 5·5/43 = 0.581 matches per ticket, plus Fisher's g-test
for periodicity on every ball with a Bonferroni threshold. On 973 real draws
every algorithm sits inside ±1.7 z, the logistic coefficients are all within
±0.01 of zero, and no ball has a significant cycle. A new predictor goes in
`algorithmStrategies()` and is judged there before anything is said about it.

## Baloto: research registry — every mathematical area considered, and its verdict

Written 2026-10-04 after a deliberate survey of what else mathematics offers
for predicting a 5-of-43 + 1-of-16 draw. The point of this list is that the
next person with "but have you tried X?" finds X here with a verdict and a
number, or finds where X must be entered to get one. Status codes:
**TESTED** (run on the 974 real draws, result given), **ENTERED** (lives in a
standing tournament and is re-scored every run), **N/A** (the mathematics
itself says it cannot help, with the reason), **OPEN** (worth running, not yet
run — enter it through the tournament, never through the recommendation).

### The theorem that frames everything

Under exchangeability (de Finetti), the probability that a *fixed* ticket
matches k numbers is the same for every ticket, and no function of the past
changes the distribution of the next draw. Every technique below is therefore
a test of **non-exchangeability** — memory, drift, or physical asymmetry. If
none is found, the hit probability of any selection is a combinatorial
constant and only *coverage* (how many distinct outcomes the tickets span)
can move it. That is why rules 2 and 5 above are exact and everything else is
a tiebreak.

### Probability & statistics
| Area | What it would catch | Status |
| --- | --- | --- |
| Frequentist uniformity (χ², Monte Carlo p, without-replacement correction) | a loaded ball | TESTED `stats`: 7/7 compatible with fair; Súper χ²(15)=14.6, p=0.48 |
| Bayesian conjugate (Dirichlet posterior, simultaneous credible intervals) | a ball whose rate excludes 1/16 | TESTED `superball`: all 16 intervals cover 1/16 after `SIMULTANEOUS_Z` |
| Multiple-comparison control (Holm, Bonferroni) | false positives from scanning 43×19 features | TESTED `profile`: 38 comparisons, none survive |
| Walk-forward / holdout validation | overfitting of any rule | ENTERED: the discipline every tournament uses |
| Sequential analysis (Wald SPRT) | deciding "persist" without peeking | TESTED as a *plan*: H0 18.75 % vs H1 21 %, α=β=5 % needs ≈1 850 draws (~12 years at 156/yr) to decide. Live hypotheses will not resolve in a season; say so. |
| Extreme-value / scan statistics | a window where one ball ran hot | TESTED `physical`: max 3.61σ over 110 596 cells vs 5.11σ critical; Súper 10/14 at p=0.078 corrected |
| Power analysis | what size of bias the data could even see | TESTED: 80 % power only for a ball ≥2× (main) or ≥2.4× (Súper) likelier at W=200. "Clean" means "no bias ≥ +100 %", not "no bias". |
| Change-point detection (CUSUM / max-χ² over split points) | a ball set swapped mid-history | TESTED 2026-10-04: real max χ² 124 vs fair median 134, p=0.89 — no regime change |
| Self-exciting point process (Hawkes-like: P(ball\|seen in last w)) | the "persist" / hot-hand effect | TESTED 2026-10-04: ratio 1.12 (w=1), 1.04, 1.02, 1.01 (w=2,4,6) against 1.00; all inside the fair 95 % band (p 0.19–0.40) |
| Hidden Markov / regime models | latent machine states | TESTED 2026-10-04 `regime`: 2-state HMM log-lik −2687.6 vs i.i.d. −2693.3, but BIC 5602 vs 5490 — i.i.d. wins by 112 nats; the HMM predictive is ENTERED in the tournament (117/574, z=+1.00) |
| Dependence between Baloto and Revancha (same night) | shared machine quirks | TESTED 2026-10-04 `regime`: 16×16 permutation χ² = 239.6, p = 0.25; same Súper 47 vs 60.9 expected (p = 0.98) — independent |

### Information theory & algorithmic randomness
| Area | What it would catch | Status |
| --- | --- | --- |
| Compressibility (gzip as a Kolmogorov proxy) | any regularity a universal coder can exploit | TESTED 2026-10-04: Súper 529 bytes vs fair median 530 (P=0.38); main numbers 3 386 vs 3 380 — real is *less* compressible than 98.7 % of fair histories |
| Entropy rate / conditional entropy H(Xₜ\|Xₜ₋₁) | first-order memory | TESTED 2026-10-04: 3.806 bits vs fair median 3.809 (max 4.0), P=0.42 — no memory |
| NIST SP 800-22 battery (runs, longest run, serial, approximate entropy) | PRNG-style defects | OPEN but low value: the draw is mechanical, not algorithmic; `stats` already covers runs and serial correlation |
| Benford / digit laws | human-generated or tampered sequences | N/A: uniform discrete 1..43 does not follow Benford by construction; a "deviation" would be an artefact |

Two independent hints point the same way — the main numbers are slightly
*too* uniform (Pearson percentile 2.9 %, compressibility percentile 98.7 %).
That is a watch item, not a lever: over-uniformity cannot be bet on.

### Time series & signal processing
| Area | What it would catch | Status |
| --- | --- | --- |
| Periodogram + Fisher's g | a ball on a cycle | TESTED `algorithms`: no significant cycle at the Bonferroni threshold (sharpest ball 33, p=0.011 vs 0.0012) |
| Wavelets / time-localised spectra | a cycle that exists only for a while | OPEN: low prior; the windowed scan in `physical` already localises in time, and found nothing |
| ARIMA / state-space on counts | autocorrelated frequencies | N/A for i.i.d. categorical draws: autocorrelation of the indicator series is what `stats` and the entropy test measure, and it is nil |
| Recurrence plots / permutation entropy | deterministic structure in an apparently random series | OPEN: cheap to add beside the gzip test; expected null |

### Machine learning
| Area | What it would catch | Status |
| --- | --- | --- |
| Logistic regression on lag features | any linear-in-features memory | TESTED `algorithms`: coefficients all within ±0.01 of zero; z=−1.00 |
| k-NN, Markov transitions, pairwise affinity, delta system, ensemble | pattern recall | TESTED `algorithms`: all inside ±1.7 z over 673 draws |
| Gradient boosting / random forests / LSTM | non-linear memory | OPEN, low prior: the linear model found zero signal and the published comparisons of LSTMs against random picks show no difference (hit rate 0.7359 vs 0.7352 in one widely cited test). Enter via `algorithmStrategies()` if tried; expect noise. |
| Conformal prediction | honest uncertainty sets around any predictor | N/A as a *predictor*; useful only as a wrapper, and the exact sets here are already known (N/16, 7 221/962 598) |

### Combinatorics & design theory
| Area | What it would catch | Status |
| --- | --- | --- |
| Exact hypergeometric enumeration | the true odds of every event | TESTED `rules`: 15 401 568 tickets, 1-in-14 overall, 7 221/962 598 for ≥3 matches |
| Mutual exclusivity / disjoint tickets | the best P(win anything) for N tickets | TESTED and ADOPTED (rule 5): 20.58 % with 3 disjoint tickets, exact optimum |
| Minimal-overlap (linear) designs for N > 8 tickets | the best P(≥3 main) once disjoint tickets are impossible (5N > 43) | TESTED 2026-10-04 `coverage.ts`: exact enumeration of the 962 598 draws (`winAnythingExact`, `countWinningDraws`); two tickets sharing one number lose 36 draws, sharing two lose 351, so the best designs share ≤ 1 and \|∪Tᵢ\| = 7 221·N − 36·Σₓ C(dₓ,2) with balanced degrees (`linearBoundDraws`). Proven optimal for N ≤ 9 (N=9: 64 917/962 598); for 10 ≤ N ≤ 20 `optimiseCoverage` reaches that bound every time and 20 000-move exhaustive searches never beat it — "linear-optimal", global optimum conjectured. P(SB) = 1 from N = 16 with balanced distinct balls, so P(win anything) = 1 whatever the main numbers. |
| Covering designs / "lottery wheels" C(v,k,t) | a *guaranteed* t-match | N/A at any sane budget: the Schönheim bound for C(43,5,3) is ⌈43/5·⌈42/4·⌈41/3⌉⌉⌉ = **1 265 tickets** to guarantee one 3-match (the La Jolla repository stops at v ≤ 32). A 2-if-5 guarantee needs ≥95 tickets and 2 matches pay nothing without the Súper Balota. Wheels redistribute wins across tickets; they do not change expected matches. |
| Group testing / orthogonal arrays | structured coverage of the 16 Súper Balotas | N/A: with 16 outcomes and one ball per ticket the optimal design is trivial — distinct balls, N/16 |

### Physics & dynamics
| Area | What it would catch | Status |
| --- | --- | --- |
| Chaos / Lyapunov exponents | whether the chamber is predictable from initial conditions | TESTED `chaos`: λ≈54 s⁻¹, error doubles every 13 ms, prediction dead in <1.5 s even at Planck precision |
| Ball mass / dimension asymmetry | a light or heavy ball | TESTED indirectly via `physical`. Literature note: controlled experiments find a 1–5 % *lighter* ball biases a drum while a heavier one does not — so a real defect would show as one ball *over*-drawn, which is exactly what the windowed scan looks for and has not found |
| Weather / humidity / venue | environmental drift | OPEN and almost certainly N/A: no covariate is published per draw; a proxy (month) is already a `profile` feature and is flat |

### Decision theory & game theory
| Area | What it would catch | Status |
| --- | --- | --- |
| Bayes action under a pure hit loss | which ball to order first | ADOPTED (rule 4) and declared a tiebreak |
| Minority game / crowd avoidance | sharing fewer prizes | TESTED `bias`, `pick`, `realized` (+6.9 % realised, out of sample) — a **payout** tool, excluded from `super` by the owner |
| Kelly criterion / bankroll | how much to stake | N/A for a negative-expectation bet: Kelly fraction is ≤ 0 below the breakeven jackpot; this is budgeting, not prediction |
| Optimal stopping | *when* to play | TESTED `ev` / `forecast` (jackpot threshold, Mondays) — payout side, see `docs/ESTRATEGIA.md` |

### What this registry means operationally
1. Prediction of *which* numbers: eleven Súper rules, fourteen main-number
   strategies, and six information-theoretic tests say the same thing. The
   working hypothesis is exchangeability, and the burden of proof is on any
   new technique, in a tournament, at the Bonferroni threshold.
2. The only exact levers are coverage (rule 2) and disjointness (rule 5).
3. OPEN items are invitations, with the expected result stated in advance so
   that a "finding" has to beat a prediction, not a blank page.

## Scoring discipline (all Baloto models)

Every live draw is scored against what the model said before it. Update the
dataset first, score, then change the model **only** if a walk-forward or
holdout improvement exists — "afinar cuando el error lo exige, y no tocar
cuando el examen sale limpio." Never refit on a single draw.

The live half of that discipline is the **ledger** (`src/baloto/ledger.ts`,
`~/.bancolombia/baloto-ledger.json`): `baloto super --record` writes the
tickets against the next draw date *before* the draw; `baloto score` matches
every entry to the draw that followed and reports Súper Balota hits against
the exact expectation (Σ tickets/16) with a two-sided exact binomial p-value.
Record every recommendation handed to the owner. Never score from memory, and
never backfill an entry that was not stated before its draw. The ledger never
changes a model; the tournament does.
