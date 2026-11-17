// "Amplitud" (max − min) of a draw: exact law, the real history against it, memory between
// consecutive draws, and a walk-forward test of tickets shaped by amplitude.
import { loadDataset, drawsFor } from "../../src/baloto/dataset.ts";
import { makeRng, randInt, sampleDistinct } from "../../src/baloto/random.ts";

const POOL = 43, PICK = 5;
const C = (n: number, k: number) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); };
const TOTAL = C(POOL, PICK);
// Exact: choose min and max r apart (43 − r ways), then 3 of the r − 1 numbers between.
const pmf = Array.from({ length: POOL }, (_, r) => (r >= 4 ? ((POOL - r) * C(r - 1, 3)) / TOTAL : 0));
const cdf = pmf.map(((s) => (p: number) => (s += p))(0));
const mean = pmf.reduce((a, p, r) => a + p * r, 0);
const q = (p: number) => cdf.findIndex((c) => c >= p);
const pct = (x: number, d = 1) => (100 * x).toFixed(d) + " %";
const range = (m: number[]) => Math.max(...m) - Math.min(...m);

console.log("EXACT LAW of the amplitude (max − min) of 5 numbers out of 43");
console.log(`  mean ${mean.toFixed(2)}, median ${q(0.5)}, middle half ${q(0.25)}–${q(0.75)}, 90 % of draws between ${q(0.05)} and ${q(0.95)}`);
console.log(`  P(amplitude ≤ 18) = ${pct(cdf[18]!)}  → one draw in ${(1 / cdf[18]!).toFixed(0)};  P(all five ≥ 24) = ${pct(C(20, 5) / TOTAL, 2)} → one in ${(TOTAL / C(20, 5)).toFixed(0)}`);

const ds = (await loadDataset())!;
for (const game of ["baloto", "revancha"] as const) {
  const draws = drawsFor(ds, game); const n = draws.length; const R = draws.map((d) => range(d.main));
  const last = draws[n - 1]!, sat = draws.find((d) => d.date === "2026-11-14")!;
  console.log(`\n== ${game.toUpperCase()} — ${n} draws`);
  console.log(`  Saturday 14 Nov: ${sat.main.join(" ")} → amplitude ${range(sat.main)} (P(≤ that) = ${pct(cdf[range(sat.main)]!)})`);
  // 1. real distribution vs exact
  const bins: [number, number][] = [[4, 18], [19, 23], [24, 27], [28, 30], [31, 33], [34, 36], [37, 39], [40, 42]];
  let chi = 0; const rows: string[] = [];
  for (const [a, b] of bins) {
    const exp = n * (cdf[b]! - (a > 0 ? cdf[a - 1]! : 0)); const obs = R.filter((r) => r >= a && r <= b).length;
    chi += (obs - exp) ** 2 / exp; rows.push(`${a}–${b}: ${obs} (${exp.toFixed(0)})`);
  }
  const m = R.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(pmf.reduce((a, p, r) => a + p * (r - mean) ** 2, 0));
  console.log(`  real mean ${m.toFixed(2)} vs exact ${mean.toFixed(2)} (z ${(((m - mean) / sd) * Math.sqrt(n)).toFixed(2)})`);
  console.log(`  observed (expected) by band: ${rows.join("  ")}`);
  console.log(`  χ² = ${chi.toFixed(1)} on ${bins.length - 1} df (5 % critical 14.1)`);
  const narrow = R.filter((r) => r <= 18).length, high = draws.filter((d) => Math.min(...d.main) >= 24).length;
  console.log(`  draws as narrow as Saturday's Baloto (≤ 18): ${narrow}, expected ${(n * cdf[18]!).toFixed(1)};  all five ≥ 24: ${high}, expected ${(n * C(20, 5) / TOTAL).toFixed(1)}`);
  // 2. memory: does one draw's amplitude say anything about the next?
  const corr = (x: number[], y: number[]) => { const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; syy += (y[i]! - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
  const r1 = corr(R.slice(0, -1), R.slice(1));
  const rng = makeRng(77); let ge = 0; const perm = [...R];
  for (let s = 0; s < 5000; s++) { for (let i = perm.length - 1; i > 0; i--) { const j = randInt(rng, i + 1); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; } if (Math.abs(corr(perm.slice(0, -1), perm.slice(1))) >= Math.abs(r1)) ge++; }
  const afterNarrow = R.slice(1).filter((_, i) => R[i]! <= 23), afterWide = R.slice(1).filter((_, i) => R[i]! >= 37);
  const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  console.log(`  memory: correlation between one draw's amplitude and the next = ${r1.toFixed(3)} (permutation p = ${((ge + 1) / 5001).toFixed(2)})`);
  console.log(`  mean amplitude of the draw AFTER a narrow one (≤ 23): ${avg(afterNarrow)} (${afterNarrow.length} cases);  after a wide one (≥ 37): ${avg(afterWide)} (${afterWide.length} cases);  overall ${m.toFixed(2)}`);

  // 3. walk-forward: tickets shaped by amplitude, 300 tickets per rule per draw, from draw 400 on.
  const buf = new Int32Array(POOL); const trng = makeRng(2026_11_16);
  const ticketWithRange = (lo: number, hi: number): number[] => { for (;;) { const t = sampleDistinct(trng, POOL, PICK, buf); const r = t[4]! - t[0]!; if (r >= lo && r <= hi) return t; } };
  const rules: { name: string; make: (prev: number) => number[] }[] = [
    { name: "any ticket (no shape)", make: () => sampleDistinct(trng, POOL, PICK, buf) },
    { name: "typical amplitude (25–35)", make: () => ticketWithRange(25, 35) },
    { name: "narrow, like Saturday (≤ 18)", make: () => ticketWithRange(4, 18) },
    { name: "wide (≥ 38)", make: () => ticketWithRange(38, 42) },
    { name: "same amplitude as the previous draw (±2)", make: (p) => ticketWithRange(Math.max(4, p - 2), Math.min(42, p + 2)) },
    { name: "opposite of the previous draw", make: (p) => (p >= 30 ? ticketWithRange(4, 24) : ticketWithRange(34, 42)) },
  ];
  const K = 300, START = 400, scored = n - START;
  console.log(`  walk-forward, ${scored} draws, ${K} tickets per rule per draw; chance = 0.5814 matches per ticket, 0.750 % of tickets with ≥ 3`);
  for (const rule of rules) {
    let sum = 0, three = 0; const perDraw: number[] = [];
    for (let t = START; t < n; t++) {
      const drawn = draws[t]!.main; let s = 0;
      for (let k = 0; k < K; k++) { const tk = rule.make(R[t - 1]!); let mt = 0; for (const x of tk) if (drawn.includes(x)) mt++; s += mt; if (mt >= 3) three++; }
      sum += s; perDraw.push(s / K);
    }
    const mu = sum / (scored * K), mm = perDraw.reduce((a, b) => a + b, 0) / scored;
    const se = Math.sqrt(perDraw.reduce((a, b) => a + (b - mm) ** 2, 0) / scored / scored);
    console.log(`    ${rule.name.padEnd(42)} ${mu.toFixed(4)} matches/ticket (z ${((mu - 25 / 43) / se).toFixed(2)})   ≥3: ${pct(three / (scored * K), 3)}`);
  }
  void last;
}

// The tickets on record for tonight.
console.log("\nTONIGHT'S TICKETS");
for (const t of [[22, 24, 26, 32, 37], [1, 3, 29, 39, 42]]) console.log(`  ${t.join(" ")} → amplitude ${range(t)}, P(a draw's amplitude ≤ that) = ${pct(cdf[range(t)]!)}`);
