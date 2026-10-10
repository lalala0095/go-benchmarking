import { describe, expect, it } from 'vitest';
import type { Layer, PlatformMode, RunDetail, RunResult, Target } from '../../../shared/api.js';
import { deltas, summarize } from './analyze.js';
import { toCsv, toMarkdown } from './export.js';
import { evidence, recommendations, renderReport } from './report.js';

function res(t: Target, rep: number, p: Partial<RunResult>): RunResult {
  return {
    target: t, rep, order_in_rep: 1, requests_total: 1000, errors_total: 0, status_counts: { '200': 1000 }, duration_s: 20, rps: 100,
    lat_p50_ms: 5, lat_p90_ms: 8, lat_p95_ms: 9, lat_p99_ms: 10, lat_max_ms: 20, lat_mean_ms: 6, ttft_p50_ms: null, ttft_p99_ms: null,
    overhead_p50_ms: null, overhead_p99_ms: null, cpu_avg_pct: 100, cpu_max_pct: 150, cpu_throttled_pct: 1, mem_avg_mb: 100, mem_max_mb: 110,
    rps_per_core: 50, rps_per_100mb: 100, max_replicas: null, rollout_errors: null, latency_histogram: null, ...p,
  };
}

function detail(scenario: string, layer: Layer, platform: PlatformMode, go: Partial<RunResult>, py: Partial<RunResult>, extra: Partial<RunDetail> = {}): RunDetail {
  const results = [res('go', 1, go), res('python', 1, py)];
  const summary = summarize(results);
  return {
    run: {
      id: `${scenario}-${platform}-0000-0000-000000000000`, scenario, layer, platform, status: 'complete', suspect: false, suspect_reasons: [],
      config: { targets: ['go', 'python'], concurrency: 50, duration_s: 30, warmup_s: 5, cooldown_s: 5, reps: 1 },
      created_at: '2026-10-01T10:00:00.000Z', started_at: null, finished_at: null,
    },
    results, samples: [], summary, deltas: deltas(summary), ...extra,
  };
}

const runs: RunDetail[] = [
  detail('ping', 'L1', 'compose', { rps: 40000, lat_p99_ms: 3, mem_avg_mb: 20 }, { rps: 10000, lat_p99_ms: 12, mem_avg_mb: 120 }),
  detail('db-read', 'L2', 'compose', { rps: 20000 }, { rps: 8000 }),
  detail('chat-mock', 'L3', 'compose',
    { rps: 40, mem_avg_mb: 60, overhead_p50_ms: 1.2, cpu_avg_pct: 30 },
    { rps: 38, mem_avg_mb: 400, overhead_p50_ms: 6.5, cpu_avg_pct: 90 }),
  detail('chat-gemini', 'L4', 'compose',
    { rps: 1, lat_p50_ms: 900, overhead_p50_ms: 2, ttft_p50_ms: 400 },
    { rps: 1, lat_p50_ms: 910, overhead_p50_ms: 8, ttft_p50_ms: 410 }),
  detail('ping', 'L1', 'k8s', { rps: 30000 }, { rps: 8000 }),
  detail('scale-out', 'k8s', 'k8s', { max_replicas: 2, rps: 300 }, { max_replicas: 4, rps: 280 }, {
    samples: [
      { target: 'go', rep: 1, t_offset_s: 40, rps: 1, lat_p50_ms: 1, lat_p99_ms: 1, errors: 0, cpu_pct: 1, mem_mb: 1, threads: 1, db_pool_in_use: 1, replicas: 2 },
      { target: 'python', rep: 1, t_offset_s: 25, rps: 1, lat_p50_ms: 1, lat_p99_ms: 1, errors: 0, cpu_pct: 1, mem_mb: 1, threads: 1, db_pool_in_use: 1, replicas: 2 },
    ],
  }),
  detail('rollout-disruption', 'k8s', 'k8s', { rollout_errors: 0 }, { rollout_errors: 7 }),
];

describe('renderReport', () => {
  const md = renderReport({
    generated_at: '2026-10-10T12:00:00.000Z', git_sha: 'deadbeef', platform: 'compose', runs,
    static: [
      { target: 'go', metric: 'image_size_mb', platform: 'compose', value: 25, measured_at: 'x' },
      { target: 'python', metric: 'image_size_mb', platform: 'compose', value: 450, measured_at: 'x' },
      { target: 'go', metric: 'pod_ready_ms', platform: 'k8s', value: 1200, measured_at: 'x' },
    ],
    dx: { go: { markdown: 'Go: verbose error handling.', updated_at: 'x' }, python: { markdown: '', updated_at: 'x' } },
  });

  it('answers the three PRD §10 questions', () => {
    expect(md).toContain('## 1. How much faster or leaner is Go at each layer?');
    expect(md).toContain('## 2. Does the difference matter at our expected scale?');
    expect(md).toContain('## 3. Recommendation matrix');
    for (const row of ['Thin agent API, LLM-bound, small team', 'High-concurrency gateway / streaming fan-out',
      'Data/ML-heavy agents needing the Python ecosystem', 'Hybrid: Go gateway + Python agent workers']) {
      expect(md).toContain(`| ${row} |`);
    }
  });

  it('fills layer tables with numbers', () => {
    expect(md).toMatch(/\| ping \| compose \| 40,000 \| 10,000 \| 4\.00× \|/);
    expect(md).toContain('**L1 summary:** median Go/Python RPS ratio');
    expect(md).toContain('_No complete runs with both targets._'); // static layer
  });

  it('fills the matrix from data', () => {
    // gemini overhead gap 6 ms of ~905 ms e2e → < 5 % → Python for thin APIs
    expect(md).toMatch(/Thin agent API[^\n]*\*\*Python/);
    // chat-mock memory 60 vs 400 MB → Go for gateways, hybrid worth it
    expect(md).toMatch(/High-concurrency gateway[^\n]*\*\*Go\.\*\*/);
    expect(md).toMatch(/Hybrid[^\n]*Worth it/);
    expect(md).toContain('At **50 concurrent mock-chat users**');
  });

  it('includes a Kubernetes section when k8s runs exist', () => {
    expect(md).toContain('## 4. Kubernetes');
    expect(md).toMatch(/\| go \| 2 \| 40 \|/);
    expect(md).toMatch(/\| python \| 4 \| 25 \|/);
    expect(md).toMatch(/\| python \| 7 \|/);
    expect(md).toContain('Pod time-to-Ready (median): Go 1,200 ms');
    expect(md).toContain('### Platform cost (compose → k8s, RPS)');
    expect(md).toMatch(/\| ping \| 40,000 \| 30,000 \| −25% \|/);
  });

  it('includes static characteristics and DX notes', () => {
    expect(md).toMatch(/\| image_size_mb \| compose \| 25\.0 \| 450\.0 \|/);
    expect(md).toContain('Go: verbose error handling.');
    expect(md).toContain('_No notes._');
  });

  it('omits the k8s section without k8s runs', () => {
    const m = renderReport({ generated_at: 'x', git_sha: null, platform: 'compose', runs: runs.filter((r) => r.run.platform === 'compose'), static: [], dx: { go: { markdown: '', updated_at: '' }, python: { markdown: '', updated_at: '' } } });
    expect(m).not.toContain('## 4. Kubernetes');
  });

  it('reports insufficient data without chat runs', () => {
    const rec = recommendations(evidence(runs.filter((r) => r.run.layer === 'L1')));
    expect(rec[0]!.recommendation).toMatch(/Insufficient data/);
    expect(rec[2]!.recommendation).toMatch(/\*\*Python\.\*\*/);
  });
});

describe('exports', () => {
  it('csv has one row per result and escapes JSON cells', () => {
    const csv = toCsv(runs[0]!);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^run_id,scenario,layer,platform,status,suspect,target,rep/);
    expect(lines[1]).toContain('"{""200"":1000}"');
  });
  it('markdown contains summary and per-rep tables', () => {
    const md = toMarkdown(runs[0]!);
    expect(md).toContain('# Benchmark run: ping (L1, compose)');
    expect(md).toMatch(/\| RPS \| 40,000 \| 10,000 \| \+300% \|/);
    expect(md).toContain('## Per repetition');
  });
});
