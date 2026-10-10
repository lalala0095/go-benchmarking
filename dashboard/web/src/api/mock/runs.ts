import type { Delta, Layer, PlatformMode, RunConfig, RunDetail, RunResult, RunSample, RunSummary, SummaryRow, Target } from '../../types';
import { TARGET_ORDER } from '../../types';
import { median } from '../../lib/format';
import { SCENARIOS } from './scenarios';
import { hash, jitter, normCdf, rng } from './rng';

interface Profile { rps: number; p50: number; tail: number; cpu: number; mem: number; overhead?: number; ttft?: number }
const PROFILES: Record<string, Record<Target, Profile>> = {
  ping: { go: { rps: 98000, p50: 0.58, tail: 3.2, cpu: 390, mem: 19 }, python: { rps: 14100, p50: 4.3, tail: 4.1, cpu: 395, mem: 168 } },
  json: { go: { rps: 71500, p50: 0.84, tail: 3.4, cpu: 395, mem: 22 }, python: { rps: 9800, p50: 6.3, tail: 4.4, cpu: 398, mem: 172 } },
  cpu: { go: { rps: 2140, p50: 7.4, tail: 2.1, cpu: 399, mem: 17 }, python: { rps: 412, p50: 38, tail: 2.8, cpu: 398, mem: 160 } },
  'sleep-io': { go: { rps: 4960, p50: 100.4, tail: 1.03, cpu: 38, mem: 41 }, python: { rps: 4690, p50: 104.8, tail: 1.18, cpu: 92, mem: 205 } },
  'db-read': { go: { rps: 31200, p50: 1.9, tail: 3.1, cpu: 260, mem: 28 }, python: { rps: 8150, p50: 7.6, tail: 3.9, cpu: 395, mem: 181 } },
  'db-query': { go: { rps: 9800, p50: 3.2, tail: 2.9, cpu: 300, mem: 34 }, python: { rps: 3080, p50: 10.1, tail: 3.6, cpu: 397, mem: 190 } },
  'db-write': { go: { rps: 7420, p50: 4.2, tail: 3.0, cpu: 180, mem: 30 }, python: { rps: 2610, p50: 12.0, tail: 3.5, cpu: 330, mem: 186 } },
  'chat-mock': { go: { rps: 6200, p50: 7.9, tail: 2.6, cpu: 380, mem: 64, overhead: 0.9, ttft: 3.1 }, python: { rps: 1080, p50: 45, tail: 3.4, cpu: 398, mem: 260, overhead: 6.4, ttft: 18 } },
  'chat-mock-tool': { go: { rps: 4100, p50: 12, tail: 2.7, cpu: 370, mem: 70, overhead: 1.2, ttft: 5.8 }, python: { rps: 820, p50: 60, tail: 3.3, cpu: 398, mem: 268, overhead: 7.9, ttft: 26 } },
  'chat-mock-rag': { go: { rps: 2900, p50: 17, tail: 2.6, cpu: 380, mem: 76, overhead: 1.4, ttft: 9 }, python: { rps: 640, p50: 77, tail: 3.2, cpu: 398, mem: 280, overhead: 8.6, ttft: 33 } },
  'chat-gemini': { go: { rps: 2.4, p50: 1840, tail: 1.6, cpu: 4, mem: 58, overhead: 4.2, ttft: 412 }, python: { rps: 2.3, p50: 1885, tail: 1.7, cpu: 9, mem: 252, overhead: 19, ttft: 431 } },
  'scale-out': { go: { rps: 5200, p50: 9, tail: 2.8, cpu: 340, mem: 66 }, python: { rps: 1450, p50: 52, tail: 3.6, cpu: 395, mem: 262 } },
  'cold-start': { go: { rps: 1, p50: 310, tail: 1.2, cpu: 30, mem: 12 }, python: { rps: 1, p50: 2480, tail: 1.15, cpu: 95, mem: 140 } },
};
const DEFAULT_PROFILE: Record<Target, Profile> = { go: { rps: 5000, p50: 5, tail: 3, cpu: 300, mem: 40 }, python: { rps: 1200, p50: 20, tail: 3.6, cpu: 390, mem: 190 } };

function profileFor(scenario: string): Record<Target, Profile> {
  return PROFILES[scenario] ?? PROFILES[scenario.replace(/-(vector|fts)$/, '')] ?? DEFAULT_PROFILE;
}

const BUCKETS = (() => {
  const out: number[] = [];
  for (let e = -1; e <= 4; e++) for (const m of [1, 2, 5]) out.push(m * 10 ** e);
  return out.concat([1e5]);
})();

function histogram(total: number, p50: number, p99: number) {
  const mu = Math.log(p50);
  const sigma = Math.max(0.05, (Math.log(p99) - mu) / 2.326);
  let prev = 0;
  return BUCKETS.map((le) => {
    const c = normCdf((Math.log(le) - mu) / sigma);
    const count = Math.round((c - prev) * total);
    prev = c;
    return { le_ms: le, count };
  }).filter((b) => b.count > 0);
}

export function generateDetail(summary: RunSummary): RunDetail {
  const r = rng(hash(summary.id));
  const prof = profileFor(summary.scenario);
  const cfg = summary.config;
  const dur = cfg.duration_s ?? Math.max(5, (cfg.requests ?? 50) / 2);
  const k8s = summary.layer === 'k8s';
  const results: RunResult[] = [];
  const samples: RunSample[] = [];
  const unstable = summary.suspect ? 0.18 : 0.04;

  for (let rep = 1; rep <= cfg.reps; rep++) {
    const order = rep % 2 === 1 ? TARGET_ORDER : [...TARGET_ORDER].reverse();
    order.forEach((t, i) => {
      if (!cfg.targets.includes(t)) return;
      const p = prof[t];
      const rps = jitter(r, p.rps, unstable);
      const p50 = jitter(r, p.p50, 0.05);
      const p99 = p50 * jitter(r, p.tail, 0.08);
      const cpu = jitter(r, p.cpu, 0.03);
      const mem = jitter(r, p.mem, 0.04);
      const total = Math.round(rps * dur);
      const errors = summary.suspect && t === 'python' ? Math.round(total * 0.014) : r() < 0.2 ? Math.round(r() * 3) : 0;
      results.push({
        target: t, rep, order_in_rep: i + 1,
        requests_total: total, errors_total: errors,
        status_counts: errors ? { '200': total - errors, '503': errors } : { '200': total },
        duration_s: dur, rps,
        lat_p50_ms: p50, lat_p90_ms: p50 * (1 + (p.tail - 1) * 0.35), lat_p95_ms: p50 * (1 + (p.tail - 1) * 0.55), lat_p99_ms: p99,
        lat_max_ms: p99 * jitter(r, 2.4, 0.2), lat_mean_ms: p50 * 1.15,
        ttft_p50_ms: p.ttft ?? null, ttft_p99_ms: p.ttft ? p.ttft * 2.6 : null,
        overhead_p50_ms: p.overhead ?? null, overhead_p99_ms: p.overhead ? p.overhead * 3.1 : null,
        cpu_avg_pct: cpu, cpu_max_pct: Math.min(400, cpu * 1.06), cpu_throttled_pct: cpu > 380 ? jitter(r, 6, 0.5) : jitter(r, 0.4, 0.5),
        mem_avg_mb: mem, mem_max_mb: mem * 1.12,
        rps_per_core: rps / (cpu / 100), rps_per_100mb: rps / (mem / 100),
        max_replicas: k8s ? (t === 'go' ? 2 : 4) : null, rollout_errors: summary.scenario === 'rollout-disruption' ? (t === 'go' ? 0 : 37) : null,
        latency_histogram: histogram(total, p50, p99),
      });
      const steps = Math.min(120, Math.round(dur));
      for (let s = 0; s <= steps; s++) {
        const ramp = summary.scenario === 'scale-out' || summary.scenario === 'chat-mock-burst' ? Math.min(1, (s + 1) / (steps * 0.7)) : Math.min(1, (s + 1) / 2);
        const replicas = k8s ? Math.min(t === 'go' ? 2 : 4, 1 + Math.floor((s / steps) * (t === 'go' ? 2 : 4))) : null;
        const spike = summary.scenario === 'rollout-disruption' && s >= 15 && s <= 22 ? (t === 'go' ? 1.3 : 4.5) : 1;
        samples.push({
          target: t, rep, t_offset_s: s,
          rps: jitter(r, rps * ramp, 0.06),
          lat_p50_ms: jitter(r, p50, 0.08) * spike,
          lat_p99_ms: jitter(r, p99, 0.12) * spike,
          errors: spike > 2 ? Math.round(r() * 8) : 0,
          cpu_pct: jitter(r, cpu * ramp, 0.05),
          mem_mb: mem * (0.85 + 0.15 * Math.min(1, s / 5)) * jitter(r, 1, 0.01),
          threads: t === 'go' ? Math.round(jitter(r, cfg.concurrency * 1.1 + 12, 0.1)) : Math.round(jitter(r, 18 + cfg.concurrency * 0.2, 0.1)),
          db_pool_in_use: summary.layer === 'L2' || summary.layer === 'L3' ? Math.round(r() * 10) : 0,
          replicas,
        });
      }
    });
  }

  const summaryRows: Partial<Record<Target, SummaryRow>> = {};
  for (const t of cfg.targets) {
    const rs = results.filter((x) => x.target === t);
    const rpsVals = rs.map((x) => x.rps);
    const m = median(rpsVals) ?? 0;
    const sd = Math.sqrt(rpsVals.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, rpsVals.length));
    summaryRows[t] = {
      rps: median(rpsVals),
      p50_ms: median(rs.map((x) => x.lat_p50_ms)),
      p99_ms: median(rs.map((x) => x.lat_p99_ms)),
      mem_mb: median(rs.map((x) => x.mem_max_mb)),
      cpu_pct: median(rs.map((x) => x.cpu_avg_pct)),
      overhead_p50_ms: median(rs.map((x) => x.overhead_p50_ms)),
      ttft_p50_ms: median(rs.map((x) => x.ttft_p50_ms)),
      rps_per_core: median(rs.map((x) => x.rps_per_core)),
      rps_per_100mb: median(rs.map((x) => x.rps_per_100mb)),
      error_pct: median(rs.map((x) => (x.errors_total / Math.max(1, x.requests_total)) * 100)),
      rps_cv_pct: m ? (sd / m) * 100 : null,
    };
  }
  const metrics: [keyof SummaryRow, 'lower' | 'higher'][] = [
    ['rps', 'higher'], ['p50_ms', 'lower'], ['p99_ms', 'lower'], ['mem_mb', 'lower'], ['cpu_pct', 'lower'],
    ['rps_per_core', 'higher'], ['rps_per_100mb', 'higher'], ['overhead_p50_ms', 'lower'], ['ttft_p50_ms', 'lower'], ['error_pct', 'lower'],
  ];
  const deltas: Delta[] = metrics.map(([metric, better_when]) => {
    const go = summaryRows.go?.[metric] ?? null;
    const python = summaryRows.python?.[metric] ?? null;
    const ratio = go !== null && python ? go / python : null;
    const better: Target | null = ratio === null || ratio === 1 ? null : (better_when === 'lower') === ratio < 1 ? 'go' : 'python';
    return { metric, go, python, ratio, better, better_when };
  });

  return {
    run: {
      ...summary,
      environment: { git_sha: '3f9c2ab', host: 'ubuntu-bench (8 vCPU)', go_version: 'go1.25.1', python_version: '3.13.2', platform: summary.platform },
      error: summary.status === 'failed' ? 'preflight: python target unhealthy (GET /healthz → 503)' : null,
      notes: null,
    },
    results,
    samples,
    summary: summaryRows,
    deltas,
  };
}

export function headlineOf(d: RunDetail): RunSummary['headline'] {
  const h: RunSummary['headline'] = {};
  for (const t of TARGET_ORDER) {
    const s = d.summary[t];
    if (s) h[t] = { rps: s.rps, p99_ms: s.p99_ms, mem_mb: s.mem_mb, overhead_p50_ms: s.overhead_p50_ms };
  }
  return h;
}

function layerOf(id: string): Layer {
  return SCENARIOS.find((s) => s.id === id)?.layer ?? 'L1';
}
function cfgOf(id: string, over: Partial<RunConfig> = {}): RunConfig {
  return { ...(SCENARIOS.find((s) => s.id === id)?.defaults ?? SCENARIOS[0].defaults), ...over };
}

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

function mk(id: string, scenario: string, minAgo: number, platform: PlatformMode = 'compose', extra: Partial<RunSummary> = {}): RunSummary {
  const config = cfgOf(scenario);
  return {
    id, scenario, layer: layerOf(scenario), platform, status: 'complete', suspect: false, suspect_reasons: [], config,
    created_at: iso(minAgo), started_at: iso(minAgo), finished_at: iso(minAgo - 2.5), ...extra,
  };
}

export function seedRuns(): RunSummary[] {
  const list: RunSummary[] = [
    mk('7c1e2b90-5d3a-4c2e-9a71-0f3e6d1b2a01', 'ping', 12),
    mk('a2f4d6e8-1b3c-4d5e-8f90-1a2b3c4d5e02', 'db-read', 48),
    mk('b3e5f7a9-2c4d-4e6f-9a01-2b3c4d5e6f03', 'chat-mock', 95, 'compose', { suspect: true, suspect_reasons: ['dashboard CPU peaked at 91% (> 85%)', 'python error rate 1.4% (> 1%)'] }),
    mk('c4f6a8b0-3d5e-4f70-8b12-3c4d5e6f7a04', 'chat-mock', 180, 'k8s'),
    mk('d5a7b9c1-4e6f-4081-9c23-4d5e6f7a8b05', 'chat-gemini', 240),
    mk('e6b8c0d2-5f70-4192-8d34-5e6f7a8b9c06', 'scale-out', 300, 'k8s'),
    mk('f7c9d1e3-6081-42a3-9e45-6f7a8b9c0d07', 'cpu', 420),
    mk('08dae2f4-7192-43b4-8f56-7a8b9c0d1e08', 'sleep-io', 600, 'compose', { status: 'failed', finished_at: iso(599) }),
    mk('19ebf305-82a3-44c5-9067-8b9c0d1e2f09', 'ping', 1500, 'k8s'),
    mk('2afc0416-93b4-45d6-8178-9c0d1e2f3a10', 'rollout-disruption', 1600, 'k8s'),
  ];
  for (const r of list) if (r.status === 'complete') r.headline = headlineOf(generateDetail(r));
  return list;
}
