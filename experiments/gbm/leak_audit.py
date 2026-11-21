"""Skeptic A (leakage) audit of experiment.py.

1. Independent data load + echo check + brute-force feature recompute for EVERY row.
2. Future-perturbation invariance: replace draws H[c:] by fresh fair draws, rerun the
   real walk_forward() of experiment.py, and require predictions for every draw <= c to be
   bit-identical (a prediction for draw t may only depend on H[:t]). Power check: draw c+1
   must change (it depends on H[c]).
3. Independent rescoring of the reported plays CSV against the raw JSON.

Usage: python -I leak_audit.py <experiment_dir> <target> <trials> <cut1,cut2,...>
"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
import sys
import time

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("expdir")
ap.add_argument("target")
ap.add_argument("trials", type=int)
ap.add_argument("cuts")
ap.add_argument("--out", required=True)
ap.add_argument("--n-jobs", type=int, default=4)
a = ap.parse_args()

spec = importlib.util.spec_from_file_location("exp_under_audit", os.path.join(a.expdir, "experiment.py"))
E = importlib.util.module_from_spec(spec)
spec.loader.exec_module(E)

report = {}

# ---------------------------------------------------------------- 1. independent load
raw = json.load(open(os.path.expanduser("~/.bancolombia/baloto-draws.json")))["draws"]
bal = sorted([x for x in raw if x["game"] == "baloto"], key=lambda x: x["date"])
dups = [(bal[i - 1]["date"], bal[i]["date"]) for i in range(1, len(bal))
        if sorted(bal[i]["main"]) == sorted(bal[i - 1]["main"]) and bal[i]["super"] == bal[i - 1]["super"]]
report["consecutive_identical_draws"] = dups
indep = [x for i, x in enumerate(bal) if not (i > 0 and sorted(x["main"]) == sorted(bal[i - 1]["main"])
                                               and x["super"] == bal[i - 1]["super"])]
dates, Hs, Hm = E.load_draws()
report["indep_n"] = len(indep)
report["indep_dates_match"] = [x["date"] for x in indep] == dates
H = Hs if a.target == "super" else Hm
sp = E.TARGETS[a.target]
K, p = sp["K"], sp["p"]
Hi = np.zeros_like(H)
for t, x in enumerate(indep):
    if a.target == "super":
        Hi[t, x["super"] - 1] = 1
    else:
        Hi[t, np.array(x["main"]) - 1] = 1
report["H_matches_indep"] = bool((Hi == H).all())

df = E.build_rows(H, p)
# brute force every row
feat = df[E.FEATS].to_numpy(float)
dr = df.draw.to_numpy(); bl = df.ball.to_numpy() - 1; y = df.hit.to_numpy()
bad = 0
HT = H.T.tolist()
for i in range(len(df)):
    t, b = int(dr[i]), int(bl[i])
    past = HT[b][:t]  # strictly before t
    seen = [s for s in range(t) if past[s]]
    gap = min(t - seen[-1], E.GAP_CAP) / E.GAP_CAP if seen else 1.0
    e = [gap] + [(sum(past[t - w:t]) / w) / p - 1 for w in (10, 50, 200)] + [float(past[t - 1])]
    if not np.allclose(feat[i], e, atol=1e-12) or y[i] != H[t, b]:
        bad += 1
report["rows"] = len(df)
report["rows_feature_mismatch"] = bad
# rows ordered (draw, ball) as score_target's reshape assumes
report["row_order_ok"] = bool((dr.reshape(-1, K) == dr.reshape(-1, K)[:, :1]).all()
                              and (bl.reshape(-1, K) == np.arange(K)).all())


# ---------------------------------------------------------------- 2. perturbation invariance
captured = {}
_orig_score = E.score_target


def _capture(df_, preds, H_, spec_, name):
    captured[id(preds)] = preds.copy()
    captured.setdefault("order", []).append(preds.copy())
    return _orig_score(df_, preds, H_, spec_, name)


E.score_target = _capture


class A:
    trials = a.trials
    tune_every = 100
    n_jobs = a.n_jobs


def run_wf(Hx):
    captured.clear()
    dfx = E.build_rows(Hx, p)
    rep = {}
    t0 = time.time()
    with contextlib.redirect_stdout(io.StringIO()):
        E.walk_forward(dfx, sp, a.target, Hx, A, rep, [])
    pr = dict(zip(("lgbm", "rf", "tuned"), captured["order"]))
    return dfx, pr, rep, time.time() - t0


df0, P0, rep0, s0 = run_wf(H)
report["orig_seconds"] = round(s0, 1)
report["orig_walk_forward"] = {m: dict(hits=v["hits"], z=round(v["z"], 4), wf_auc=round(v["wf_auc"], 4))
                               for m, v in rep0["walk_forward"].items()}
report["perturbation"] = []
for c in map(int, a.cuts.split(",")):
    rng = np.random.default_rng(1000 + c)
    Hp = H.copy()
    Hp[c:] = 0
    for t in range(c, len(H)):
        Hp[t, rng.choice(K, 1 if a.target == "super" else 5, replace=False)] = 1
    dfp, Pp, repp, sp_ = run_wf(Hp)
    d0 = df0.draw.to_numpy()
    entry = dict(cut=c, seconds=round(sp_, 1))
    for m in P0:
        le = d0 <= c
        nxt = d0 == c + 1
        later = d0 > c
        entry[m] = dict(
            identical_through_c=bool(np.array_equal(P0[m][le & (d0 >= E.EVAL_START)], Pp[m][le & (d0 >= E.EVAL_START)])),
            max_abs_diff_through_c=float(np.max(np.abs(P0[m][le & (d0 >= E.EVAL_START)] - Pp[m][le & (d0 >= E.EVAL_START)]))),
            changed_at_c_plus_1=bool(not np.array_equal(P0[m][nxt], Pp[m][nxt])),
            share_rows_changed_after_c=float(np.mean(P0[m][later] != Pp[m][later])),
        )
    report["perturbation"].append(entry)
    print(json.dumps(entry), flush=True)

# ---------------------------------------------------------------- 3. rescore plays CSV
import pandas as pd

pl = pd.read_csv(os.path.join(a.expdir, "experiment-results-plays.csv"))
pl = pl[pl.target == a.target]
bydate = {x["date"]: x for x in indep}
resc = {}
for m, g in pl.groupby("model"):
    h = 0
    ok = True
    for _, r in g.iterrows():
        x = bydate[r.date]
        played = [int(v) for v in str(r.played).split("-")]
        drawn = [x["super"]] if a.target == "super" else sorted(x["main"])
        ok &= [int(v) for v in str(r.drawn).split("-")] == drawn
        hh = len(set(played) & set(drawn))
        ok &= hh == r.hit
        h += hh
    # also: plays CSV top-k equals top-k from recomputed original preds
    resc[m] = dict(n=len(g), hits=h, drawn_ok=bool(ok))
report["rescored_csv"] = resc
json.dump(report, open(a.out, "w"), indent=1, default=str)
print(json.dumps({k: v for k, v in report.items() if k != "perturbation"}, default=str, indent=1))
