# The simulated air machine, and what 38 000 simulated draws say about a selection rule

Archived evidence for the research-registry row "Simulated air machine" in
`CLAUDE.md`. Not part of the CLI, not a tournament entry; nothing here changes
a recommendation.

- `balotera-simulada.html` — the page published as an artifact: two air
  machines (43 and 16 balls) following the draw protocol of Coljuegos' Acuerdo
  03 de 2026, art. 2.4.3 (ball set and number of pre-draws chosen by a random
  number generator, pre-draws, official draw; Baloto and Revancha as separate
  draws), with a twin machine one nanometre apart. Ball size (4 cm), machine
  size (70 and 48 cm), shape, air and timings are **assumptions**: the
  regulation leaves them to certification standards it does not publish.
- `balotera.ts` — the page's physics, headless, with a mass per ball and a
  configurable mixing time. `bun experiments/balotera/balotera.ts check` runs
  the page's own script and the port in the same engine and requires identical
  draws (8 of 8, twin included). Across engines the draws differ: Bun, Node
  and Chromium disagree in the last bit of `sin`, `cos` and `exp`, and a last
  bit is enough to change every ball.
- `analyse.ts` — counts a batch. `results/draws.jsonl.gz` holds the 38 000
  draws below; `gunzip` it into a folder and run
  `bun experiments/balotera/analyse.ts <folder>`.

## The question

Owner, 2026-11-16: with the simulator, simulate many results, analyse them and
get a selection criterion.

A simulator can only return what was put into it: its draws describe the
model, not the machine in the studio. What it can do is say what would have to
be physically true for a selection rule to exist, and how large that would
look in real draws. The real history is then the only judge.

## 1. Fair machine, identical balls: does the starting place matter?

| Mixing before the first ball | Draws | Slot χ² (38 if the place does not matter) | p | Number χ² | p | First ball from the two bottom rows (32.6 % if not) |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5 s | 4 000 | 360.2 | < 0.001 | 35.9 | 0.55 | 45.3 % |
| 2.5 s (the page) | 8 000 | 28.1 | 0.89 | 39.3 | 0.41 | 32.6 % |
| 8 s | 3 000 | 33.9 | 0.68 | 27.6 | 0.90 | 33.9 % |

With half a second of mixing a ball that starts in the bottom row is drawn
12.8 % of the time and the one alone in the top row 9.3 % (11.63 % each if the
place did not matter). From 2.5 s on the place leaves no trace. Numbers are
uniform in all three, because which number sits where is shuffled each draw.

## 2. A rule built on one set of draws, tried on the next

8 000 fair draws to choose from, 8 000 independent ones to test on:

- The hottest number, 7, came out 1 002 times (z +2.63) and then 886 (−1.62);
  the coldest, 15, 853 (−2.83) and then 944 (+0.50). 930 expected each time.
- Playing the five most drawn (7, 9, 41, 26, 32) matched 0.5769 numbers a draw
  afterwards (z −0.59); the five least drawn, 0.5850 (z +0.47); chance 0.5814.
- Correlation between a number's deviation before and after: −0.105.

The same test on the real history, first half against second half (496 draws
each): Baloto's hottest number of the first half, 8, went from 72 to 50
appearances; its five hottest then matched 0.5766 a draw (z −0.16), its five
coldest 0.6069 (z +0.83), correlation −0.212. Revancha: hottest 22, 72 then
43; hot five 0.5484 (z −1.08), cold five 0.6089 (z +0.90), correlation −0.274.
A 17 % gap between two numbers is what a machine that is fair by construction
produces in 8 000 draws.

## 3. One ball of a different weight (number 7, 2.5 s of mixing)

| Ball 7 | Draws | Drawn in | z against 11.63 % |
| --- | --- | --- | --- |
| identical (both fair sets) | 16 000 | 11.80 % | +0.68 |
| 5 % lighter | 5 000 | 12.40 % | +1.70 |
| 10 % lighter | 5 000 | 12.34 % | +1.57 |
| both lighter runs | 10 000 | 12.37 % (95 %: 11.74–13.00 %) | +2.31 |
| 10 % heavier | 5 000 | 11.16 % (95 %: 10.27–12.05 %) | −1.03 |

In this model a ball 5–10 % lighter comes out about 6 % more often, and the
evidence for even that is thin. The lighter and heavier runs reuse the seeds
of the first 5 000 fair draws, in which ball 7 happened to come out 12.80 %;
against that baseline the lighter runs show nothing and the heavier one a
deficit. Either way the effect is under one percentage point.

A ball 6.4 % likelier would be drawn about 123 times instead of 115 in the 992
real draws (z +0.8). Seeing it at the 43-ball threshold with 80 % power takes
about 28 000 draws — 181 years — and the regulation's five ball sets, chosen at
random each draw, dilute a defect in one set to a fifth: 705 000 draws. The
model's size for the effect is not calibrated (the literature finds real air
machines more sensitive to a light ball), so the real history decides: its
largest deviations are +2.24 σ (Baloto, ball 25) and +1.75 σ (Revancha, ball
4), and a fair machine shows one that large somewhere among 43 balls in 66 %
of histories.

## Reading

No selection criterion comes out. The simulation shows the two places one
could come from — a machine that mixes too little while the balls are always
loaded in the same known places, or a ball of a different weight — and the
real draws show neither: `stats`, `physical` and the first-half/second-half
test above are all flat.

## Reproduce

```sh
bun experiments/balotera/balotera.ts check
bun experiments/balotera/balotera.ts run fair 0 8000 out/fair.jsonl 2.5 esfera
bun experiments/balotera/balotera.ts run fair2 100000 108000 out/fair2.jsonl 2.5 esfera
bun experiments/balotera/balotera.ts run mix05 0 4000 out/mix05.jsonl 0.5 esfera
bun experiments/balotera/balotera.ts run mix8 0 3000 out/mix8.jsonl 8 esfera
bun experiments/balotera/balotera.ts run light5 0 5000 out/light5.jsonl 2.5 esfera 7:0.95
bun experiments/balotera/balotera.ts run light10 0 5000 out/light10.jsonl 2.5 esfera 7:0.90
bun experiments/balotera/balotera.ts run heavy10 0 5000 out/heavy10.jsonl 2.5 esfera 7:1.10
bun experiments/balotera/analyse.ts out
```

About 0.15 s a draw on one core. The archived draws were produced with Bun;
another engine gives different draws and the same statistics.
