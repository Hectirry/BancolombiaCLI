"""Walk-forward test of cpeoples/powerpredict (main.py @ f651c4c) on Baloto / Revancha.
Each draw t is predicted from draws < t only. Statistical models rebuilt every draw;
the deep-learning ensemble (Transformer + hybrid LSTM/GRU) retrained every REFIT draws
on past draws only, with the repo's own train_ensemble (80 epochs, early stopping).
3 tickets per draw; the repo's validate_predictions forces distinct balls."""
import importlib.util, json, math, os, sys, time
from datetime import date
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
REPO, GAME, MODE, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]   # mode: quick | full
START, REFIT, N = 400, int(os.environ.get("REFIT", "25")), 3
spec = importlib.util.spec_from_file_location("pp", os.path.join(REPO, "main.py"))
pp = importlib.util.module_from_spec(spec); spec.loader.exec_module(pp)
import numpy as np, pandas as pd, keras
pp.GAMES["baloto"] = {"ball": "Super", "featured_ball": "x", "game": "Baloto", "featured_range": 16, "high_range": 43}
raw = json.load(open(os.path.expanduser("~/.bancolombia/baloto-draws.json")))["draws"]
d = sorted([x for x in raw if x["game"] == GAME], key=lambda x: x["date"])
rows, prev = [], None
for x in d:  # drop exact echo rows (2022-11-10)
    k = (tuple(x["main"]), x["super"])
    if prev and k == prev[0] and (date.fromisoformat(x["date"]) - date.fromisoformat(prev[1])).days <= 1: continue
    rows.append(x); prev = (k, x["date"])
df = pd.DataFrame([dict(Date=x["date"], Num1=x["main"][0], Num2=x["main"][1], Num3=x["main"][2],
                        Num4=x["main"][3], Num5=x["main"][4], Super=x["super"]) for x in rows])
np.random.seed(20261019); keras.utils.set_random_seed(20261019)
methods = ["stat", "markov", "pattern", "quick_ensemble"] + (["dl", "master"] if MODE == "full" else [])
hits = {m: 0 for m in methods}; matches = {m: 0 for m in methods}; plays = []
dl_models = None; t0 = time.time()
for t in range(START, len(df)):
    past = df.iloc[:t].reset_index(drop=True); truth = df.iloc[t]
    an = pp.LotteryAnalyzer(past, "baloto"); pr = pp.IntelligentPredictor(an, past, "baloto")
    v = lambda p: pp.validate_predictions(p, "baloto")
    s, m, pa = v(pr.generate_statistical_prediction(N)), v(pr.generate_markov_prediction(N)), v(pr.generate_pattern_prediction(N))
    out = {"stat": s, "markov": m, "pattern": pa, "quick_ensemble": v(s * 0.4 + m * 0.3 + pa * 0.3)}
    if MODE == "full":
        dlp = pp.DeepLearningPredictor(past, "baloto", seq_length=15)
        if dl_models is None or (t - START) % REFIT == 0:
            dlp.train_ensemble(epochs=80, verbose=0); dl_models = (dlp.transformer, dlp.hybrid)
        dlp.transformer, dlp.hybrid = dl_models
        dlv = v(dlp.predict(N)); out["dl"] = dlv
        out["master"] = v(s * 0.25 + m * 0.20 + pa * 0.20 + dlv * 0.35)
    main = {int(truth[f"Num{i}"]) for i in range(1, 6)}; sb = int(truth["Super"])
    rec = {"date": truth["Date"], "main": sorted(main), "super": sb}
    for k, p in out.items():
        balls = [int(r[5]) for r in p]
        assert len(set(balls)) == N
        hits[k] += sb in balls
        matches[k] += sum(len(main & {int(n) for n in r[:5]}) for r in p)
        rec[k] = [[int(n) for n in r] for r in p]
    plays.append(rec)
    if (t - START) % 25 == 24:
        print(f"{t - START + 1}/{len(df) - START} draws, {time.time() - t0:.0f}s, hits {hits}", flush=True)
n = len(df) - START; p = N / 16; em = n * N * 25 / 43
var_m = n * N * 5 * (5/43) * (38/43) * (38/42)   # hypergeometric variance per ticket, tickets treated independent
res = {"game": GAME, "mode": MODE, "draws": n, "lastDate": df.iloc[-1]["Date"], "expectedSuper": n * p, "expectedMain": em, "methods": {}}
for k in methods:
    res["methods"][k] = {"superHits": hits[k], "superZ": (hits[k] - n * p) / math.sqrt(n * p * (1 - p)),
                         "mainMatches": matches[k], "mainZ": (matches[k] - em) / math.sqrt(var_m)}
json.dump({"summary": res, "plays": plays}, open(OUT, "w"), indent=1)
print(json.dumps(res, indent=1))
