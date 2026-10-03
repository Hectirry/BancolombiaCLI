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
5. **The five main numbers are free.** The Súper Balota objective does not
   constrain them. They are filled from `pick` so that a hit is at least a
   sensible ticket, and the report says they are free.

When asked for "combinaciones para hoy", run
`bun src/index.ts baloto super -n 3 --typical --seed <n>` and report the
coverage probability (N/16), the balls, and the honest caveat in rule 4.
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

## Scoring discipline (all Baloto models)

Every live draw is scored against what the model said before it. Update the
dataset first, score, then change the model **only** if a walk-forward or
holdout improvement exists — "afinar cuando el error lo exige, y no tocar
cuando el examen sale limpio." Never refit on a single draw.
