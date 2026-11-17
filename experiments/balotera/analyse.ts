/**
 * Count what the simulated machines did. Reads every *.jsonl a `balotera.ts run`
 * wrote into a directory and reports, per experiment:
 *
 *   - whether the place a ball starts from (its slot in the loading grid) changes
 *     its chance of being drawn — the physical question behind "is it fair?";
 *   - whether any number comes out more than another;
 *   - for a machine with one ball of a different weight, how much likelier that
 *     ball becomes, and what that would look like in the real 992-draw history.
 *
 *   bun experiments/balotera/analyse.ts <dir>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRng, randInt, sampleDistinct } from "../../src/baloto/random.ts";
import { normalCdf, normalQuantile } from "../../src/baloto/numeric.ts";

interface Row { e: string; i: number; m: number[]; s: number[]; a: number[]; b: number; bs: number }
const dir = process.argv[2] ?? ".";
const rows: Row[] = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) =>
  readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
const by = new Map<string, Row[]>();
for (const r of rows) { if (r.m.length === 5) (by.get(r.e) ?? by.set(r.e, []).get(r.e)!).push(r); }

const POOL = 43, PICK = 5, DT = 2e-4;
const pct = (x: number, d = 2) => (100 * x).toFixed(d) + " %";
const pad = (s: string | number, w: number) => String(s).padStart(w);
const chi = (counts: number[], expected: number) => counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);

/** Monte Carlo p-value of a Pearson statistic over `pool` cells when each draw takes `pick` distinct cells. */
function mcP(stat: number, n: number, pool: number, pick: number, sims = 2000, seed = 11): { p: number; mean: number } {
  const rng = makeRng(seed), buf = new Int32Array(pool), exp = (n * pick) / pool;
  let ge = 0, sum = 0;
  for (let s = 0; s < sims; s++) {
    const c = new Array<number>(pool).fill(0);
    for (let i = 0; i < n; i++) {
      if (pick === 1) c[randInt(rng, pool)]!++;
      else for (const v of sampleDistinct(rng, pool, pick, buf)) c[v - 1]!++;
    }
    const x = chi(c, exp); sum += x; if (x >= stat) ge++;
  }
  return { p: (ge + 1) / (sims + 1), mean: sum / sims };
}

const order = ["mix05", "fair", "mix8"];
console.log("1. FAIR MACHINE, IDENTICAL BALLS — does the starting place or the number matter?\n");
console.log(pad("mixing", 8), pad("draws", 7), pad("slot χ²", 9), pad("if fair", 8), pad("p", 7), pad("number χ²", 10), pad("p", 7), pad("2nd-set slot χ²", 16), pad("p", 7), pad("wait for ball 1", 16));
for (const name of order) {
  const rs = by.get(name); if (!rs) continue;
  const n = rs.length, slots = new Array<number>(POOL).fill(0), nums = new Array<number>(POOL).fill(0), sb = new Array<number>(16).fill(0);
  let wait = 0;
  for (const r of rs) { r.s.forEach((s) => slots[s]!++); r.m.forEach((m) => nums[m - 1]!++); if (r.bs >= 0) sb[r.bs]!++; wait += r.a[0]!; }
  const exp = (n * PICK) / POOL, xs = chi(slots, exp), xn = chi(nums, exp), xb = chi(sb, n / 16);
  const ps = mcP(xs, n, POOL, PICK), pn = mcP(xn, n, POOL, PICK, 2000, 12), pb = mcP(xb, n, 16, 1, 2000, 13);
  const mix = name === "mix05" ? 0.5 : name === "mix8" ? 8 : 2.5;
  console.log(pad(mix + " s", 8), pad(n, 7), pad(xs.toFixed(1), 9), pad(ps.mean.toFixed(1), 8), pad(ps.p.toFixed(3), 7), pad(xn.toFixed(1), 10), pad(pn.p.toFixed(3), 7), pad(xb.toFixed(1), 16), pad(pb.p.toFixed(3), 7),
    pad(((wait / n) * DT - mix).toFixed(3) + " s", 16));
}

console.log("\n   Chance of being drawn by the row of the loading grid a ball starts in (bottom row 1 … top row 7; 11.63 % if the place does not matter)");
console.log(pad("mixing", 8), ...[1, 2, 3, 4, 5, 6, 7].map((r) => pad("row " + r, 9)), pad("first ball: bottom rows 1–2", 30), pad("top rows 5–7", 14));
for (const name of order) {
  const rs = by.get(name); if (!rs) continue;
  const n = rs.length, rowHits = new Array<number>(7).fill(0), rowSize = [7, 7, 7, 7, 7, 7, 1];
  let firstBottom = 0, firstTop = 0;
  for (const r of rs) { r.s.forEach((s) => rowHits[Math.floor(s / 7)]!++); const f = Math.floor(r.s[0]! / 7); if (f <= 1) firstBottom++; if (f >= 4) firstTop++; }
  const mix = name === "mix05" ? 0.5 : name === "mix8" ? 8 : 2.5;
  console.log(pad(mix + " s", 8), ...rowHits.map((h, k) => pad(pct(h / (n * rowSize[k]!)), 9)),
    pad(`${pct(firstBottom / n, 1)} (fair 32.6 %)`, 30), pad(`${pct(firstTop / n, 1)} (34.9 %)`, 14));
}

console.log("\n2. ONE BALL OF A DIFFERENT WEIGHT (number 7; 2.5 s of mixing) — the only kind of thing a selection rule could feed on\n");
const base = PICK / POOL, REAL = 992;
// A count over the real history: 5 of 43 without replacement, so the variance carries the 38/42 factor.
const sdReal = Math.sqrt(REAL * base * (1 - base) * (38 / 42));
const bonf = normalQuantile(1 - 0.025 / POOL);
console.log(pad("ball 7 is", 14), pad("draws", 7), pad("drawn in", 10), pad("fair", 9), pad("z", 7), pad("ratio", 7), pad("first out", 10), pad("in 992 real draws", 19), pad("z there", 9));
const fair = by.get("fair");
if (fair) {
  const k = fair.filter((r) => r.m.includes(7)).length, n = fair.length;
  console.log(pad("same as rest", 14), pad(n, 7), pad(pct(k / n), 10), pad(pct(base), 9), pad(((k / n - base) / Math.sqrt((base * (1 - base)) / n)).toFixed(2), 7), pad((k / n / base).toFixed(3), 7),
    pad(pct(fair.filter((r) => r.m[0] === 7).length / n), 10), pad((REAL * (k / n)).toFixed(0) + " vs 115", 19), pad(((REAL * (k / n) - REAL * base) / sdReal).toFixed(2), 9));
}
for (const [name, label] of [["light5", "5 % lighter"], ["light10", "10 % lighter"], ["heavy10", "10 % heavier"]] as const) {
  const rs = by.get(name); if (!rs) continue;
  const n = rs.length, k = rs.filter((r) => r.m.includes(7)).length, first = rs.filter((r) => r.m[0] === 7).length;
  const p = k / n, z = (p - base) / Math.sqrt((base * (1 - base)) / n);
  console.log(pad(label, 14), pad(n, 7), pad(pct(p), 10), pad(pct(base), 9), pad(z.toFixed(2), 7), pad((p / base).toFixed(3), 7), pad(pct(first / n), 10),
    pad((REAL * p).toFixed(0) + " vs 115", 19), pad(((REAL * p - REAL * base) / sdReal).toFixed(2), 9));
}
console.log(`\n   A count in the real history has a standard deviation of ${sdReal.toFixed(1)}; reading all 43 balls at once, one stands out past |z| = ${bonf.toFixed(2)}.`);
console.log(`   The largest real deviations are +2.24 σ (Baloto, ball 25) and +1.75 σ (Revancha, ball 4): P(|z| ≥ 2.24 somewhere among 43) = ${pct(1 - (1 - 2 * (1 - normalCdf(2.24))) ** POOL, 0)}.`);

// 3. A rule built on one set of fair draws, tried on another: the numbers that came out most and least.
const zScores = (mains: number[][]) => {
  const n = mains.length, sd = Math.sqrt(n * base * (1 - base) * (38 / 42)), c = new Array<number>(POOL + 1).fill(0);
  for (const m of mains) for (const v of m) c[v]!++;
  return { z: c.map((v) => (v - n * base) / sd), c };
};
const corr = (x: number[], y: number[]) => {
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; syy += (y[i]! - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};
function hotColdTest(title: string, first: number[][], second: number[][]) {
  const a = zScores(first), b = zScores(second);
  const order = Array.from({ length: POOL }, (_, i) => i + 1).sort((p, q) => a.z[q]! - a.z[p]!);
  const hot = order.slice(0, 5), cold = order.slice(-5);
  const rate = (nums: number[]) => second.reduce((acc, m) => acc + m.filter((v) => nums.includes(v)).length, 0) / second.length;
  const se = Math.sqrt((5 * base * (1 - base) * (38 / 42)) / second.length), chance = (5 * PICK) / POOL;
  console.log(`   ${title}: ${first.length} draws to choose, ${second.length} to test`);
  console.log(`     most drawn five ${hot.join(", ")} → ${rate(hot).toFixed(4)} matches a draw afterwards (z ${((rate(hot) - chance) / se).toFixed(2)}); least drawn five ${cold.join(", ")} → ${rate(cold).toFixed(4)} (z ${((rate(cold) - chance) / se).toFixed(2)}); chance ${chance.toFixed(4)}`);
  console.log(`     correlation between a number's deviation before and after: ${corr(a.z.slice(1), b.z.slice(1)).toFixed(3)} (±0.30 is the 95 % band around zero for 43 numbers)`);
  const top = order[0]!, bottom = order[POOL - 1]!;
  console.log(`     the hottest, ${top}: ${a.c[top]} then ${b.c[top]} (z ${a.z[top]!.toFixed(2)} → ${b.z[top]!.toFixed(2)}); the coldest, ${bottom}: ${a.c[bottom]} then ${b.c[bottom]} (z ${a.z[bottom]!.toFixed(2)} → ${b.z[bottom]!.toFixed(2)})`);
}
console.log("\n3. A RULE BUILT ON ONE SET OF DRAWS, TRIED ON THE NEXT — hot and cold numbers\n");
const second = by.get("fair2");
if (fair && second) hotColdTest("simulated fair machine, two independent sets", fair.map((r) => r.m), second.map((r) => r.m));
try {
  const { loadDataset, drawsFor } = await import("../../src/baloto/dataset.ts");
  const ds = await loadDataset();
  if (ds) for (const game of ["baloto", "revancha"] as const) {
    const mains = drawsFor(ds, game).map((d) => d.main), half = Math.floor(mains.length / 2);
    hotColdTest(`real ${game}, first half against second half`, mains.slice(0, half), mains.slice(half));
  }
} catch { /* the real history is optional here */ }

// 4. What a weight defect of the size seen in section 2 would take to show in real draws.
const lighter = [...(by.get("light5") ?? []), ...(by.get("light10") ?? [])];
if (lighter.length > 0) {
  const p = lighter.filter((r) => r.m.includes(7)).length / lighter.length, se = Math.sqrt((base * (1 - base)) / lighter.length), eff = p / base - 1;
  const k = Math.sqrt(base / ((1 - base) * (38 / 42))), need = (e: number) => ((bonf + 0.84) / (e * k)) ** 2;
  console.log(`\n4. LIGHTER BALLS TOGETHER — ${lighter.length} draws: ${pct(p)} (z ${((p - base) / se).toFixed(2)}, 95 % interval ${pct(p - 1.96 * se)} to ${pct(p + 1.96 * se)}), ${pct(eff, 1)} likelier`);
  console.log(`   To see a ball that much likelier in real draws (80 % power at the 43-ball threshold): ${Math.round(need(eff)).toLocaleString("en-US")} draws, ${Math.round(need(eff) / 156)} years at 156 a year.`);
  console.log(`   With five ball sets drawn at random, a defect in one set is a fifth of that: ${Math.round(need(eff / 5)).toLocaleString("en-US")} draws.`);
}
