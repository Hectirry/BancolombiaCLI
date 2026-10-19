# Sequence models (LSTM, GRU, Transformer) on the Súper Balota

Archived evidence for the research-registry row "LSTM / sequence models" in
`CLAUDE.md`. Not part of the CLI, not part of `bun test`, not a tournament
entry. Nothing here changes a recommendation.

Walk-forward from draw 400: each draw is predicted from earlier draws only,
models refit every 25 draws, input the last 20 draws (16-hot Súper Balota +
43-hot main numbers), top-3 balls played. 579 draws per machine, 3/16 = 18.75 %
expected (108.56 hits).

| Machine | Model | Hits | Rate | z | Log loss (ln 16 = 2.7726) |
| --- | --- | --- | --- | --- | --- |
| Baloto | LSTM | 108 | 18.7 % | −0.06 | 2.8991 |
| Baloto | GRU | 104 | 18.0 % | −0.49 | 2.8650 |
| Baloto | Transformer | 105 | 18.1 % | −0.38 | 3.3834 |
| Revancha | LSTM | 115 | 19.9 % | +0.69 | 2.8669 |
| Revancha | GRU | 118 | 20.4 % | +1.00 | 2.8379 |
| Revancha | Transformer | 93 | 16.1 % | −1.66 | 3.3660 |

Every log loss is worse than the constant 1/16: the networks learn noise, and
the more capacity (Transformer) the worse. No hit count approaches the
Bonferroni threshold of 3.08.

Reproduce (seed fixed with `torch.manual_seed(0)`):

```sh
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -I lstm.py
```
