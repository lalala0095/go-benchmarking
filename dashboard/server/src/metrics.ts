// Prometheus text parsing + derived live metrics (docs/02 §7).
import type { Target } from '../../shared/api.js';
import type { MetricsSnapshot } from './bench/types.js';
import { upstreamText } from './targets.js';

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseValue(s: string): number {
  if (s === '+Inf' || s === 'Inf') return Infinity;
  if (s === '-Inf') return -Infinity;
  if (s === 'NaN') return NaN;
  return Number(s);
}

/** Parses the Prometheus text exposition format (0.0.4). Comments/TYPE/HELP are skipped. */
export function parsePrometheus(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let i = 0;
    while (i < line.length && line[i] !== '{' && line[i] !== ' ' && line[i] !== '\t') i++;
    const name = line.slice(0, i);
    const labels: Record<string, string> = {};
    if (line[i] === '{') {
      i++;
      while (i < line.length && line[i] !== '}') {
        while (line[i] === ' ' || line[i] === ',') i++;
        if (line[i] === '}') break;
        const eq = line.indexOf('=', i);
        if (eq < 0) break;
        const key = line.slice(i, eq).trim();
        i = eq + 1;
        if (line[i] !== '"') break;
        i++;
        let val = '';
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) {
            const n = line[i + 1];
            val += n === 'n' ? '\n' : n;
            i += 2;
          } else {
            val += line[i++];
          }
        }
        i++; // closing quote
        labels[key] = val;
      }
      i++; // closing brace
    }
    const rest = line.slice(i).trim().split(/\s+/);
    if (!name || rest.length === 0 || rest[0] === '') continue;
    const value = parseValue(rest[0]);
    if (Number.isNaN(value) && rest[0] !== 'NaN') continue;
    out.push({ name, labels, value });
  }
  return out;
}

/** Routes excluded from request/latency aggregates so that the dashboard's own scraping/health checks don't count. */
const IGNORED_ROUTES = new Set(['/metrics', '/healthz']);
const routeIgnored = (l: Record<string, string>) => IGNORED_ROUTES.has(l.route ?? l.path ?? l.handler ?? '');

function sumOf(samples: Sample[], name: string, pred?: (l: Record<string, string>) => boolean): number | null {
  let found = false;
  let total = 0;
  for (const s of samples) {
    if (s.name !== name || (pred && !pred(s.labels))) continue;
    found = true;
    total += s.value;
  }
  return found ? total : null;
}

/** Whole-container gauges/counters: Python multiprocess workers may each export the same value → take max, never sum. */
function maxOf(samples: Sample[], name: string): number | null {
  let v: number | null = null;
  for (const s of samples) if (s.name === name && (v === null || s.value > v)) v = s.value;
  return v;
}

export function snapshotFromSamples(samples: Sample[], ts = Date.now()): MetricsSnapshot {
  const bucketMap = new Map<number, number>();
  for (const s of samples) {
    if (s.name !== 'bench_http_request_duration_seconds_bucket' || routeIgnored(s.labels)) continue;
    const le = parseValue(s.labels.le ?? '');
    if (Number.isNaN(le)) continue;
    bucketMap.set(le, (bucketMap.get(le) ?? 0) + s.value);
  }
  const durationBuckets = bucketMap.size
    ? [...bucketMap.entries()].sort((a, b) => a[0] - b[0]).map(([le, count]) => ({ le, count }))
    : null;
  return {
    ts,
    cgroupCpuSeconds: maxOf(samples, 'bench_cgroup_cpu_usage_seconds_total'),
    cgroupThrottledSeconds: maxOf(samples, 'bench_cgroup_cpu_throttled_seconds_total'),
    cgroupMemoryBytes: maxOf(samples, 'bench_cgroup_memory_bytes'),
    requestsTotal: sumOf(samples, 'bench_http_requests_total', (l) => !routeIgnored(l)),
    errorsTotal: sumOf(samples, 'bench_http_requests_total', (l) => !routeIgnored(l) && Number(l.status) >= 500) ??
      (sumOf(samples, 'bench_http_requests_total') !== null ? 0 : null),
    threads: sumOf(samples, 'bench_runtime_threads'),
    dbPoolInUse: sumOf(samples, 'bench_db_pool_in_use'),
    durationBuckets,
  };
}

export function parseSnapshot(text: string, ts = Date.now()): MetricsSnapshot {
  return snapshotFromSamples(parsePrometheus(text), ts);
}

/** Prometheus-style histogram_quantile over cumulative buckets (le ascending, last may be +Inf). Returns le units. */
export function histogramQuantile(q: number, buckets: { le: number; count: number }[]): number | null {
  if (buckets.length === 0) return null;
  const total = buckets[buckets.length - 1].count;
  if (!(total > 0)) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.count >= rank) {
      if (b.le === Infinity) return prevLe;
      const inBucket = b.count - prevCount;
      if (inBucket <= 0) return b.le;
      return prevLe + (b.le - prevLe) * ((rank - prevCount) / inBucket);
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}

/** Bucket-wise delta (cur - prev). Null on counter reset or layout change. */
export function bucketDelta(
  prev: { le: number; count: number }[] | null,
  cur: { le: number; count: number }[] | null,
): { le: number; count: number }[] | null {
  if (!prev || !cur) return null;
  const pm = new Map(prev.map((b) => [b.le, b.count]));
  const out: { le: number; count: number }[] = [];
  for (const b of cur) {
    const p = pm.get(b.le) ?? 0;
    if (b.count < p) return null;
    out.push({ le: b.le, count: b.count - p });
  }
  return out;
}

export interface Derived {
  rps: number | null;
  err_rate: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  cpu_pct: number | null; // 100 = one full core
  throttled_pct: number | null; // throttled time / wall time × 100
  mem_mb: number | null;
}

const round = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function counterRate(prev: number | null, cur: number | null, dtS: number): number | null {
  if (prev === null || cur === null || dtS <= 0 || cur < prev) return null;
  return (cur - prev) / dtS;
}

export function deriveMetrics(prev: MetricsSnapshot | null, cur: MetricsSnapshot): Derived {
  const mem_mb = cur.cgroupMemoryBytes === null ? null : round(cur.cgroupMemoryBytes / 1048576, 1);
  if (!prev) {
    return { rps: null, err_rate: null, p50_ms: null, p95_ms: null, p99_ms: null, cpu_pct: null, throttled_pct: null, mem_mb };
  }
  const dt = (cur.ts - prev.ts) / 1000;
  const rps = counterRate(prev.requestsTotal, cur.requestsTotal, dt);
  const eps = counterRate(prev.errorsTotal, cur.errorsTotal, dt);
  const err_rate = rps === null || eps === null ? null : rps > 0 ? Math.min(1, eps / rps) : 0;
  const delta = bucketDelta(prev.durationBuckets, cur.durationBuckets);
  const q = (x: number) => {
    const v = delta ? histogramQuantile(x, delta) : null;
    return v === null ? null : round(v * 1000, 2);
  };
  const cpuRate = counterRate(prev.cgroupCpuSeconds, cur.cgroupCpuSeconds, dt);
  const thrRate = counterRate(prev.cgroupThrottledSeconds, cur.cgroupThrottledSeconds, dt);
  return {
    rps: round(rps, 2),
    err_rate: round(err_rate, 4),
    p50_ms: q(0.5),
    p95_ms: q(0.95),
    p99_ms: q(0.99),
    cpu_pct: cpuRate === null ? null : round(cpuRate * 100, 1),
    throttled_pct: thrRate === null ? null : round(thrRate * 100, 1),
    mem_mb,
  };
}

/** Factory for BenchDeps.scrapeMetrics: GET <target>/metrics → snapshot (null on any failure). */
export function createScraper(targets: Record<Target, string>, timeoutMs = 2_000) {
  return async (t: Target): Promise<MetricsSnapshot | null> => {
    try {
      const text = await upstreamText(targets[t], '/metrics', { timeoutMs });
      return parseSnapshot(text);
    } catch {
      return null;
    }
  };
}
