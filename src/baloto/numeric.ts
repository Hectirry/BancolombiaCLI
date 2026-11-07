/**
 * Special functions the Baloto statistics lean on, in one place so that a
 * constant such as the simultaneous normal quantile is *computed* rather than
 * typed in — the 2026-10-04 audit found a typed-in quantile that was off by
 * two per cent in the tail width.
 *
 * Everything here is deterministic and good to roughly 1e-12 except where a
 * comment says otherwise.
 */

/** log Γ(x) by the Lanczos approximation (g = 7, n = 9); |error| < 1e-13 for x > 0.5. */
export function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log C(n, k), exact in the sense of being a sum of logs (no overflow). */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let r = 0;
  for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
  return r;
}

/** Lentz's continued fraction for the incomplete beta (Numerical Recipes `betacf`). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAXIT = 400;
  const EPS = 1e-15;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b) = P(Beta(a, b) ≤ x). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(logBt);
  // Use the fraction on whichever side converges fast, and its complement on the other.
  return x < (a + 1) / (a + b + 2)
    ? (bt * betaContinuedFraction(a, b, x)) / a
    : 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Quantile of Beta(a, b): the x with I_x(a, b) = p. Safeguarded Newton from
 * the normal approximation, falling back to bisection steps when Newton
 * leaves the bracket. Accurate to about 1e-12 in x.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  let lo = 0;
  let hi = 1;
  let x = Math.min(1 - 1e-9, Math.max(1e-9, mean + normalQuantile(p) * sd));
  const logB = logGamma(a) + logGamma(b) - logGamma(a + b);
  for (let i = 0; i < 100; i++) {
    const f = betaCdf(x, a, b) - p;
    if (f < 0) lo = x;
    else hi = x;
    if (Math.abs(f) < 1e-15) break;
    const logPdf = (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logB;
    let next = x - f / Math.exp(logPdf);
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - x) < 1e-14) {
      x = next;
      break;
    }
    x = next;
  }
  return x;
}

/**
 * Standard normal CDF. Abramowitz & Stegun 26.2.17: |error| < 7.5e-8, which
 * is ample for a threshold and far below any Monte Carlo resolution here.
 */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - tail : tail;
}

/** Standard normal density. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal quantile Φ⁻¹(p): Acklam's rational approximation, relative
 * error below 1.2e-9 over the whole open interval. (Refining it by Newton on
 * the 7.5e-8-accurate `normalCdf` would make it *worse* — about 1.4e-5 in z
 * at 2.96 sigma — so it is not done.)
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let z: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    z = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    z = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    z = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  return z;
}

/**
 * Distribution of the number of successes among independent Bernoulli trials
 * with probabilities `probs` (the Poisson-binomial), by the usual O(n²)
 * recursion. Reduces to the binomial when every probability is equal.
 */
export function poissonBinomialPmf(probs: number[]): number[] {
  const dist = new Array<number>(probs.length + 1).fill(0);
  dist[0] = 1;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!;
    for (let k = i + 1; k > 0; k--) dist[k] = dist[k]! * (1 - p) + dist[k - 1]! * p;
    dist[0] = dist[0]! * (1 - p);
  }
  return dist;
}
