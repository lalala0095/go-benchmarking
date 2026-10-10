import { describe, expect, it } from 'vitest';
import type { MetricsSnapshot } from './types.js';
import { Sampler, computeSample } from './sampler.js';
import type { Platform } from '../platform/types.js';

const snap = (p: Partial<MetricsSnapshot>): MetricsSnapshot => ({
  ts: 0, cgroupCpuSeconds: null, cgroupThrottledSeconds: null, cgroupMemoryBytes: null, requestsTotal: null,
  errorsTotal: null, threads: null, dbPoolInUse: null, durationBuckets: null, ...p,
});

describe('computeSample', () => {
  const prev = snap({ ts: 1000, cgroupCpuSeconds: 10, requestsTotal: 1000, errorsTotal: 1, durationBuckets: [{ le: 0.001, count: 100 }, { le: 0.01, count: 200 }, { le: Infinity, count: 200 }] });
  const cur = snap({
    ts: 2000, cgroupCpuSeconds: 11.5, cgroupMemoryBytes: 150 * 1024 * 1024, requestsTotal: 1500, errorsTotal: 3, threads: 12, dbPoolInUse: 4,
    durationBuckets: [{ le: 0.001, count: 350 }, { le: 0.01, count: 700 }, { le: Infinity, count: 700 }],
  });

  it('derives rps, errors, cpu, mem and quantiles from metric deltas', () => {
    const s = computeSample('go', 1, 3, prev, cur, null, null, null);
    expect(s).toMatchObject({ target: 'go', rep: 1, t_offset_s: 3, rps: 500, errors: 2, cpu_pct: 150, mem_mb: 150, threads: 12, db_pool_in_use: 4, replicas: null });
    expect(s.lat_p50_ms).toBeCloseTo(1, 3);          // 250 of 500 in the first bucket → upper bound 1 ms
    expect(s.lat_p99_ms).toBeCloseTo(1 + 9 * (245 / 250), 2);
  });

  it('prefers client-side per-second stats when provided (chat runner)', () => {
    const s = computeSample('go', 1, 1, prev, cur, null, null, { rps: 42, p50_ms: 300, p99_ms: 900, errors: 1 });
    expect(s).toMatchObject({ rps: 42, lat_p50_ms: 300, lat_p99_ms: 900, errors: 1, cpu_pct: 150 });
  });

  it('falls back to container stats without metrics and with several replicas', () => {
    const stats = { cpu_pct: 320, mem_mb: 900, mem_limit_mb: 4096 };
    expect(computeSample('python', 2, 1, null, null, stats, null, null)).toMatchObject({ cpu_pct: 320, mem_mb: 900, rps: null });
    expect(computeSample('python', 2, 1, prev, cur, stats, 3, null)).toMatchObject({ cpu_pct: 320, mem_mb: 900, replicas: 3, rps: 500 });
  });
});

describe('Sampler', () => {
  it('averages CPU over valid intervals and skips counter resets (target restart)', async () => {
    // cpu seconds per scrape: +0.5 s per 0.1 s tick (= 500%), then a restart resets the counter
    const seq = [10, 10.5, 11, 0.2, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2, 3.7];
    let i = 0;
    let ts = 0;
    const scrape = async () => {
      const v = seq[Math.min(i++, seq.length - 1)]!;
      ts += 100;
      return snap({ ts, cgroupCpuSeconds: v, requestsTotal: v * 1000, cgroupMemoryBytes: 100 * 1024 * 1024 });
    };
    const platform = { mode: 'compose', containerStats: async () => null, replicas: async () => 1 } as unknown as Platform;
    const s = new Sampler({ platform, scrapeMetrics: scrape, target: 'go', rep: 1, dashboardCpuLimit: null, intervalMs: 20 });
    await s.start();
    await new Promise((r) => setTimeout(r, 130));
    const sum = await s.stop();
    expect(sum.counter_resets).toBe(1);
    expect(sum.cpu_avg_pct).toBeCloseTo(500, 0);
    expect(sum.mem_avg_mb).toBe(100);
    expect(s.samples.length).toBeGreaterThan(2);
  });
});
