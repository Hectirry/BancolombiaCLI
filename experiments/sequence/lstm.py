"""Sequence models (LSTM, GRU, small Transformer) on the Súper Balota, walk-forward.
Each draw t is predicted from draws < t only. Refit every 25 draws on all past windows.
Input: last W draws, each one-hot over 16 Súper Balotas + the 5 main numbers as a 43-hot.
Output: softmax over 16; play the top-3 distinct balls. Baseline 3/16."""
import json, math, os, sys, torch, torch.nn as nn
torch.manual_seed(0); torch.set_num_threads(4)
raw = json.load(open(os.path.expanduser("~/.bancolombia/baloto-draws.json")))["draws"]
W, START, REFIT, EPOCHS = 20, 400, 25, 30
def series(game):
    d = sorted([x for x in raw if x["game"] == game], key=lambda x: x["date"])
    out, prev = [], None
    for x in d:  # drop exact echo rows (2022-11-10)
        k = (tuple(x["main"]), x["super"])
        if prev is not None and k == prev[0] and x["date"] != prev[1]:
            from datetime import date
            if (date.fromisoformat(x["date"]) - date.fromisoformat(prev[1])).days <= 1: continue
        out.append(x); prev = (k, x["date"])
    return out
def encode(d):
    v = torch.zeros(16 + 43); v[d["super"] - 1] = 1
    for n in d["main"]: v[16 + n - 1] = 1
    return v
class Seq(nn.Module):
    def __init__(s, kind):
        super().__init__(); s.kind = kind; h = 32
        if kind == "lstm": s.rnn = nn.LSTM(59, h, batch_first=True)
        elif kind == "gru": s.rnn = nn.GRU(59, h, batch_first=True)
        else:
            s.inp = nn.Linear(59, h); s.pos = nn.Parameter(torch.zeros(W, h))
            s.enc = nn.TransformerEncoder(nn.TransformerEncoderLayer(h, 4, 64, 0.1, batch_first=True), 2)
        s.drop = nn.Dropout(0.2); s.out = nn.Linear(h, 16)
    def forward(s, x):
        if s.kind == "transformer": z = s.enc(s.inp(x) + s.pos)[:, -1]
        else: z = s.rnn(x)[0][:, -1]
        return s.out(s.drop(z))
def fit(kind, X, y):
    m = Seq(kind); opt = torch.optim.Adam(m.parameters(), 1e-3, weight_decay=1e-4); lf = nn.CrossEntropyLoss()
    m.train()
    for _ in range(EPOCHS):
        perm = torch.randperm(len(X))
        for i in range(0, len(X), 64):
            b = perm[i:i+64]; opt.zero_grad(); lf(m(X[b]), y[b]).backward(); opt.step()
    m.eval(); return m
for game in ["baloto", "revancha"]:
    d = series(game); E = torch.stack([encode(x) for x in d]); Y = torch.tensor([x["super"] - 1 for x in d])
    for kind in ["lstm", "gru", "transformer"]:
        hits = n = 0; ll = 0.0; m = None
        for t in range(START, len(d)):
            if m is None or (t - START) % REFIT == 0:
                idx = torch.arange(W, t); X = torch.stack([E[i-W:i] for i in idx]); m = fit(kind, X, Y[idx])
            with torch.no_grad(): p = torch.softmax(m(E[t-W:t].unsqueeze(0))[0], 0)
            top = torch.topk(p, 3).indices.tolist(); hits += int(Y[t].item() in top); n += 1; ll += -math.log(p[Y[t]].item())
        base = 3/16; z = (hits - n*base) / math.sqrt(n*base*(1-base))
        print(f"{game:8} {kind:11} {hits}/{n} = {100*hits/n:.1f} %  z = {z:+.2f}  log-loss {ll/n:.4f} (azar {math.log(16):.4f})", flush=True)
