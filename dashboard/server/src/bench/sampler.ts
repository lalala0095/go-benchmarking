// 1 Hz sampler for one (target, rep) measurement window: server /metrics + platform container
// stats (+ replicas on k8s) → run_samples rows, live `progress` events and resource aggregates.
import type { ContainerStats, RunSample, Target } from '../../../shared/api.js';
import type { Platform } from '../platform/types.js';
import type { MetricsSnapshot } from './types.js';
import { bucketDelta, cpuPctFromDelta, histogramQuantile, max, mean, round, throttledPct } from './analyze.js';
import type { SecondStats } from './chatRunner.js';

const MiB = 1024 * 1024;

export interface SamplerOptions {
  platform: Platform;
  scrapeMetrics: (t: Target) => Promise<MetricsSnapshot | null>;
  target: Target;
  rep: number;
  /** CPU limit of the dashboard container (cores), to express its CPU as % of its limit. */
  dashboardCpuLimit: number | null;
  /** Client-side per-second stats (chat runner). sec = 0-based second since start. */
  clientSecond?: (sec: number) => SecondStats | null;
  onSample?: (s: RunSample) => void;
  intervalMs?: number;
}

export interface SamplerSummary {
  wall_s: number;
  cpu_avg_pct: number | null;
  cpu_max_pct: number | null;
  cpu_throttled_pct: number | null;
  mem_avg_mb: number | null;
  mem_max_mb: number | null;
  max_replicas: number | null;
  avg_replicas: number | null;
  dashboard_cpu_avg_pct: number | null;   // % of the dashboard's CPU limit
  dashboard_cpu_max_pct: number | null;
  server_requests: number | null;         // from bench_http_requests_total delta
  server_errors: number | null;
  /** Counter resets seen (the target restarted during the window). */
  counter_resets: number;
}

async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pure per-tick computation (exported for tests). */
export function computeSample(
  target: Target, rep: number, tOffset: number,
  prev: MetricsSnapshot | null, cur: MetricsSnapshot | null,
  stats: ContainerStats | null, replicas: number | null, client: SecondStats | null,
): RunSample {
  const dt = prev && cur ? (cur.ts - prev.ts) / 1000 : 0;
  const d = (a: number | null | undefined, b: number | null | undefined) =>
    typeof a === 'number' && typeof b === 'number' && b >= a ? b - a : null;
  const multi = (replicas ?? 1) > 1; // a scrape hits one pod only; use summed pod stats instead
  let cpu: number | null = null;
  let mem: number | null = null;
  if (!multi && dt > 0) cpu = cpuPctFromDelta(d(prev?.cgroupCpuSeconds, cur?.cgroupCpuSeconds), dt);
  if (cpu === null) cpu = stats?.cpu_pct ?? null;
  if (!multi && typeof cur?.cgroupMemoryBytes === 'number') mem = cur.cgroupMemoryBytes / MiB;
  if (mem === null) mem = stats?.mem_mb ?? null;

  let rps: number | null = null;
  let p50: number | null = null;
  let p99: number | null = null;
  let errors: number | null = null;
  if (client) {
    ({ rps } = client); p50 = client.p50_ms; p99 = client.p99_ms; errors = client.errors;
  } else if (dt > 0) {
    const dr = d(prev?.requestsTotal, cur?.requestsTotal);
    rps = dr === null ? null : dr / dt;
    const de = d(prev?.errorsTotal, cur?.errorsTotal);
    errors = de === null ? null : Math.round(de);
    const db = bucketDelta(prev?.durationBuckets ?? null, cur?.durationBuckets ?? null);
    if (db) {
      const sec = db.map((b) => ({ le: b.le, count: b.count }));
      const q50 = histogramQuantile(0.5, sec);
      const q99 = histogramQuantile(0.99, sec);
      p50 = q50 === null ? null : q50 * 1000; // bucket bounds are seconds
      p99 = q99 === null ? null : q99 * 1000;
    }
  }
  return {
    target, rep, t_offset_s: tOffset,
    rps: round(rps, 2), lat_p50_ms: round(p50), lat_p99_ms: round(p99), errors,
    cpu_pct: round(cpu, 2), mem_mb: round(mem, 2),
    threads: cur?.threads ?? null, db_pool_in_use: cur?.dbPoolInUse ?? null, replicas,
  };
}

export class Sampler {
  readonly samples: RunSample[] = [];
  private prev: MetricsSnapshot | null = null;
  private last: MetricsSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private k = 0;
  private t0 = 0;
  private stopped = false;
  private readonly dash: number[] = [];
  // Accumulated over consecutive snapshot pairs; intervals with a counter reset are skipped.
  private acc = { span: 0, cpu: 0, cpuSpan: 0, thr: 0, thrSpan: 0, req: 0, reqSpan: 0, err: 0, resets: 0 };

  constructor(private readonly o: SamplerOptions) {}

  async start(): Promise<void> {
    this.t0 = Date.now();
    this.prev = this.last = await within(this.o.scrapeMetrics(this.o.target), 2000);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    const interval = this.o.intervalMs ?? 1000;
    const next = this.t0 + (this.k + 1) * interval;
    this.timer = setTimeout(() => {
      this.k++;
      if (!this.running) this.running = this.tick(this.k).finally(() => { this.running = null; });
      this.schedule();
    }, Math.max(0, next - Date.now()));
  }

  private async tick(k: number): Promise<void> {
    const { platform, target } = this.o;
    const [m, st, dash, reps] = await Promise.all([
      within(this.o.scrapeMetrics(target), 900),
      within(platform.containerStats(target), 900),
      within(platform.containerStats('dashboard'), 900),
      platform.mode === 'k8s' ? within(platform.replicas(target), 900) : Promise.resolve(null),
    ]);
    if (this.stopped) return;
    const client = this.o.clientSecond ? this.o.clientSecond(k - 1) : null;
    const s = computeSample(target, this.o.rep, k, this.prev, m, st, reps, client);
    if (m) { this.accumulate(this.prev, m); this.prev = m; this.last = m; }
    if (dash?.cpu_pct != null) {
      this.dash.push(this.o.dashboardCpuLimit ? dash.cpu_pct / this.o.dashboardCpuLimit : dash.cpu_pct);
    }
    this.samples.push(s);
    this.o.onSample?.(s);
  }

  private accumulate(prev: MetricsSnapshot | null, cur: MetricsSnapshot): void {
    if (!prev) return;
    const dt = (cur.ts - prev.ts) / 1000;
    if (!(dt > 0)) return;
    const a = this.acc;
    const reset = (x: number | null, y: number | null) => typeof x === 'number' && typeof y === 'number' && y < x;
    if (reset(prev.requestsTotal, cur.requestsTotal) || reset(prev.cgroupCpuSeconds, cur.cgroupCpuSeconds)) { a.resets++; return; }
    a.span += dt;
    if (typeof prev.cgroupCpuSeconds === 'number' && typeof cur.cgroupCpuSeconds === 'number') { a.cpu += cur.cgroupCpuSeconds - prev.cgroupCpuSeconds; a.cpuSpan += dt; }
    if (typeof prev.cgroupThrottledSeconds === 'number' && typeof cur.cgroupThrottledSeconds === 'number' && cur.cgroupThrottledSeconds >= prev.cgroupThrottledSeconds) {
      a.thr += cur.cgroupThrottledSeconds - prev.cgroupThrottledSeconds; a.thrSpan += dt;
    }
    if (typeof prev.requestsTotal === 'number' && typeof cur.requestsTotal === 'number') { a.req += cur.requestsTotal - prev.requestsTotal; a.reqSpan += dt; }
    if (typeof prev.errorsTotal === 'number' && typeof cur.errorsTotal === 'number' && cur.errorsTotal >= prev.errorsTotal) a.err += cur.errorsTotal - prev.errorsTotal;
  }

  async stop(): Promise<SamplerSummary> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await this.running.catch(() => {});
    const end = await within(this.o.scrapeMetrics(this.o.target), 2000);
    if (end) { this.accumulate(this.prev, end); this.last = end; }
    const wall = (Date.now() - this.t0) / 1000;
    const reps = this.samples.map((s) => s.replicas);
    const multi = (max(reps) ?? 1) > 1;
    const a = this.acc;
    let cpuAvg = !multi && a.cpuSpan > 0 ? cpuPctFromDelta(a.cpu, a.cpuSpan) : null;
    if (cpuAvg === null) cpuAvg = mean(this.samples.map((s) => s.cpu_pct));
    const thr = !multi && a.thrSpan > 0 ? throttledPct(a.thr, a.thrSpan) : null;
    return {
      wall_s: wall,
      cpu_avg_pct: round(cpuAvg, 2),
      cpu_max_pct: round(max(this.samples.map((s) => s.cpu_pct)), 2),
      cpu_throttled_pct: round(thr, 2),
      mem_avg_mb: round(mean(this.samples.map((s) => s.mem_mb)), 2),
      mem_max_mb: round(max(this.samples.map((s) => s.mem_mb)), 2),
      max_replicas: max(reps),
      avg_replicas: round(mean(reps), 2),
      dashboard_cpu_avg_pct: round(mean(this.dash), 2),
      dashboard_cpu_max_pct: round(max(this.dash), 2),
      server_requests: a.reqSpan > 0 ? a.req : null,
      server_errors: a.reqSpan > 0 ? a.err : null,
      counter_resets: a.resets,
    };
  }
}
