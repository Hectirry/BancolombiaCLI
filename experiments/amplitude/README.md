# The amplitude of a draw, and tickets shaped by it

Archived evidence for the research-registry row "Amplitude (max − min) of a
draw" in `CLAUDE.md`. Not part of the CLI, not a tournament entry; nothing
here changes a recommendation.

Question (owner, 2026-11-16, after the Baloto draw 24 28 38 41 42 of
2026-11-14): the numbers of one draw sit in a band; should the tickets be
chosen with that amplitude in mind?

Answer: no. Run `bun experiments/amplitude/amplitude.ts` (needs the dataset
on disk; about 5 s).

- **Exact law.** P(amplitude = r) = (43 − r)·C(r − 1, 3) / 962 598. Mean
  29.33, median 30, middle half 24–35, 90 % of draws between 16 and 40. A
  draw as narrow as that Saturday's (≤ 18) is 8.8 % of draws, one in eleven;
  all five numbers ≥ 24 is 1.61 %, one in 62.
- **The real history follows it.** 992 draws per machine, eight bands:
  χ²(7) = 4.9 (Baloto) and 4.3 (Revancha) against a 5 % critical value of
  14.1. Narrow draws: 75 and 87 against 87.7 expected; all five ≥ 24: 19 and
  16 against 16.0.
- **One draw's amplitude says nothing about the next.** Lag-1 correlation
  0.023 (permutation p = 0.48) on Baloto, 0.060 (p = 0.06) on Revancha.
- **Tickets shaped by amplitude match no better.** Walk-forward over the last
  592 draws, 300 tickets per rule per draw, against 0.5814 matches per ticket
  and 0.750 % of tickets with three or more:

  | Rule for the ticket's amplitude | Baloto | z | Revancha | z |
  | --- | --- | --- | --- | --- |
  | none | 0.5805 | −0.54 | 0.5814 | −0.02 |
  | typical (25–35) | 0.5813 | −0.02 | 0.5810 | −0.19 |
  | narrow (≤ 18) | 0.5859 | +1.04 | 0.5817 | +0.09 |
  | wide (≥ 38) | 0.5855 | +0.61 | 0.5786 | −0.42 |
  | same as the previous draw (±2) | 0.5820 | +0.17 | 0.5838 | +0.62 |
  | opposite of the previous draw | 0.5809 | −0.12 | 0.5771 | −1.09 |

Why a "typical-looking" ticket is not likelier: 51.9 % of draws have an
amplitude of 25–35, but so do 499 114 of the 962 598 tickets; 8.8 % of draws
are ≤ 18, and so are 85 068 tickets. 0.519 / 499 114 = 0.088 / 85 068 =
1 / 962 598. The draw lands in the big group more often and then has more
tickets to choose from, in exact proportion.

## `seed.ts` — tickets that look like an ordinary draw

Asking for a typical amplitude costs nothing (above), and the owner prefers
tickets shaped that way. `bun experiments/amplitude/seed.ts <MMDD> [tickets]`
prints the first seed, counting up from the date, whose structure-only tickets
(`optimiseCoverage`: disjoint) all have an amplitude within 24–35 — the middle
half of the exact law. That seed goes to `baloto super --seed`. The main
numbers are still chosen by structure alone; the amplitude only decides which
of the equally likely arrangements is handed over.
