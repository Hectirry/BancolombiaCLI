#!/usr/bin/env python3
"""MLArena 0.6.0 on the Baloto history: an honest walk-forward experiment.

Question (CLAUDE.md, research registry, "Gradient boosting / random forests" = OPEN):
does a non-linear learner on lag features, run through MLArena's own pipeline and
tuner, pick Súper Balotas / main numbers better than chance when it is scored the
way every Baloto model in this project is scored -- walk-forward, past only?

Targets (one-vs-rest, stacked (draw t, ball b) rows, label = 1 if b is in draw t):
  super : 16 balls, base rate 1/16, play top-3 per draw  -> baseline 3/16 hit rate
  main  : 43 balls, base rate 5/43, play top-5 per draw  -> baseline 25/43 matches/ticket

Features for (t, b), computed ONLY from draws strictly before t:
  gap   : draws since b last appeared, capped at 60, divided by 60 (never seen -> 1)
  f10   : (count of b in draws t-10..t-1 / 10) / base_rate - 1
  f50   : same over 50 draws
  f200  : same over 200 draws
  last  : 1 if b was in draw t-1
Rows exist for t >= 200 so every window is full.

Models (all through mlarena.MLPipeline.fit / .predict):
  (a) lgbm   : LightGBM, hyper-parameters fixed in advance (not tuned on the data)
  (b) rf     : scikit-learn RandomForest, fixed in advance
  (c) tuned  : LightGBM whose hyper-parameters come from MLPipeline.tune (Optuna TPE,
               cv=5, cv_variance_penalty=0.1, tune_metric='auc'), called ONLY on rows
               of draws before the tune point, re-tuned every --tune-every draws.

Walk-forward: evaluate draws 400..976 (577 draws). Refit every 25 draws on rows of
draws [200, r); between refits predict with the last fit on features of the latest
history. Ties in predicted score are broken by a seeded random key (same keys for
every model) -- never by ball number.

Also reported: MLArena's own CV numbers (per-fold AUC / log-loss, mean, std,
penalised score, random 20% holdout) for (i) a naive tune on the full history,
(ii) every nested tune, (iii) a tune on a simulated FAIR history -- next to the
walk-forward numbers. The folds MLArena uses are reproduced exactly
(train_test_split + StratifiedKFold(shuffle=True), random_state=42) and checked
against tune's own reported mean.

Read-only on ~/.bancolombia/baloto-draws.json. Writes only next to this script.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import sys
import time
import warnings

os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import lightgbm as lgb
from scipy.stats import norm, rankdata
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import log_loss, roc_auc_score
from sklearn.model_selection import StratifiedKFold, train_test_split

import mlarena
from mlarena import MLPipeline

warnings.filterwarnings("ignore")  # mlarena.pipeline installs its own filters on import

# ----------------------------------------------------------------------------- seeds
SEED_MODEL = 0          # LightGBM random_state (bagging/feature sampling), RF random_state
TUNE_SEED = 42          # MLPipeline.tune random_state: 80/20 split, StratifiedKFold, TPE sampler
TIE_SEED = 20261011     # tie-breaking keys for top-k selection (identical for every model)
NULL_SEED = 7           # simulated fair history for the null tune
NUMPY_GLOBAL_SEED = 0   # np.random.seed (note: mlarena.threshold_analysis reseeds it to 42)

W0 = 200                # first draw index with full feature windows
EVAL_START = 400        # first walk-forward draw
REFIT_EVERY = 25
GAP_CAP = 60
FEATS = ["gap", "f10", "f50", "f200", "last"]
HERE = os.path.dirname(os.path.abspath(__file__))
EARLY_STOP = 50         # mlarena default; --early-stopping overrides

TARGETS = {
    "super": dict(K=16, p=1 / 16, play=3),
    "main": dict(K=43, p=5 / 43, play=5),
}


def log(msg: str) -> None:
    print(msg, flush=True)


# ----------------------------------------------------------------------------- data
def load_draws():
    path = os.path.expanduser("~/.bancolombia/baloto-draws.json")
    with open(path) as fh:
        raw = json.load(fh)["draws"]
    b = sorted([x for x in raw if x["game"] == "baloto"], key=lambda x: x["date"])
    echo = [x for x in b if x["date"] in ("2022-11-09", "2022-11-10")]
    assert len(echo) == 2 and echo[0]["main"] == echo[1]["main"] and echo[0]["super"] == echo[1]["super"]
    b = [x for x in b if x["date"] != "2022-11-10"]
    assert len(b) == 977 and b[-1]["date"] == "2026-10-10", (len(b), b[-1]["date"])
    dates = [x["date"] for x in b]
    assert len(set(dates)) == len(dates)
    T = len(b)
    Hs = np.zeros((T, 16), np.int8)
    Hm = np.zeros((T, 43), np.int8)
    for t, x in enumerate(b):
        assert 1 <= x["super"] <= 16 and len(set(x["main"])) == 5 and all(1 <= n <= 43 for n in x["main"])
        Hs[t, x["super"] - 1] = 1
        Hm[t, np.array(x["main"]) - 1] = 1
    return dates, Hs, Hm


def build_rows(H: np.ndarray, p: float) -> pd.DataFrame:
    """Long table of (draw, ball) rows for t >= W0; features use draws < t only."""
    T, K = H.shape
    C = np.vstack([np.zeros((1, K), np.int64), np.cumsum(H, axis=0, dtype=np.int64)])  # C[t] = sum H[:t]
    last_seen = np.full(K, -(10**9), dtype=np.int64)
    out = []
    for t in range(T):
        if t > 0:
            last_seen[H[t - 1] == 1] = t - 1
        if t < W0:
            continue
        gap = np.minimum(t - last_seen, GAP_CAP) / GAP_CAP
        f = {}
        for w in (10, 50, 200):
            cnt = C[t] - C[t - w]
            f[w] = (cnt / w) / p - 1.0
        last = H[t - 1].astype(float)
        out.append(
            np.column_stack(
                [np.full(K, t), np.arange(1, K + 1), gap, f[10], f[50], f[200], last, H[t].astype(int)]
            )
        )
    arr = np.vstack(out)
    df = pd.DataFrame(arr, columns=["draw", "ball"] + FEATS + ["hit"])
    df["draw"] = df["draw"].astype(int)
    df["ball"] = df["ball"].astype(int)
    df["hit"] = df["hit"].astype(int)
    return df.reset_index(drop=True)


def check_no_lookahead(H: np.ndarray, df: pd.DataFrame, p: float) -> None:
    """Recompute features for a few rows from H[:t] alone and compare."""
    rng = np.random.default_rng(1)
    for i in rng.choice(len(df), 50, replace=False):
        t, b = int(df.draw[i]), int(df.ball[i]) - 1
        past = H[:t, b]
        seen = np.nonzero(past)[0]
        gap = min(t - seen[-1], GAP_CAP) / GAP_CAP if len(seen) else 1.0
        exp = [gap] + [(past[-w:].sum() / w) / p - 1 for w in (10, 50, 200)] + [float(past[-1])]
        assert np.allclose(df.loc[i, FEATS].to_numpy(float), exp), (i, t, b)


# ----------------------------------------------------------------------------- models
def lgbm_fixed(nj):
    return lgb.LGBMClassifier(
        n_estimators=200, learning_rate=0.03, num_leaves=15, min_child_samples=50,
        subsample=0.8, subsample_freq=1, colsample_bytree=1.0, reg_lambda=1.0,
        random_state=SEED_MODEL, n_jobs=nj, verbose=-1, deterministic=True, force_row_wise=True,
    )


def rf_fixed(nj):
    return RandomForestClassifier(
        n_estimators=300, min_samples_leaf=50, max_features="sqrt", n_jobs=nj, random_state=SEED_MODEL,
    )


def param_ranges(nj):
    # tuple(int,int)->suggest_int, tuple(float,..)->suggest_float, list->suggest_categorical (mlarena rules)
    return {
        "n_estimators": (50, 400),
        "learning_rate": (0.01, 0.2),
        "num_leaves": (4, 31),
        "min_child_samples": (20, 300),
        "subsample": (0.5, 1.0),
        "subsample_freq": [1],
        "colsample_bytree": (0.4, 1.0),
        "reg_lambda": (0.0, 10.0),
        # singletons: pin seed / threads / determinism through the API itself.
        # verbose must go here: MLPipeline._supports_verbose(LGBMClassifier) is False under
        # lightgbm 4.7 (verbose is a **kwarg), so tune(verbose=-1) is silently not forwarded.
        "verbose": [-1],
        "random_state": [SEED_MODEL],
        "n_jobs": [nj],
        "deterministic": [True],
        "force_row_wise": [True],
    }


def fit_pipeline(model, rows: pd.DataFrame) -> MLPipeline:
    pipe = MLPipeline(model, None)
    pipe.fit(rows[FEATS], rows["hit"])
    return pipe


def run_tune(rows: pd.DataFrame, trials: int, nj: int, stdout_log: list) -> dict:
    """MLPipeline.tune exactly as shipped (shuffled 80/20 + shuffled StratifiedKFold)."""
    X = rows[FEATS].reset_index(drop=True)
    y = rows["hit"].to_numpy()
    buf = io.StringIO()
    t0 = time.time()
    with contextlib.redirect_stdout(buf):
        res = MLPipeline.tune(
            X, y, lgb.LGBMClassifier, None, param_ranges(nj),
            max_evals=trials, random_state=TUNE_SEED, early_stopping=EARLY_STOP, cv=5,
            cv_variance_penalty=0.1, visualize=False, tune_metric="auc",
            show_progress_bar=False, verbose=-1,
        )
    plt.close("all")
    stdout_log.append(buf.getvalue())
    study = res["study"]
    tr = [t for t in study.trials if t.value is not None]
    means = np.array([t.user_attrs["mean_auc"] for t in tr])
    pens = np.array([t.user_attrs["penalized_auc"] for t in tr])
    best = study.best_trial
    bp = dict(res["best_params"])
    out = dict(
        n_rows=len(X), n_draws=int(rows.draw.nunique()), trials=len(tr), seconds=round(time.time() - t0, 1),
        best_trial=best.number, best_params=bp,
        cv_auc_mean=float(res["cv_auc_mean"]), cv_auc_std=float(res["cv_auc_std"]),
        cv_auc_penalised=float(best.user_attrs["penalized_auc"]),
        trial_mean_auc_min=float(means.min()), trial_mean_auc_median=float(np.median(means)),
        trial_mean_auc_max=float(means.max()), trial_penalised_max=float(pens.max()),
        holdout_auc=float(res["test_auc"]), holdout_log_loss=float(res["test_log_loss"]),
        holdout_brier=float(res["test_brier_score"]), optimal_threshold=float(res["optimal_threshold"]),
        holdout_precision=float(res["test_precision"]), holdout_recall=float(res["test_recall"]),
    )
    return out


def reproduce_folds(rows: pd.DataFrame, best_params: dict, p: float) -> dict:
    """Re-create tune's exact split and folds; score the best params per fold with
    mlarena's own fit/evaluate; quantify how shuffled the folds are."""
    X = rows[FEATS].reset_index(drop=True)
    y = rows["hit"].to_numpy()
    draw = rows["draw"].to_numpy()
    idx = np.arange(len(X))
    tr_full, te = train_test_split(idx, test_size=0.2, random_state=TUNE_SEED)  # == tune's split
    Xf, yf, df_ = X.iloc[tr_full], y[tr_full], draw[tr_full]
    kf = StratifiedKFold(n_splits=5, shuffle=True, random_state=TUNE_SEED)    # == tune's folds
    folds = []
    for k, (a, v) in enumerate(kf.split(Xf, yf)):
        pipe = MLPipeline(lgb.LGBMClassifier(**best_params), None)
        pipe.fit(Xf.iloc[a], yf[a])
        r = pipe.evaluate(Xf.iloc[v], yf[v], verbose=False, visualize=False)
        dtr, dva = df_[a], df_[v]
        folds.append(dict(
            fold=k, auc=float(r["auc"]), log_loss=float(r["log_loss"]),
            log_loss_const=float(log_loss(yf[v], np.full(len(v), p))),
            n_val=int(len(v)),
            share_train_rows_after_first_val_draw=float(np.mean(dtr > dva.min())),
            share_val_draws_also_in_train=float(np.isin(np.unique(dva), dtr).mean()),
            val_draw_span=[int(dva.min()), int(dva.max())],
        ))
    aucs = np.array([f["auc"] for f in folds])
    hold_draws = draw[te]
    return dict(
        folds=folds, mean_auc=float(aucs.mean()), std_auc_pop=float(aucs.std()),
        penalised=float(aucs.mean() - 0.1 * aucs.std()),
        holdout_draw_span=[int(hold_draws.min()), int(hold_draws.max())],
        share_trainfull_rows_after_first_holdout_draw=float(np.mean(draw[tr_full] > hold_draws.min())),
    )


# ----------------------------------------------------------------------------- scoring
def select_topk(scores: np.ndarray, keys: np.ndarray, k: int):
    order = np.lexsort((keys, -scores))  # primary: score desc; ties: random key
    boundary_tie = bool(np.isclose(scores[order[k - 1]], scores[order[k]], rtol=0, atol=1e-15))
    return order[:k], order, boundary_tie


def score_target(df: pd.DataFrame, preds: np.ndarray, H: np.ndarray, spec: dict, name: str):
    K, k, p = spec["K"], spec["play"], spec["p"]
    ev = df[df.draw >= EVAL_START]
    draws = np.sort(ev.draw.unique())
    assert len(draws) == 577
    rng = np.random.default_rng(TIE_SEED)
    keys_all = rng.random((len(draws), K))  # same for every model
    hits, ties, ranks, mc_ll, wauc = [], 0, [], [], []
    plays = []
    P = preds.reshape(-1, K)  # rows are (draw, ball 1..K) in order
    D = df.draw.to_numpy().reshape(-1, K)[:, 0]
    pos = {d: i for i, d in enumerate(D)}
    for j, t in enumerate(draws):
        s = P[pos[t]]
        assert not np.isnan(s).any()
        top, order, tie = select_topk(s, keys_all[j], k)
        ties += tie
        drawn = np.nonzero(H[t])[0]
        rk = rankdata(s)  # average ranks for ties
        n1 = len(drawn)
        wauc.append((rk[drawn].sum() - n1 * (n1 + 1) / 2) / (n1 * (K - n1)))
        if name == "super":
            h = int(drawn[0] in top)
            ranks.append(int(np.nonzero(order == drawn[0])[0][0]) + 1)
            q = s / s.sum()
            mc_ll.append(-math.log(max(q[drawn[0]], 1e-15)))
        else:
            h = int(len(set(top) & set(drawn)))
        hits.append(h)
        plays.append(dict(draw=int(t), played=[int(x) + 1 for x in sorted(top)], drawn=[int(x) + 1 for x in drawn], hit=h))
    n = len(draws)
    H_ = float(np.sum(hits))
    if name == "super":
        base = k / K
        var = n * base * (1 - base)
        mean = n * base
    else:
        base = k * 5 / 43
        var1 = 5 * (5 / 43) * (38 / 43) * (38 / 42)
        mean, var = n * base, n * var1
    z = (H_ - mean) / math.sqrt(var)
    mask = df.draw.to_numpy() >= EVAL_START
    yv, pv = df.hit.to_numpy()[mask], preds[mask]
    res = dict(
        evaluated=n, hits=H_, rate=H_ / n, baseline=base, expected=mean, z=z,
        boundary_ties=int(ties),
        wf_auc=float(roc_auc_score(yv, pv)),
        wf_log_loss=float(log_loss(yv, np.clip(pv, 1e-15, 1 - 1e-15))),
        const_log_loss=float(log_loss(yv, np.full(len(yv), p))),
    )
    # within-draw AUC: ranking of the drawn ball(s) among the K balls of the same draw.
    # Exact null under exchangeability (no ties): mean 0.5, var = (K+1)/(12*n1*(K-n1)) per draw.
    n1 = 1 if name == "super" else 5
    sd_w = math.sqrt((K + 1) / (12 * n1 * (K - n1)) / n)
    res["within_draw_auc"] = float(np.mean(wauc))
    res["within_draw_auc_z"] = float((np.mean(wauc) - 0.5) / sd_w)
    if name == "super":
        res["mean_rank_of_drawn"] = float(np.mean(ranks))  # null 8.5, sd sqrt(255/12)/sqrt(n)
        res["mean_rank_z"] = float((np.mean(ranks) - 8.5) / (math.sqrt(255 / 12) / math.sqrt(n)))
        res["multiclass_log_loss"] = float(np.mean(mc_ll))  # null ln16 = 2.7726
    # thirds (time-stability, descriptive only)
    thirds = np.array_split(np.array(hits, float), 3)
    res["by_third"] = [float(x.sum()) for x in thirds]
    return res, plays


# ----------------------------------------------------------------------------- walk-forward
def walk_forward(df: pd.DataFrame, spec: dict, name: str, H, args, report: dict, stdout_log: list):
    T = int(df.draw.max()) + 1
    refits = list(range(EVAL_START, T, REFIT_EVERY))
    tune_points = list(range(EVAL_START, T, args.tune_every))
    preds = {m: np.full(len(df), np.nan) for m in ("lgbm", "rf", "tuned")}
    imp = {m: [] for m in ("lgbm", "rf", "tuned")}
    nested = []
    best_params = None
    last_pipes = {}
    for r in refits:
        t0 = time.time()
        train = df[df.draw < r]
        block_mask = (df.draw >= r) & (df.draw < r + REFIT_EVERY)
        block = df[block_mask]
        if r in tune_points:
            tinfo = run_tune(train, args.trials, args.n_jobs, stdout_log)
            tinfo["tune_point"] = r
            best_params = tinfo["best_params"]
            nested.append(tinfo)
        for m in ("lgbm", "rf", "tuned"):
            model = (lgbm_fixed(args.n_jobs) if m == "lgbm" else rf_fixed(args.n_jobs) if m == "rf"
                     else lgb.LGBMClassifier(**best_params))
            pipe = fit_pipeline(model, train)
            preds[m][block_mask.to_numpy()] = pipe.predict(None, block[FEATS])
            if m == "rf":
                fi = pipe.model.feature_importances_
            else:
                fi = pipe.model.booster_.feature_importance(importance_type="gain")
            imp[m].append(fi / fi.sum() if fi.sum() > 0 else fi)
            last_pipes[m] = pipe
        log(f"  [{name}] refit at draw {r}: train draws {W0}..{r-1} ({len(train)} rows), "
            f"predict {block.draw.min()}..{block.draw.max()}  ({time.time()-t0:.1f}s)")
    # score
    out = {}
    plays_all = {}
    for m in ("lgbm", "rf", "tuned"):
        out[m], plays_all[m] = score_target(df, preds[m], H, spec, name)
    # nested tunes: compare tune's own CV with walk-forward AUC / hits on the block it governed
    for i, tinfo in enumerate(nested):
        r = tinfo["tune_point"]
        r2 = nested[i + 1]["tune_point"] if i + 1 < len(nested) else T
        msk = ((df.draw >= r) & (df.draw < r2)).to_numpy()
        tinfo["governed_draws"] = [r, r2 - 1]
        tinfo["wf_auc_governed_block"] = float(roc_auc_score(df.hit.to_numpy()[msk], preds["tuned"][msk]))
        hb = [pl["hit"] for pl in plays_all["tuned"] if r <= pl["draw"] < r2]
        tinfo["wf_hits_governed_block"] = [int(np.sum(hb)), len(hb)]
    report["walk_forward"] = out
    report["nested_tunes"] = nested
    report["feature_importance_mean_over_refits"] = {
        m: dict(zip(FEATS, np.round(np.mean(imp[m], axis=0), 4).tolist())) for m in imp
    }
    report["feature_importance_last_refit"] = {
        m: dict(zip(FEATS, np.round(imp[m][-1], 4).tolist())) for m in imp
    }
    # univariate walk-forward AUC of each raw feature (model-free sanity check)
    ev = df[df.draw >= EVAL_START]
    report["univariate_wf_auc"] = {f: round(float(roc_auc_score(ev.hit, ev[f])), 4) for f in FEATS}
    # SHAP through mlarena's own explain_model on the final fixed LightGBM fit
    try:
        pipe = last_pipes["lgbm"]
        Xe = df[df.draw >= T - 100][FEATS]
        with contextlib.redirect_stdout(io.StringIO()):
            pipe.explain_model(Xe, plot_type="summary")
        plt.close("all")
        sv = pipe.shap_values.values
        if sv.ndim == 3:
            sv = sv[:, :, 1]
        ms = np.abs(sv).mean(axis=0)
        report["mean_abs_shap_last_lgbm_logodds"] = dict(zip(FEATS, np.round(ms, 4).tolist()))
    except Exception as e:  # noqa: BLE001
        report["mean_abs_shap_last_lgbm_logodds"] = f"failed: {type(e).__name__}: {e}"
    return plays_all


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", default="super,main")
    ap.add_argument("--trials", type=int, default=30, help="Optuna trials per tune (mlarena default 500)")
    ap.add_argument("--tune-every", type=int, default=100)
    ap.add_argument("--n-jobs", type=int, default=4)
    ap.add_argument("--skip-null", action="store_true")
    ap.add_argument("--naive-only", action="store_true", help="only the full-history tune (and null unless skipped)")
    ap.add_argument("--early-stopping", type=int, default=50, help="tune's trials-without-improvement stop")
    ap.add_argument("--out", default=os.path.join(HERE, "experiment-results.json"))
    args = ap.parse_args()
    global EARLY_STOP
    EARLY_STOP = args.early_stopping
    np.random.seed(NUMPY_GLOBAL_SEED)
    t_start = time.time()
    dates, Hs, Hm = load_draws()
    log(f"MLArena {getattr(mlarena, '__version__', '?')} | lightgbm {lgb.__version__} | pandas {pd.__version__} | "
        f"numpy {np.__version__} | python {sys.version.split()[0]}")
    log(f"draws: {len(dates)} ({dates[0]}..{dates[-1]}), echo row 2022-11-10 dropped; "
        f"eval draws {EVAL_START}..{len(dates)-1} = {dates[EVAL_START]}..{dates[-1]}")
    results = dict(
        seeds=dict(SEED_MODEL=SEED_MODEL, TUNE_SEED=TUNE_SEED, TIE_SEED=TIE_SEED, NULL_SEED=NULL_SEED,
                   NUMPY_GLOBAL_SEED=NUMPY_GLOBAL_SEED),
        config=dict(W0=W0, EVAL_START=EVAL_START, REFIT_EVERY=REFIT_EVERY, tune_every=args.tune_every,
                    trials_per_tune=args.trials, mlarena_default_trials=500, early_stopping=args.early_stopping, cv=5, cv_variance_penalty=0.1,
                    tune_metric="auc", features=FEATS, gap_cap=GAP_CAP, n_jobs=args.n_jobs,
                    lgbm_fixed=lgbm_fixed(args.n_jobs).get_params(), rf_fixed=rf_fixed(args.n_jobs).get_params(),
                    param_ranges={k: (list(v) if isinstance(v, tuple) else v) for k, v in param_ranges(args.n_jobs).items()}),
        eval_dates=[dates[EVAL_START], dates[-1]],
        versions=dict(mlarena=getattr(mlarena, "__version__", "?"), lightgbm=lgb.__version__, pandas=pd.__version__,
                      numpy=np.__version__, python=sys.version.split()[0]),
        targets={},
    )
    stdout_log: list[str] = []
    all_plays = []
    for name in args.targets.split(","):
        spec = TARGETS[name]
        H = Hs if name == "super" else Hm
        df = build_rows(H, spec["p"])
        check_no_lookahead(H, df, spec["p"])
        rep = dict(rows=len(df), base_rate_rows=float(df.hit.mean()))
        log(f"\n=== target {name}: K={spec['K']} play top-{spec['play']}, rows {len(df)} "
            f"(draws {W0}..{len(dates)-1}), row base rate {df.hit.mean():.4f}")
        # (i) naive tune on the full history -- what MLArena reports out of the box
        t0 = time.time()
        naive = run_tune(df, args.trials, args.n_jobs, stdout_log)
        naive["reproduced"] = reproduce_folds(df, naive["best_params"], spec["p"])
        rep["naive_full_history_tune"] = naive
        log(f"  naive full-history tune: best CV AUC {naive['cv_auc_mean']:.4f} (sd {naive['cv_auc_std']:.4f}), "
            f"penalised {naive['cv_auc_penalised']:.4f}, holdout AUC {naive['holdout_auc']:.4f}, "
            f"reproduced mean {naive['reproduced']['mean_auc']:.4f}  ({time.time()-t0:.0f}s)")
        # (iii) the same tune on a simulated fair history (null reference)
        if not args.skip_null:
            t0 = time.time()
            rng = np.random.default_rng(NULL_SEED + (0 if name == "super" else 1))
            Hn = np.zeros_like(H)
            for t in range(len(H)):
                Hn[t, rng.choice(spec["K"], 1 if name == "super" else 5, replace=False)] = 1
            dfn = build_rows(Hn, spec["p"])
            null = run_tune(dfn, args.trials, args.n_jobs, stdout_log)
            null["reproduced"] = reproduce_folds(dfn, null["best_params"], spec["p"])
            rep["null_fair_history_tune"] = null
            log(f"  FAIR simulated history tune: best CV AUC {null['cv_auc_mean']:.4f} (sd {null['cv_auc_std']:.4f}), "
                f"holdout AUC {null['holdout_auc']:.4f}  ({time.time()-t0:.0f}s)")
        if args.naive_only:
            results["targets"][name] = rep
            continue
        # walk-forward
        plays = walk_forward(df, spec, name, H, args, rep, stdout_log)
        for m, pl in plays.items():
            for x in pl:
                all_plays.append(dict(target=name, model=m, date=dates[x["draw"]], **x))
        results["targets"][name] = rep
        for m, r in rep["walk_forward"].items():
            log(f"  WF {name}/{m}: {r['hits']:.0f} over {r['evaluated']} (rate {r['rate']:.4f} vs {r['baseline']:.4f}), "
                f"z = {r['z']:+.2f}, WF AUC {r['wf_auc']:.4f}, ties at boundary {r['boundary_ties']}")
    # Bonferroni thresholds
    def bonf(m):
        return float(norm.ppf(1 - 0.025 / m))
    results["bonferroni"] = {
        "super_tournament_24_rules": bonf(24), "super_24_plus_3": bonf(27),
        "main_tournament_14_strategies": bonf(14), "main_14_plus_3": bonf(17),
        "these_6_alone": bonf(6),
    }
    results["runtime_seconds"] = round(time.time() - t_start, 1)
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=2, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    if all_plays:
        pd.DataFrame(all_plays).assign(
            played=lambda d: d.played.map(lambda v: "-".join(map(str, v))),
            drawn=lambda d: d.drawn.map(lambda v: "-".join(map(str, v))),
        ).to_csv(os.path.splitext(args.out)[0] + "-plays.csv", index=False)
    with open(os.path.splitext(args.out)[0] + "-tune-stdout.log", "w") as fh:
        fh.write("\n\n=====\n\n".join(stdout_log))
    log(f"\nBonferroni: {json.dumps({k: round(v, 3) for k, v in results['bonferroni'].items()})}")
    log(f"runtime {results['runtime_seconds']} s -> {args.out}")


if __name__ == "__main__":
    main()
