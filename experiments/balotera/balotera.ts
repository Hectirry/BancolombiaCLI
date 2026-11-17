/**
 * The air-machine model of the "Balotera simulada" page, headless, so that
 * thousands of draws can be simulated and counted. The physics is a line-for-
 * line port of the page's script (same constants, same order of operations:
 * with every mass equal to 1 it reproduces the page's draws bit for bit),
 * extended with a mass per ball and a configurable mixing time.
 *
 *   bun experiments/balotera/balotera.ts check
 *   bun experiments/balotera/balotera.ts run <name> <from> <to> <out.jsonl> [mix=2.5] [shape=esfera] [label:mass ...]
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const G = 9.81, R = 0.02, REST = 0.92, JET = 60, JET_W = 0.45, DRAG = 0.4, DT = 2e-4;
const INV = Math.SQRT1_2;
export const SPEC_MAIN = { n: 43, S: 0.35 }, SPEC_SUP = { n: 16, S: 0.24 };
export type Shape = "esfera" | "caja";

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Chamber {
  n: number; S: number; shape: Shape; cut: number;
  x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array; invM: Float64Array;
  alive: Uint8Array; label: Int16Array; steps: number; taken: number[]; takenSlots: number[]; takenAt: number[]; phase: number[];
}

export function makeChamber(spec: { n: number; S: number }, shape: Shape, seed: number, nudge = 0, mass?: Map<number, number>): Chamber {
  const n = spec.n, S = spec.S, rng = mulberry(seed);
  const c: Chamber = {
    n, S, shape, cut: 0.57 * S,
    x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n), invM: new Float64Array(n).fill(1),
    alive: new Uint8Array(n).fill(1), label: new Int16Array(n), steps: 0, taken: [], takenSlots: [], takenAt: [], phase: [0, 0, 0],
  };
  const labels = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = labels[i]!; labels[i] = labels[j]!; labels[j] = t;
  }
  const perRow = Math.ceil(Math.sqrt(n)), gap = R * 2.4;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow), col = i % perRow;
    c.label[i] = labels[i]!;
    c.x[i] = (col - (perRow - 1) / 2) * gap + (rng() - 0.5) * 1e-3;
    c.y[i] = -S * 0.5 + row * gap + (rng() - 0.5) * 1e-3;
    const m = mass?.get(labels[i]!);
    if (m) c.invM[i] = 1 / m;
  }
  c.phase = [rng() * 6.2832, rng() * 6.2832, rng() * 6.2832];
  c.x[0] += nudge;
  return c;
}

export function step(c: Chamber): void {
  const { x, y, vx, vy, alive, invM, n, S } = c;
  const jetW = JET_W * S, e = REST;
  const t = c.steps * DT, w1 = 18.8 * t + c.phase[0]!, w2 = 31.4 * t + c.phase[1]!, w3 = 25.1 * t + c.phase[2]!;
  const gust = Math.sin(w1);
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const w = invM[i]!, damp = 1 - DRAG * DT * w;
    const lateral = Math.exp(-((x[i]! / jetW) ** 2));
    const fade = Math.max(0, 1 - (y[i]! + S) / (2 * S));
    const ay = -G + JET * lateral * fade * (1 + 0.3 * Math.sin(w3 + 9 * x[i]!)) * w;
    const ax = (8 * Math.sin(w2 + 12 * y[i]!) + 5 * gust * Math.cos(10 * x[i]! + 6 * y[i]!)) * w;
    vx[i] = (vx[i]! + ax * DT) * damp;
    vy[i] = (vy[i]! + ay * DT) * damp;
    x[i] += vx[i]! * DT;
    y[i] += vy[i]! * DT;
  }
  const minDist = 2 * R, minDist2 = minDist * minDist;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!alive[j]) continue;
      const dx = x[j]! - x[i]!, dy = y[j]! - y[i]!, d2 = dx * dx + dy * dy;
      if (d2 >= minDist2 || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      const wi = invM[i]!, wj = invM[j]!, wsum = wi + wj, ov = minDist - d;
      const hi = (ov * wi) / wsum, hj = (ov * wj) / wsum;
      x[i] -= nx * hi; y[i] -= ny * hi; x[j] += nx * hj; y[j] += ny * hj;
      const closing = (vx[j]! - vx[i]!) * nx + (vy[j]! - vy[i]!) * ny;
      if (closing >= 0) continue;
      const imp = (-(1 + e) * closing) / wsum;
      vx[i] -= imp * wi * nx; vy[i] -= imp * wi * ny; vx[j] += imp * wj * nx; vy[j] += imp * wj * ny;
    }
  }
  const lim = S - R;
  if (c.shape === "esfera") {
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const d2 = x[i]! * x[i]! + y[i]! * y[i]!;
      if (d2 <= lim * lim || d2 === 0) continue;
      const d = Math.sqrt(d2), nx = x[i]! / d, ny = y[i]! / d;
      x[i] = nx * lim; y[i] = ny * lim;
      const vn = vx[i]! * nx + vy[i]! * ny;
      if (vn > 0) { vx[i] -= (1 + e) * vn * nx; vy[i] -= (1 + e) * vn * ny; }
    }
  } else {
    const chamfer = (2 * S - c.cut) * INV - R;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      if (x[i]! > lim) { x[i] = lim; if (vx[i]! > 0) vx[i] = -e * vx[i]!; }
      else if (x[i]! < -lim) { x[i] = -lim; if (vx[i]! < 0) vx[i] = -e * vx[i]!; }
      if (y[i]! > lim) { y[i] = lim; if (vy[i]! > 0) vy[i] = -e * vy[i]!; }
      else if (y[i]! < -lim) { y[i] = -lim; if (vy[i]! < 0) vy[i] = -e * vy[i]!; }
      let s = (x[i]! - y[i]!) * INV;
      if (s > chamfer) {
        const o = (s - chamfer) * INV; x[i] -= o; y[i] += o;
        const vn = (vx[i]! - vy[i]!) * INV;
        if (vn > 0) { const k = (1 + e) * vn * INV; vx[i] -= k; vy[i] += k; }
      }
      s = (-x[i]! - y[i]!) * INV;
      if (s > chamfer) {
        const o = (s - chamfer) * INV; x[i] += o; y[i] += o;
        const vn = (-vx[i]! - vy[i]!) * INV;
        if (vn > 0) { const k = (1 + e) * vn * INV; vx[i] += k; vy[i] += k; }
      }
    }
  }
  c.steps++;
}

export function capture(c: Chamber): number {
  const top = c.S - R - 0.03;
  for (let i = 0; i < c.n; i++) {
    if (c.alive[i] && c.y[i]! > top && Math.abs(c.x[i]!) < 2 * R && c.vy[i]! > 0) {
      c.alive[i] = 0;
      c.taken.push(c.label[i]!); c.takenSlots.push(i); c.takenAt.push(c.steps);
      return c.label[i]!;
    }
  }
  return 0;
}

export interface DrawOptions { shape?: Shape; mix?: number; gap?: number; nudge?: number; mass?: Map<number, number>; skipSuper?: boolean }
export interface DrawResult { main: number[]; slots: number[]; at: number[]; sup: number; supSlot: number }

/** One draw: five from the first machine, then one from the second, with the page's gate rule. */
export function draw(seed: number, o: DrawOptions = {}): DrawResult {
  const shape = o.shape ?? "esfera", mixSteps = Math.round((o.mix ?? 2.5) / DT), gapSteps = Math.round((o.gap ?? 1) / DT);
  const main = makeChamber(SPEC_MAIN, shape, seed, o.nudge ?? 0, o.mass);
  const sup = o.skipSuper ? null : makeChamber(SPEC_SUP, shape, (seed ^ 0x9e3779b9) >>> 0, o.nudge ?? 0);
  let gate = mixSteps, supGate = Infinity;
  const limit = Math.round(120 / DT);
  for (;;) {
    step(main); if (sup) step(sup);
    const s = main.steps;
    if (main.taken.length < 5) {
      if (s >= gate && capture(main)) { gate = s + gapSteps; if (main.taken.length === 5) { if (!sup) break; supGate = s + gapSteps; } }
    } else if (s >= supGate && sup && capture(sup)) break;
    if (s > limit) break;
  }
  return { main: main.taken, slots: main.takenSlots, at: main.takenAt, sup: sup?.taken[0] ?? 0, supSlot: sup?.takenSlots[0] ?? -1 };
}

/** The page's plan for a night, to check the port against what the page showed. */
export function planNight(seed: number) {
  const out: { type: string; kind: string; seed: number }[] = [];
  ["baloto", "revancha"].forEach((type, k) => {
    const g = mulberry((seed * 2654435761 + k * 40503 + 17) >>> 0);
    const set = 1 + Math.floor(g() * 5), pre = 1 + Math.floor(g() * 5);
    for (let i = 0; i < pre; i++) out.push({ type, kind: "pre", seed: Math.floor(g() * 4294967296) + set });
    out.push({ type, kind: "oficial", seed: Math.floor(g() * 4294967296) + set });
  });
  return out;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "check") {
    // The page's own script (physics and night plan, cut out of the HTML beside this file) against this
    // port, in whichever engine is running, on the page's night 577775. They must agree draw for draw.
    // Across engines they do not: Bun, Node and Chromium differ in the last bit of sin, cos and exp, and
    // a last bit is enough to change every ball — the same sensitivity the page's twin machine shows.
    const html = readFileSync(new URL("./balotera-simulada.html", import.meta.url), "utf8");
    const from = html.indexOf("const G = 9.81"), to = html.indexOf("// ---------- page state");
    const page = new Function(html.slice(from, to) + "\nreturn { makeMachine, stepMachine, planNight };")() as {
      makeMachine: (shape: string, seed: number, nudge: number) => { done: boolean; main: { steps: number; taken: number[] }; sup: { taken: number[] } };
      stepMachine: (m: unknown) => void;
      planNight: (seed: number) => { plan: { seed: number }[] };
    };
    const pageDraw = (seed: number, nudge = 0) => {
      const m = page.makeMachine("esfera", seed, nudge);
      while (!m.done && m.main.steps < 600000) page.stepMachine(m);
      return `${m.main.taken.join(" ")} + ${m.sup.taken[0]}`;
    };
    const plan = planNight(577775), pagePlan = page.planNight(577775).plan;
    let same = 0;
    plan.forEach((d, i) => {
      const r = draw(d.seed), mine = `${r.main.join(" ")} + ${r.sup}`, theirs = pageDraw(pagePlan[i]!.seed);
      if (mine === theirs && d.seed === pagePlan[i]!.seed) same++;
      console.log(mine === theirs ? "same" : "DIFF", "| page:", theirs, "| port:", mine);
    });
    const twin = draw(plan[2]!.seed, { nudge: 1e-9 }), twinMine = `${twin.main.join(" ")} + ${twin.sup}`, twinPage = pageDraw(pagePlan[2]!.seed, 1e-9);
    console.log(twinMine === twinPage ? "same" : "DIFF", "| twin, page:", twinPage, "| port:", twinMine);
    const t0 = performance.now(); for (let i = 0; i < 10; i++) draw(1000 + i);
    console.log(`${same} of ${plan.length} draws identical; ${((performance.now() - t0) / 10).toFixed(0)} ms per draw`);
    if (same !== plan.length || twinMine !== twinPage) process.exit(1);
  } else if (cmd === "run") {
    const [name, from, to, out, mix = "2.5", shape = "esfera", ...masses] = rest;
    const mass = new Map<number, number>(masses.map((m) => m.split(":").map(Number) as [number, number]));
    writeFileSync(out!, "");
    let buf = "";
    for (let i = Number(from); i < Number(to); i++) {
      const r = draw((i * 2654435761 + 12345) >>> 0, { mix: Number(mix), shape: shape as Shape, mass: mass.size ? mass : undefined, skipSuper: mass.size > 0 });
      buf += JSON.stringify({ e: name, i, m: r.main, s: r.slots, a: r.at, b: r.sup, bs: r.supSlot }) + "\n";
      if (i % 200 === 199) { appendFileSync(out!, buf); buf = ""; }
    }
    appendFileSync(out!, buf);
  }
}
