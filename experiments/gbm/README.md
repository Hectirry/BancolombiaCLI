# Gradient boosting and random forests on the Baloto history (via MLArena)

Archived evidence for the research-registry row "Gradient boosting / random
forests" in `CLAUDE.md`. **Not part of the CLI, not part of `bun test`, not a
tournament entry.** Nothing here changes a recommendation.

## Question

Does a non-linear learner on the same lag features the logistic regression in
`src/baloto/algorithms.ts` uses — gap since last seen, frequency over the last
10/50/200 draws, in-last-draw — pick Súper Balotas or main numbers better than
chance when it is scored the way every model in this project is scored:
walk-forward, past only?

## Answer: no

Walk-forward over draws 400–976 (577 draws, the same window `baloto super`
scores), one-vs-rest per ball, refit every 25 draws on past rows only, top-N
distinct balls played. 977 Baloto draws through 2026-10-10.

| Model | Súper (top 3; 108.19 expected) | z | Main (top-5 ticket; 335.47 matches expected) | z |
| --- | --- | --- | --- | --- |
| LightGBM, fixed hyper-parameters | 105 | −0.34 | 345 | +0.58 |
| Random forest, fixed | 104 | −0.45 | 319 | −1.01 |
| LightGBM re-tuned by MLArena/Optuna on past draws only | 101 | −0.77 | 355 | +1.19 (−0.46 at 10 trials) |

Thresholds: 3.11 for 27 Súper rules, 2.97 for 17 main strategies. Within-draw
AUC 0.474–0.498, all below 0.5; log loss worse than a constant 1/16 or 5/43 for
every model. Two independent checks reproduced everything: a future-perturbation
leak audit (`leak_audit.py`; predictions for draws ≤ c are bit-identical when the
future after c is replaced) with a brute-force rebuild of all 45 843 feature
rows, and an independent recount of every hit and z from the raw JSON.

## Why MLArena is not used beyond this archive

MLArena 0.6.0 (MIT, single maintainer) is a convenience layer over scikit-learn
and LightGBM. For this problem its distinctive parts are wrong or misleading:

- **Binary only** — `predict` returns `predict_proba[:, 1]`; 16 or 43 one-vs-rest
  models are needed and their scores do not sum to one.
- **`tune` cannot do walk-forward** — a shuffled 80/20 split plus shuffled
  K-fold, `cv` accepts only an int (a `TimeSeriesSplit` raises). Its own CV
  reported Súper AUC 0.517–0.527; honest walk-forward gave 0.475–0.480, and a
  simulated *fair* history tuned the same way scored 0.526. The headline is the
  best of 30–142 trials on noise.
- **`threshold_analysis`** optimises an F-beta cut-off on training predictions;
  playing N balls is a top-N decision, not a threshold.
- **Cook's-D-like influence** always flags the top 1 % of draws; dropping draws
  under exchangeability is data snooping.
- Heavy dependency tree (mlflow, shap, optuna; 103 packages, ~1 GB venv) and
  `pandas>=3` breaks three of its own tests — pin `pandas<3`.

## Reproduce

```sh
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
MPLBACKEND=Agg .venv/bin/python -I experiment.py            # ~7 min on 4 cores
.venv/bin/python -I leak_audit.py . super 30 613,900 --out leak-super.json
```

Seeds are fixed in `experiment.py` (`SEED_MODEL=0`, `TUNE_SEED=42`,
`TIE_SEED=20261011`, `NULL_SEED=7`). The dataset is read from
`~/.bancolombia/baloto-draws.json` (only `game == "baloto"`, sorted, the exact
echo row 2022-11-10 dropped). `experiment-results.json` and
`experiment-results-plays.csv` are the outputs of the archived run.

## If it is ever re-opened

Enter it properly: a script that writes per-date plays to a file, a TypeScript
adapter that refuses a file whose dataset hash or `drawn` values disagree with
the loaded draws, and the rule appended to the Súper tournament *after* the
meta-rules so they do not start following it. The below-random within-draw AUC
(z −1.99) was found after the fact and is one correlated finding across three
models; pre-register it in `docs/PRERREGISTRO.md` before playing "the model's
bottom 3".
