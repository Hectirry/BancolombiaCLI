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
   projection, plus a two-state hidden-Markov predictive and the "persist"
   streak rule: every one lands inside the noise band around N/16 (574 draws,
   thirteen rules; best "cold" z = +1.54, worst "fixed 1-2-3" z = −1.67).
   Since 2026-10-06 the tournament also enters five **meta-rules**
   (`src/baloto/meta.ts`, nested walk-forward: each reads only the base
   rules' record on draws before the one it predicts): follow the leader,
   Bayesian average of rules (β = 0.5, 1), contrarian to the leader, and a
   recency ensemble. Eighteen rules, Bonferroni |z| > 2.99: follow the leader
   112/575 (z = +0.45), both averages +0.45/+0.23, contrarian −1.05, recency
   ensemble 129/575 (z = +2.26, the field's best, and exactly what a fair
   machine hands the best of fourteen rules in 24 % of histories — Monte
   Carlo, 200 fair tournaments, median best |z| 1.90). Nothing clears.
   No ball is distinguishable from 1/16 once all sixteen intervals are read
   simultaneously (Bonferroni over 16: Φ⁻¹(1 − 0.025/16) = 2.9552, computed by
   `bonferroniZ`; an earlier hard-coded 2.8945 was a 6 % family level and was
   caught in audit — exact Beta quantiles are used now, `numeric.ts`). Any new rule must be entered in that
   tournament and clear its Bonferroni threshold before it changes a
   recommendation.
4. **The order among equally likely balls is the objective's own tiebreak:
   highest posterior mean first.** That is the Bayes action for a pure hit
   objective, and the report must say in the same breath that the gap is
   inside noise. `--tiebreak crowd` (least-played balls) is opt-in only,
   because it is a payout criterion — it never becomes the default.
5. **The five main numbers are free, and chosen by structure only.** The
   Súper Balota objective does not constrain them and every quintet is
   exactly as likely as every other. They are filled by `optimiseCoverage`
   (`coverage.ts`): disjoint tickets up to eight — two tickets can only both
   reach three matches if they share numbers, so sharing none makes those
   events exclusive and "win anything" reaches its exact maximum (20.58 %
   with 3 tickets, against 20.49 % at overlap 2 and 19.36 % for three copies)
   — minimal-overlap designs beyond, seeded random within that. **No
   popularity, "typical shape" or payout criterion touches them.** An earlier
   version filled them from `pick` (least-played combinations); the owner
   ruled that out on 2026-10-07 — reducing co-winners is not the objective.
   The report says the main numbers are free.
6. **Revancha is coverage, the same kind as rule 2.** It is a complete second
   draw the same night (5 of 43 + 1 of 16, independent: `regime` p = 0.25) in
   which the ticket's numbers play again for $3.000 on top of $6.000. N
   tickets with distinct balls and Revancha hit the Súper Balota at least
   once with probability exactly 1 − (1 − N/16)² (`nightCoverage`, Monte
   Carlo-verified): 23.44 % for two tickets with Revancha against 18.75 % for
   three without, the same $18.000; "win anything" 25.72 % against 20.58 %.
   The per-peso edge is n(8 − n)/256, so Revancha buys more hit than extra
   tickets up to seven, ties at eight and loses beyond. This is a hit
   criterion with no assumption about either machine; the report shows both
   routes side by side and never mentions what a Revancha hit pays
   (`docs/ESTRATEGIA.md` rule 2 is the payout view, and stays separate).

When asked for "combinaciones para hoy", run
`bun src/index.ts baloto super -n 3 --seed <n> --record` and report
the coverage probability (N/16), P(win anything) from the budget curve, the
balls, and the honest caveat in rule 4. If the owner is spending a fixed
budget, say what the same pesos buy with Revancha (rule 6) and add
`--revancha` so the ledger scores both draws.
Do not present RTP, breakeven jackpot or co-winner figures alongside it
unless asked; the owner has said that reads as optimising payout again.

## Baloto: "have you tried machine learning?" — yes, it is measured

`baloto algorithms` (`src/baloto/algorithms.ts`) runs the predictors that
sound like statistics — Markov transitions, pairwise affinity, k-nearest
neighbours, the delta system, a per-ball logistic regression on lag features,
a periodogram projection and their ensemble — walk-forward through
`backtest()` against 5·5/43 = 0.581 matches per ticket, plus Fisher's g-test
for periodicity on every ball with a Bonferroni threshold. On 973 real draws
every algorithm sits inside ±1.7 z, every logistic coefficient (true MLE by
IRLS, with standard errors) is within one standard error of zero, and no ball
has a significant cycle (sharpest ball 33, Fisher p = 0.027 vs 0.0012). An
earlier claim of "coefficients within ±0.01" described an under-converged
optimiser with an over-strong ridge, not the data; the conclusion is the same. A new predictor goes in
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
| The leading rule's "cold" family (windows 50/100/200, recency-weighted, rank-sum ensemble, cold-and-absent), pre-registered | whether "cold" at z = +1.62 is signal or the max of 13 noises | TESTED 2026-10-06 `docs/PRERREGISTRO.md`: a uniform prior never changes the cold order (monotone in the count); the reported cell (n=3, warmup 400) is the max of a 16-cell grid; all excess sits in the middle third (z +2.40, outer thirds +0.03/+0.37); fair Monte Carlo of the rule itself gives P(z ≥ 1.62) = 0.058; cold played 11 triples, modal 6-9-15 (fixed z +1.20, rank 75/560), today's 1-4-8 ranks 535/560; six variants ENTERED (`coldFamilyRules`), all within ±1.05 against a 19-rule threshold of 3.01. Live hypothesis needs 1 767 nights. Verdict: noise. |

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
| Periodogram + Fisher's g | a ball on a cycle | TESTED `algorithms`: no significant cycle at the Bonferroni threshold (sharpest ball 33, exact Fisher p=0.027 vs 0.0012) |
| Wavelets / time-localised spectra | a cycle that exists only for a while | OPEN: low prior; the windowed scan in `physical` already localises in time, and found nothing |
| ARIMA / state-space on counts | autocorrelated frequencies | N/A for i.i.d. categorical draws: autocorrelation of the indicator series is what `stats` and the entropy test measure, and it is nil |
| Recurrence plots / permutation entropy | deterministic structure in an apparently random series | OPEN: cheap to add beside the gzip test; expected null |

### Machine learning
| Area | What it would catch | Status |
| --- | --- | --- |
| Logistic regression on lag features | any linear-in-features memory | TESTED `algorithms`: IRLS MLE, every coefficient within one standard error of zero (gap 0.09±0.16, f200 −0.03±0.09, last 0.05±0.05); main z=−1.00, Súper z=−1.35 |
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
| Revancha as a second independent draw | more draws per ticket instead of more tickets per draw | TESTED and ADOPTED (rule 6) 2026-10-04: 1 − (1 − N/16)² exact, Monte Carlo agrees within 1.7σ; two Revancha tickets 23.44 % vs three plain 18.75 % at $18.000; edge n(8 − n)/256, crossover at eight tickets |

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
| Meta-rules / online model selection (follow the leader, exponential-weights average, contrarian, recency ensemble) | a base rule whose *record* predicts its next hit | TESTED 2026-10-06 `meta.ts`, ENTERED in the `super` tournament: all five inside noise (best +2.26 vs 2.99 over 18 rules). On a fair machine every base rule hits each draw at n/16 regardless of its record, so a selector among them covers n distinct balls and hits at exactly n/16 too: it can only inherit skill, never create it. The leader on the real history (standard base) was "persist" 347 draws and "hot" 228, switching nine times — a random walk being chased. |

### What this registry means operationally
1. Prediction of *which* numbers: eighteen Súper rules (thirteen base, five
   meta), fourteen main-number strategies, and six information-theoretic
   tests say the same thing. The
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
tickets against the next draw date *before* the draw, with their cost and
whether they play Revancha; `baloto score` matches every entry to every draw
it played and reports Súper Balota hits against the exact expectation
(Σ over nights of N/16, or 1 − (1 − N/16)² with Revancha) with a two-sided
exact binomial p-value, pesos staked per hit against the model's own figure,
the current drought with its probability under the model, and the sample size
a verdict would need (`nightsToDistinguish`: 18.75 % vs 25 % takes 327
nights). Record every recommendation handed to the owner. Never score from
memory, and never backfill an entry that was not stated before its draw. The
ledger never changes a model; the tournament does.

When the owner asks "¿por qué no acertaste?", run `baloto postmortem`
(`src/baloto/postmortem.ts`, default `--draws 12`) instead of reasoning from
the last few results. It separates the model's own forecast (13/16 a night;
exact binomial tails for the hit count; exact (13/16)ⁿ for the drought) from
the counterfactual over every tournament rule, and prices the hindsight: the
probability that the *best* of the rules reaches the observed maximum on a
fair machine, by Monte Carlo over the maximum of correlated binomials (plays
held fixed, outcomes redrawn). On 2026-10-06, over the 12 draws since the
model went live: 2 hits against 2.25 expected (P(≤ 2) = 60 %), a 10-night
drought at 12.5 %, best rule in hindsight 5/12 while the best of 13 reaches
≥ 5 in 44 % of fair windows, no rule past |z| 2.89 on 575 draws. A window
never changes a recommendation; the full tournament column in the same table
is the only thing that can.
