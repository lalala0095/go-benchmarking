// Pure statistics for the benchmark engine (no I/O). Unit-tested in analyze.test.ts.
import type { Delta, PerTarget, RunResult, SummaryRow, Target } from '../../../shared/api.js';

export const SUSPECT_DASHBOARD_CPU_PCT = 85;
export const SUSPECT_ERROR_RATE = 0.01;
export const SUSPECT_REP_CV_PCT = 10;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function round(v: number | null | undefined, digits = 3): number | null {
  if (!isNum(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Percentile with linear interpolation between closest ranks (numpy "linear", p in 0..100). */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter(isNum);
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return percentileSorted(s, p);
}

export function percentileSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const w = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * w;
}

export function mean(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(values: readonly (number | null | undefined)[]): number | null {
  return percentile(values.filter(isNum), 50);
}

export function max(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  return xs.length ? Math.max(...xs) : null;
}

/** Population standard deviation (matches SQL stddev_pop used by the run_summary view). */
export function stddevPop(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  if (xs.length === 0) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** Coefficient of variation in percent (stddev_pop / mean * 100). Null for < 2 values or mean 0. */
export function cvPct(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  if (m === 0) return null;
  return (stddevPop(xs)! / m) * 100;
}

// ── Latency histograms ───────────────────────────────────────────────────
/** Fixed, log-ish bucket bounds (ms) used for client-side histograms (chat runner). */
export const HISTOGRAM_BOUNDS_MS: readonly number[] = [
  0.1, 0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750,
  1000, 1500, 2000, 3000, 5000, 7500, 10000, 20000, 30000, 60000, Infinity,
];

/** Non-cumulative histogram: count of values v with prevBound < v <= le_ms. Empty trailing buckets trimmed. */
export function histogram(values: readonly number[], bounds: readonly number[] = HISTOGRAM_BOUNDS_MS): { le_ms: number; count: number }[] {
  const counts = new Array<number>(bounds.length).fill(0);
  for (const v of values) {
    if (!isNum(v)) continue;
    let i = 0;
    while (i < bounds.length - 1 && v > bounds[i]!) i++;
    counts[i]!++;
  }
  let last = counts.length - 1;
  while (last >= 0 && counts[last] === 0) last--;
  let first = 0;
  while (first <= last && counts[first] === 0) first++;
  const out: { le_ms: number; count: number }[] = [];
  for (let i = first; i <= last; i++) {
    // JSON can't carry Infinity: represent the overflow bucket by the max observed value.
    const le = Number.isFinite(bounds[i]!) ? bounds[i]! : Math.max(...values.filter(isNum));
    out.push({ le_ms: le, count: counts[i]! });
  }
  return out;
}

/** Prometheus-style histogram_quantile over *cumulative* buckets (le in the same unit as returned).
 *  Linear interpolation inside the bucket; the +Inf bucket returns the highest finite bound. */
export function histogramQuantile(q: number, buckets: readonly { le: number; count: number }[]): number | null {
  if (!buckets.length) return null;
  const b = [...buckets].sort((x, y) => x.le - y.le);
  const total = b[b.length - 1]!.count;
  if (!(total > 0)) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const bucket of b) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) return prevLe;
      const inBucket = bucket.count - prevCount;
      if (inBucket <= 0) return bucket.le;
      return prevLe + (bucket.le - prevLe) * ((rank - prevCount) / inBucket);
    }
    prevLe = Number.isFinite(bucket.le) ? bucket.le : prevLe;
    prevCount = bucket.count;
  }
  return prevLe;
}

/** Delta between two cumulative bucket snapshots (counter reset → null). */
export function bucketDelta(
  prev: readonly { le: number; count: number }[] | null,
  cur: readonly { le: number; count: number }[] | null,
): { le: number; count: number }[] | null {
  if (!cur) return null;
  if (!prev) return null;
  const prevMap = new Map(prev.map((x) => [x.le, x.count]));
  const out: { le: number; count: number }[] = [];
  for (const c of cur) {
    const p = prevMap.get(c.le) ?? 0;
    if (c.count < p) return null;
    out.push({ le: c.le, count: c.count - p });
  }
  return out;
}

// ── Resource math ────────────────────────────────────────────────────────
/** CPU% (100 = one full core) from a cgroup cpu-seconds counter delta over wall seconds. */
export function cpuPctFromDelta(cpuSecondsDelta: number | null, wallSeconds: number): number | null {
  if (!isNum(cpuSecondsDelta) || !(wallSeconds > 0) || cpuSecondsDelta < 0) return null;
  return (cpuSecondsDelta / wallSeconds) * 100;
}

/** Throttled %: share of wall time the cgroup spent throttled (cpu.stat throttled_usec delta / wall). */
export function throttledPct(throttledSecondsDelta: number | null, wallSeconds: number): number | null {
  if (!isNum(throttledSecondsDelta) || !(wallSeconds > 0) || throttledSecondsDelta < 0) return null;
  return Math.min(100, (throttledSecondsDelta / wallSeconds) * 100);
}

export function rpsPerCore(rps: number | null, cpuLimit: number | null | undefined): number | null {
  if (!isNum(rps) || !isNum(cpuLimit) || cpuLimit <= 0) return null;
  return rps / cpuLimit;
}

/** RPS ÷ (avg_mem_MB / 100) — TRD §7. */
export function rpsPer100Mb(rps: number | null, memAvgMb: number | null): number | null {
  if (!isNum(rps) || !isNum(memAvgMb) || memAvgMb <= 0) return null;
  return rps / (memAvgMb / 100);
}

// ── Suspect flags ────────────────────────────────────────────────────────
export interface SuspectInput {
  results: Pick<RunResult, 'target' | 'rep' | 'requests_total' | 'errors_total' | 'rps'>[];
  /** Average dashboard CPU during each measured window, as % of the dashboard's CPU limit. */
  dashboardCpuPct: (number | null)[];
  /** Skip the rep-variance check (e.g. cold-start/ingest where rps is not the headline). */
  skipCv?: boolean;
}

export function suspectReasons(input: SuspectInput): string[] {
  const reasons: string[] = [];
  const dash = max(input.dashboardCpuPct);
  if (dash !== null && dash > SUSPECT_DASHBOARD_CPU_PCT) {
    reasons.push(`dashboard CPU ${dash.toFixed(0)}% > ${SUSPECT_DASHBOARD_CPU_PCT}% (load generator may be the bottleneck)`);
  }
  const byTarget = groupByTarget(input.results);
  for (const [t, rs] of byTarget) {
    const req = rs.reduce((a, r) => a + r.requests_total, 0);
    const err = rs.reduce((a, r) => a + r.errors_total, 0);
    if (req > 0 && err / req > SUSPECT_ERROR_RATE) {
      reasons.push(`${t}: error rate ${((err / req) * 100).toFixed(2)}% > ${SUSPECT_ERROR_RATE * 100}%`);
    }
    if (!input.skipCv) {
      const cv = cvPct(rs.map((r) => r.rps));
      if (cv !== null && cv > SUSPECT_REP_CV_PCT) {
        reasons.push(`${t}: RPS variance across reps ${cv.toFixed(1)}% > ${SUSPECT_REP_CV_PCT}%`);
      }
    }
  }
  return reasons;
}

function groupByTarget<T extends { target: Target }>(rows: readonly T[]): Map<Target, T[]> {
  const m = new Map<Target, T[]>();
  for (const r of rows) {
    const list = m.get(r.target) ?? [];
    list.push(r);
    m.set(r.target, list);
  }
  return m;
}

// ── Summary + deltas ─────────────────────────────────────────────────────
export function summaryRow(results: readonly RunResult[]): SummaryRow {
  const req = results.reduce((a, r) => a + r.requests_total, 0);
  const err = results.reduce((a, r) => a + r.errors_total, 0);
  return {
    rps: round(median(results.map((r) => r.rps))),
    p50_ms: round(median(results.map((r) => r.lat_p50_ms))),
    p99_ms: round(median(results.map((r) => r.lat_p99_ms))),
    mem_mb: round(median(results.map((r) => r.mem_avg_mb))),
    cpu_pct: round(median(results.map((r) => r.cpu_avg_pct))),
    overhead_p50_ms: round(median(results.map((r) => r.overhead_p50_ms))),
    ttft_p50_ms: round(median(results.map((r) => r.ttft_p50_ms))),
    rps_per_core: round(median(results.map((r) => r.rps_per_core))),
    rps_per_100mb: round(median(results.map((r) => r.rps_per_100mb))),
    error_pct: req > 0 ? round((err / req) * 100) : null,
    rps_cv_pct: round(cvPct(results.map((r) => r.rps))),
  };
}

export function summarize(results: readonly RunResult[]): PerTarget<SummaryRow> {
  const out: PerTarget<SummaryRow> = {};
  for (const [t, rs] of groupByTarget(results)) out[t] = summaryRow(rs);
  return out;
}

export const BETTER_WHEN: Record<keyof SummaryRow, 'lower' | 'higher'> = {
  rps: 'higher',
  p50_ms: 'lower',
  p99_ms: 'lower',
  mem_mb: 'lower',
  cpu_pct: 'lower',
  overhead_p50_ms: 'lower',
  ttft_p50_ms: 'lower',
  rps_per_core: 'higher',
  rps_per_100mb: 'higher',
  error_pct: 'lower',
  rps_cv_pct: 'lower',
};

/** Go-vs-Python deltas. ratio = go / python. Metrics missing on either side are omitted. */
export function deltas(summary: PerTarget<SummaryRow>): Delta[] {
  const go = summary.go;
  const py = summary.python;
  if (!go || !py) return [];
  const out: Delta[] = [];
  for (const metric of Object.keys(BETTER_WHEN) as (keyof SummaryRow)[]) {
    const g = go[metric];
    const p = py[metric];
    if (g === null && p === null) continue;
    const better_when = BETTER_WHEN[metric];
    let better: Target | null = null;
    if (isNum(g) && isNum(p) && g !== p) {
      better = better_when === 'higher' ? (g > p ? 'go' : 'python') : (g < p ? 'go' : 'python');
    }
    const ratio = isNum(g) && isNum(p) && p !== 0 ? round(g / p, 4) : null;
    out.push({ metric, go: g, python: p, ratio, better, better_when });
  }
  return out;
}

/** Human-readable relative change of Go vs Python, e.g. "+312%" / "−71%". */
export function pctChange(go: number | null, py: number | null): string {
  if (!isNum(go) || !isNum(py) || py === 0) return 'n/a';
  const pct = ((go - py) / py) * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

// ── Per-request sample aggregation (chat runner, single-shot scenarios) ───
export interface LatencyStats {
  p50: number | null; p90: number | null; p95: number | null; p99: number | null; max: number | null; mean: number | null;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  const s = values.filter(isNum).sort((a, b) => a - b);
  return {
    p50: percentileSorted(s, 50),
    p90: percentileSorted(s, 90),
    p95: percentileSorted(s, 95),
    p99: percentileSorted(s, 99),
    max: s.length ? s[s.length - 1]! : null,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
  };
}
