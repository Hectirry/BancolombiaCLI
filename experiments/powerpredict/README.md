# cpeoples/powerpredict on the Baloto history

Archived evidence for the registry row "Off-the-shelf AI lottery predictor" in
`CLAUDE.md`. Not part of the CLI, not a tournament entry; nothing here changes
a recommendation.

[`cpeoples/powerpredict`](https://github.com/cpeoples/powerpredict) (commit
`f651c4c`, 2025-12-24) is the most complete public "AI lottery prediction"
repository found on GitHub: weighted statistics, Markov chains, pattern
matching, a Transformer plus a bidirectional LSTM/GRU hybrid, and a master
ensemble. `wf.py` imports its `main.py` unchanged, adds Baloto's format
(43 + 16) to its `GAMES` table and runs it walk-forward: every draw from the
401st on is predicted from earlier draws only, statistical models rebuilt each
draw, the neural ensemble retrained every 25 draws with the repo's own
`train_ensemble(epochs=80)`. Three tickets a draw; the repo's own
`validate_predictions` makes the three balls distinct, so chance is 3/16.

580 draws per machine through 2026-10-17; 108.75 Súper Balota hits and 1 011.6
main-number matches expected.

| Model | Baloto Súper | z | Revancha Súper | z | Baloto mains z | Revancha mains z |
| --- | --- | --- | --- | --- | --- | --- |
| Weighted statistical | 111 | +0.24 | 104 | −0.51 | +0.51 | +0.05 |
| Markov chain | 108 | −0.08 | 106 | −0.29 | −0.94 | +1.00 |
| Pattern matching | 108 | −0.08 | 100 | −0.93 | +1.14 | −0.34 |
| Statistical ensemble | 114 | +0.56 | 113 | +0.45 | −0.51 | −0.51 |
| Deep learning (Transformer + LSTM/GRU) | 103 | −0.61 | 115 | +0.66 | −2.03 | −1.46 |
| Master ensemble | 113 | +0.45 | 98 | −1.14 | +1.74 | +1.49 |

Nothing nears a Bonferroni threshold of about 3.1. A statistical-only run of the
same code with a different random stream had given the statistical ensemble
126 on Baloto (z +1.84) and 105 on Revancha (−0.40): the same model moves by
1.3 z on the sampling noise alone. Main-number z treats the three tickets as
independent; they may share numbers, so those z are slightly overstated.

Design notes: the master ensemble averages the *values* of other models'
tickets (0.25·stat + 0.20·markov + …) and rounds, so a ball 2 and a ball 14
become an 8 — a number, not a forecast. The neural models regress the sorted
numbers as continuous values (Huber loss) and are then perturbed with Gaussian
noise "to prevent mode collapse"; the output is mostly that noise.

Reproduce: a Python 3.11 venv with `numpy<2 pandas scikit-learn tensorflow-cpu
keras`, a clone of the repo, then
`python -I wf.py <clone> baloto full out.json` (about 2.5 h on 4 cores).
