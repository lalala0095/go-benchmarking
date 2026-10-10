import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../../shared/api.js';
import {
  bucketDelta, cpuPctFromDelta, cvPct, deltas, histogram, histogramQuantile, latencyStats, mean, median,
  pctChange, percentile, rpsPer100Mb, rpsPerCore, stddevPop, summarize, summaryRow, suspectReasons, throttledPct,
} from './analyze.js';

function result(p: Partial<RunResult>): RunResult {
  return {
    target: 'go', rep: 1, order_in_rep: 1, requests_total: 1000, errors_total: 0, status_counts: { '200': 1000 },
    duration_s: 10, rps: 100, lat_p50_ms: 1, lat_p90_ms: 2, lat_p95_ms: 3, lat_p99_ms: 4, lat_max_ms: 5, lat_mean_ms: 1.5,
    ttft_p50_ms: null, ttft_p99_ms: null, overhead_p50_ms: null, overhead_p99_ms: null,
    cpu_avg_pct: 50, cpu_max_pct: 80, cpu_throttled_pct: 0, mem_avg_mb: 100, mem_max_mb: 120,
    rps_per_core: 50, rps_per_100mb: 100, max_replicas: null, rollout_errors: null, latency_histogram: null, ...p,
  };
}

describe('percentile / mean / median', () => {
  it('interpolates linearly between ranks (numpy linear)', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBeCloseTo(5.5);
    expect(percentile(xs, 90)).toBeCloseTo(9.1);
    expect(percentile(xs, 99)).toBeCloseTo(9.91);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(10);
  });
  it('is order independent and ignores non-finite values', () => {
    expect(percentile([10, 1, NaN, 5], 50)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 99)).toBe(7);
  });
  it('median/mean handle nulls', () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mean([2, null, 4])).toBe(3);
    expect(mean([null])).toBeNull();
  });
  it('latencyStats', () => {
    const s = latencyStats([4, 1, 3, 2]);
    expect(s.p50).toBe(2.5);
    expect(s.max).toBe(4);
    expect(s.mean).toBe(2.5);
  });
});

describe('variance', () => {
  it('stddevPop and CV match SQL stddev_pop/avg*100', () => {
    expect(stddevPop([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    expect(cvPct([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(40);
    expect(cvPct([100])).toBeNull();
    expect(cvPct([0, 0])).toBeNull();
    expect(cvPct([100, 100, 100])).toBe(0);
  });
});

describe('histograms', () => {
  it('buckets values with le semantics and trims empty edges', () => {
    const h = histogram([0.9, 1, 1.5, 2, 2.1, 100], [1, 2, 5, 10, Infinity]);
    expect(h).toEqual([
      { le_ms: 1, count: 2 },
      { le_ms: 2, count: 2 },
      { le_ms: 5, count: 1 },
      { le_ms: 10, count: 0 },
      { le_ms: 100, count: 1 }, // overflow bucket labelled with the max observed value
    ]);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(6);
  });
  it('histogramQuantile interpolates like Prometheus', () => {
    const b = [{ le: 0.1, count: 50 }, { le: 0.2, count: 90 }, { le: 0.5, count: 100 }, { le: Infinity, count: 100 }];
    expect(histogramQuantile(0.5, b)).toBeCloseTo(0.1);
    expect(histogramQuantile(0.7, b)).toBeCloseTo(0.15);
    expect(histogramQuantile(0.99, b)).toBeCloseTo(0.2 + 0.3 * 0.9);
    expect(histogramQuantile(0.5, [{ le: 1, count: 0 }])).toBeNull();
    // all observations in +Inf → highest finite bound
    expect(histogramQuantile(0.5, [{ le: 1, count: 0 }, { le: Infinity, count: 5 }])).toBe(1);
  });
  it('bucketDelta subtracts cumulative snapshots and detects resets', () => {
    const a = [{ le: 0.1, count: 10 }, { le: Infinity, count: 20 }];
    const b = [{ le: 0.1, count: 15 }, { le: Infinity, count: 40 }];
    expect(bucketDelta(a, b)).toEqual([{ le: 0.1, count: 5 }, { le: Infinity, count: 20 }]);
    expect(bucketDelta(b, a)).toBeNull();
    expect(bucketDelta(null, b)).toBeNull();
  });
});

describe('resource math', () => {
  it('cpu% from cgroup delta (100 = one core)', () => {
    expect(cpuPctFromDelta(3, 2)).toBe(150);
    expect(cpuPctFromDelta(null, 2)).toBeNull();
    expect(cpuPctFromDelta(1, 0)).toBeNull();
    expect(cpuPctFromDelta(-1, 1)).toBeNull();
  });
  it('throttled% is capped at 100', () => {
    expect(throttledPct(0.5, 10)).toBe(5);
    expect(throttledPct(20, 10)).toBe(100);
  });
  it('rps per core / per 100 MB (TRD §7)', () => {
    expect(rpsPerCore(1000, 2)).toBe(500);
    expect(rpsPerCore(1000, null)).toBeNull();
    expect(rpsPer100Mb(1000, 50)).toBe(2000);
    expect(rpsPer100Mb(1000, 0)).toBeNull();
  });
});

describe('suspect flags', () => {
  it('flags dashboard CPU > 85%', () => {
    const r = suspectReasons({ results: [result({})], dashboardCpuPct: [40, 90] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/dashboard CPU 90%/);
  });
  it('flags error rate > 1% per target (aggregated over reps)', () => {
    const r = suspectReasons({
      results: [result({ errors_total: 15 }), result({ rep: 2, errors_total: 0 }), result({ target: 'python', errors_total: 10 })],
      dashboardCpuPct: [],
    });
    expect(r.some((x) => x.startsWith('go: error rate 0.75%'))).toBe(false);
    expect(r).toEqual([]); // go: 15/2000 = 0.75 %, python: 10/1000 = 1 % (not > 1 %)
    const r2 = suspectReasons({ results: [result({ target: 'python', errors_total: 11 })], dashboardCpuPct: [] });
    expect(r2[0]).toMatch(/^python: error rate 1.10%/);
  });
  it('flags rep CV > 10% unless skipped', () => {
    const rs = [result({ rps: 100 }), result({ rep: 2, rps: 130 }), result({ rep: 3, rps: 100 })];
    expect(suspectReasons({ results: rs, dashboardCpuPct: [] })[0]).toMatch(/go: RPS variance across reps 1\d\.\d%/);
    expect(suspectReasons({ results: rs, dashboardCpuPct: [], skipCv: true })).toEqual([]);
    const ok = [result({ rps: 100 }), result({ rep: 2, rps: 105 }), result({ rep: 3, rps: 98 })];
    expect(suspectReasons({ results: ok, dashboardCpuPct: [null] })).toEqual([]);
  });
});

describe('summary + deltas', () => {
  const rs = [
    result({ rps: 100, lat_p99_ms: 10, mem_avg_mb: 50 }),
    result({ rep: 2, rps: 120, lat_p99_ms: 8, mem_avg_mb: 52, errors_total: 10 }),
    result({ rep: 3, rps: 110, lat_p99_ms: 9, mem_avg_mb: 51 }),
    result({ target: 'python', rps: 40, lat_p99_ms: 30, mem_avg_mb: 200, overhead_p50_ms: 3 }),
    result({ target: 'python', rep: 2, rps: 44, lat_p99_ms: 25, mem_avg_mb: 210, overhead_p50_ms: 5 }),
  ];
  it('takes medians across reps', () => {
    const s = summaryRow(rs.filter((r) => r.target === 'go'));
    expect(s.rps).toBe(110);
    expect(s.p99_ms).toBe(9);
    expect(s.mem_mb).toBe(51);
    expect(s.error_pct).toBeCloseTo((10 / 3000) * 100, 3);
    expect(s.rps_cv_pct).toBeCloseTo(7.423, 2);
    expect(s.overhead_p50_ms).toBeNull();
  });
  it('computes go/python deltas with better_when', () => {
    const d = deltas(summarize(rs));
    const rps = d.find((x) => x.metric === 'rps')!;
    expect(rps).toMatchObject({ go: 110, python: 42, better: 'go', better_when: 'higher' });
    expect(rps.ratio).toBeCloseTo(110 / 42, 3);
    const p99 = d.find((x) => x.metric === 'p99_ms')!;
    expect(p99).toMatchObject({ go: 9, python: 27.5, better: 'go', better_when: 'lower' });
    const ovh = d.find((x) => x.metric === 'overhead_p50_ms')!;
    expect(ovh).toMatchObject({ go: null, python: 4, better: null, ratio: null });
    expect(d.find((x) => x.metric === 'ttft_p50_ms')).toBeUndefined(); // null on both sides
  });
  it('returns no deltas for single-target runs', () => {
    expect(deltas(summarize(rs.filter((r) => r.target === 'go')))).toEqual([]);
  });
  it('pctChange formats Go relative to Python', () => {
    expect(pctChange(412, 100)).toBe('+312%');
    expect(pctChange(29, 100)).toBe('−71%');
    expect(pctChange(1, 0)).toBe('n/a');
  });
});
