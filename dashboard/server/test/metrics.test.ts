import { describe, expect, it } from 'vitest';
import { bucketDelta, deriveMetrics, histogramQuantile, parsePrometheus, parseSnapshot } from '../src/metrics.js';
import type { MetricsSnapshot } from '../src/bench/types.js';

const TEXT = `# HELP bench_http_requests_total Requests
# TYPE bench_http_requests_total counter
bench_http_requests_total{route="/bench/ping",status="200"} 100
bench_http_requests_total{route="/bench/ping",status="503"} 4
bench_http_requests_total{route="/v1/chat",status="200"} 6
bench_http_requests_total{route="/metrics",status="200"} 50
bench_http_requests_total{route="/healthz",status="500"} 3
bench_http_request_duration_seconds_bucket{route="/bench/ping",le="0.005"} 90
bench_http_request_duration_seconds_bucket{route="/bench/ping",le="0.01"} 104
bench_http_request_duration_seconds_bucket{route="/bench/ping",le="+Inf"} 104
bench_http_request_duration_seconds_bucket{route="/v1/chat",le="0.005"} 0
bench_http_request_duration_seconds_bucket{route="/v1/chat",le="0.01"} 0
bench_http_request_duration_seconds_bucket{route="/v1/chat",le="+Inf"} 6
bench_http_request_duration_seconds_bucket{route="/metrics",le="0.005"} 50
bench_http_request_duration_seconds_bucket{route="/metrics",le="0.01"} 50
bench_http_request_duration_seconds_bucket{route="/metrics",le="+Inf"} 50
bench_http_request_duration_seconds_sum{route="/bench/ping"} 0.3
bench_runtime_threads{pid="11"} 7
bench_runtime_threads{pid="12"} 9
bench_db_pool_in_use 3
bench_cgroup_cpu_usage_seconds_total{pid="11"} 12.5
bench_cgroup_cpu_usage_seconds_total{pid="12"} 12.5
bench_cgroup_cpu_throttled_seconds_total 0.25
bench_cgroup_memory_bytes 104857600
process_cpu_seconds_total 1.5e+01 1700000000000
`;

describe('parsePrometheus', () => {
  it('parses names, labels, values, timestamps and skips comments', () => {
    const s = parsePrometheus(TEXT);
    expect(s.find((x) => x.name === 'process_cpu_seconds_total')?.value).toBe(15);
    expect(s.filter((x) => x.name === 'bench_http_requests_total')).toHaveLength(5);
    const inf = s.find((x) => x.labels.le === '+Inf');
    expect(inf?.labels.route).toBe('/bench/ping');
  });

  it('handles escaped label values and spacing', () => {
    const s = parsePrometheus('m{a="x\\"y,z",b="line\\nbreak" , } 1\nn 2\n');
    expect(s[0].labels).toEqual({ a: 'x"y,z', b: 'line\nbreak' });
    expect(s[1]).toEqual({ name: 'n', labels: {}, value: 2 });
  });
});

describe('parseSnapshot', () => {
  it('aggregates per contract and ignores /metrics and /healthz', () => {
    const snap = parseSnapshot(TEXT, 1000);
    expect(snap.requestsTotal).toBe(110);
    expect(snap.errorsTotal).toBe(4);
    expect(snap.threads).toBe(16);
    expect(snap.dbPoolInUse).toBe(3);
    // multiprocess duplicates of whole-container counters are not summed
    expect(snap.cgroupCpuSeconds).toBe(12.5);
    expect(snap.cgroupThrottledSeconds).toBe(0.25);
    expect(snap.cgroupMemoryBytes).toBe(104857600);
    expect(snap.durationBuckets).toEqual([
      { le: 0.005, count: 90 },
      { le: 0.01, count: 104 },
      { le: Infinity, count: 110 },
    ]);
  });

  it('returns nulls for missing metrics', () => {
    const snap = parseSnapshot('', 1);
    expect(snap).toMatchObject({ requestsTotal: null, errorsTotal: null, threads: null, durationBuckets: null, cgroupCpuSeconds: null });
  });
});

describe('histogramQuantile', () => {
  const b = [
    { le: 0.1, count: 50 },
    { le: 0.2, count: 90 },
    { le: 0.5, count: 100 },
    { le: Infinity, count: 100 },
  ];
  it('interpolates linearly within the bucket', () => {
    expect(histogramQuantile(0.5, b)).toBeCloseTo(0.1);
    expect(histogramQuantile(0.25, b)).toBeCloseTo(0.05);
    expect(histogramQuantile(0.7, b)).toBeCloseTo(0.15);
    expect(histogramQuantile(0.95, b)).toBeCloseTo(0.35);
  });
  it('returns the highest finite bound when the rank falls in +Inf', () => {
    expect(histogramQuantile(0.99, [{ le: 0.1, count: 1 }, { le: Infinity, count: 100 }])).toBe(0.1);
  });
  it('null for empty histograms', () => {
    expect(histogramQuantile(0.5, [{ le: 0.1, count: 0 }, { le: Infinity, count: 0 }])).toBeNull();
    expect(histogramQuantile(0.5, [])).toBeNull();
  });
});

describe('bucketDelta', () => {
  it('subtracts per bucket and detects resets', () => {
    expect(bucketDelta([{ le: 1, count: 2 }], [{ le: 1, count: 5 }])).toEqual([{ le: 1, count: 3 }]);
    expect(bucketDelta([{ le: 1, count: 9 }], [{ le: 1, count: 5 }])).toBeNull();
    expect(bucketDelta(null, [{ le: 1, count: 5 }])).toBeNull();
  });
});

describe('deriveMetrics', () => {
  const base: MetricsSnapshot = {
    ts: 10_000,
    cgroupCpuSeconds: 100,
    cgroupThrottledSeconds: 1,
    cgroupMemoryBytes: 200 * 1048576,
    requestsTotal: 1000,
    errorsTotal: 10,
    threads: 5,
    dbPoolInUse: 1,
    durationBuckets: [
      { le: 0.001, count: 500 },
      { le: 0.01, count: 1000 },
      { le: Infinity, count: 1000 },
    ],
  };
  it('computes rates, error ratio, quantiles, cpu and throttling from deltas', () => {
    const cur: MetricsSnapshot = {
      ...base,
      ts: 12_000,
      cgroupCpuSeconds: 103, // 3 cpu-seconds over 2 s → 150 %
      cgroupThrottledSeconds: 1.2, // 0.2 s over 2 s → 10 %
      requestsTotal: 3000,
      errorsTotal: 30,
      durationBuckets: [
        { le: 0.001, count: 1500 },
        { le: 0.01, count: 3000 },
        { le: Infinity, count: 3000 },
      ],
    };
    const d = deriveMetrics(base, cur);
    expect(d.rps).toBe(1000);
    expect(d.err_rate).toBe(0.01);
    expect(d.p50_ms).toBe(1);
    expect(d.p99_ms).toBeCloseTo(9.82, 2);
    expect(d.cpu_pct).toBe(150);
    expect(d.throttled_pct).toBe(10);
    expect(d.mem_mb).toBe(200);
  });
  it('first sample only yields memory', () => {
    const d = deriveMetrics(null, base);
    expect(d.rps).toBeNull();
    expect(d.mem_mb).toBe(200);
  });
  it('counter reset (server restart) yields nulls, not negatives', () => {
    const d = deriveMetrics(base, { ...base, ts: 11_000, requestsTotal: 5, cgroupCpuSeconds: 1, durationBuckets: [{ le: Infinity, count: 5 }] });
    expect(d.rps).toBeNull();
    expect(d.cpu_pct).toBeNull();
    expect(d.p99_ms).toBeNull();
  });
  it('idle interval: rps 0, err_rate 0, no quantiles', () => {
    const d = deriveMetrics(base, { ...base, ts: 11_000 });
    expect(d.rps).toBe(0);
    expect(d.err_rate).toBe(0);
    expect(d.p50_ms).toBeNull();
  });
});
