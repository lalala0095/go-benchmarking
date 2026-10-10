import { describe, expect, it } from 'vitest';
import type { RunResult, RunStatus, RunStreamEvent, Target } from '../../../shared/api.js';
import type { Platform } from '../platform/types.js';
import type { BenchDeps } from './types.js';
import type { HttpClient } from './http.js';
import { Orchestrator, type StoreLike } from './orchestrator.js';
import type { ScenarioRunner } from './runners.js';

function fakeResult(t: Target, rep: number, order: number): RunResult {
  return {
    target: t, rep, order_in_rep: order, requests_total: 100, errors_total: 0, status_counts: { '200': 100 }, duration_s: 1, rps: 100,
    lat_p50_ms: 1, lat_p90_ms: 1, lat_p95_ms: 1, lat_p99_ms: 2, lat_max_ms: 3, lat_mean_ms: 1, ttft_p50_ms: null, ttft_p99_ms: null,
    overhead_p50_ms: null, overhead_p99_ms: null, cpu_avg_pct: 10, cpu_max_pct: 20, cpu_throttled_pct: 0, mem_avg_mb: 50, mem_max_mb: 60,
    rps_per_core: 50, rps_per_100mb: 200, max_replicas: null, rollout_errors: null, latency_histogram: null,
  };
}

function setup(o: { otherStack?: boolean; unhealthy?: Target; runner?: Partial<ScenarioRunner>; dashCpu?: number } = {}) {
  const statuses: RunStatus[] = [];
  const results: RunResult[] = [];
  let insertCount = 0;
  let activeInDb: string | null = null;
  const store: StoreLike = {
    failStaleRuns: async () => 0,
    activeRunId: async () => activeInDb,
    insertRun: async () => {
      if (activeInDb) throw Object.assign(new Error('dup'), { code: '23505' });
      insertCount++;
      activeInDb = `00000000-0000-0000-0000-00000000000${insertCount}`;
      return { id: activeInDb, created_at: new Date().toISOString() };
    },
    updateRun: async (_id, p) => {
      if (p.status) {
        statuses.push(p.status);
        if (['complete', 'failed', 'cancelled'].includes(p.status)) activeInDb = null;
      }
    },
    upsertEnvironment: async () => 'env-1',
    insertResult: async (_id, r) => { results.push(r); },
    insertSamples: async () => {},
    getRunDetail: async () => null,
    insertStatic: async () => {},
  };
  const platform: Platform = {
    mode: 'compose',
    info: async () => ({ mode: 'compose', host: { ncpu: 12 }, limits: { go: { cpus: 2, memory_bytes: 1e9 }, python: { cpus: 2, memory_bytes: 1e9 }, dashboard: { cpus: 4, memory_bytes: 2e9 } } }),
    containerStats: async () => null,
    restart: async () => ({ readyMs: 100 }),
    replicas: async () => 1,
    isOtherStackActive: async () => !!o.otherStack,
  };
  const http: HttpClient = {
    getJson: async <T,>(url: string) => {
      if (o.unhealthy && url.includes(o.unhealthy)) return { status: 503, body: null };
      if (url.endsWith('/v1/info')) return { status: 200, body: { impl: 'go', workers: 2, started_at: 'x' } as T };
      if (url.endsWith('/v1/rag/stats')) return { status: 200, body: { documents: 1, chunks: 5 } as T };
      return { status: 200, body: { status: 'ok' } as T };
    },
    postJson: async () => ({ status: 200, body: null }),
  };
  const deps = {
    db: {} as BenchDeps['db'], appDbs: { go: { query: async () => ({}) }, python: { query: async () => ({}) } } as unknown as BenchDeps['appDbs'],
    platform, targets: { go: 'http://go', python: 'http://python' }, contractsDir: '/contracts', reportsDir: '/reports',
    gitSha: 'abc', ohaPath: 'oha', scrapeMetrics: async () => null,
  } satisfies BenchDeps;
  const calls: string[] = [];
  const runner: ScenarioRunner = {
    warmup: async (_ctx, t) => { calls.push(`warmup:${t}`); },
    measure: async (_ctx, ts, rep, order) => {
      calls.push(`run:${ts.join('+')}:${rep}`);
      return ts.map((t, i) => ({ result: fakeResult(t, rep, ts.length > 1 ? i + 1 : order), raw: {}, samples: [], dashboardCpuPct: o.dashCpu ?? 10 }));
    },
    ...o.runner,
  };
  const orch = new Orchestrator(deps, { store, http, runnerFor: () => runner, sleep: async (_ms, signal) => { if (signal.aborted) throw new Error('x'); } });
  const events: RunStreamEvent[] = [];
  return { orch, statuses, results, calls, events, store };
}

describe('Orchestrator', () => {
  it('walks queued → preflight → running → analyzing → complete and alternates A/B each rep', async () => {
    const { orch, statuses, calls, results } = setup();
    const r = await orch.start({ scenario: 'ping', config: { reps: 3, warmup_s: 1, cooldown_s: 0, duration_s: 1 } });
    expect(r.status).toBe(201);
    const id = (r.body as { run_id: string }).run_id;
    // late subscriber: the SSE route sends currentPhase() first, then live events
    const events: RunStreamEvent[] = [orch.currentPhase(id)!];
    orch.subscribe(id, (e) => events.push(e));
    expect(orch.activeRunId()).toBe(id);
    await orch.lastExecution;
    expect(statuses).toEqual(['preflight', 'running', 'analyzing', 'complete']);
    expect(calls).toEqual([
      'warmup:go', 'run:go:1', 'warmup:python', 'run:python:1',
      'warmup:python', 'run:python:2', 'warmup:go', 'run:go:2',
      'warmup:go', 'run:go:3', 'warmup:python', 'run:python:3',
    ]);
    expect(results.map((x) => `${x.target}${x.rep}/${x.order_in_rep}`)).toEqual(['go1/1', 'python1/2', 'python2/1', 'go2/2', 'go3/1', 'python3/2']);
    const phases = events.filter((e) => e.type === 'phase').map((e) => e.type === 'phase' && `${e.status}:${e.phase}:${e.rep}:${e.target}`);
    expect(phases[0]).toMatch(/^(preflight:preflight:0:null|running:warmup:1:go)$/);
    expect(phases).toContain('running:warmup:2:python');
    expect(phases).toContain('running:run:3:python');
    expect(phases.at(-1)).toBe('analyzing:analyze:3:null');
    expect(events.at(-1)!.type).toBe('complete');
    expect(orch.activeRunId()).toBeNull();
  });

  it('returns 409 while a run is active and 400 for invalid requests', async () => {
    const { orch } = setup({ runner: { measure: (ctx) => new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted')))) } });
    expect((await orch.start({ scenario: 'nope' })).status).toBe(400);
    const a = await orch.start({ scenario: 'ping' });
    expect(a.status).toBe(201);
    const b = await orch.start({ scenario: 'ping' });
    expect(b).toMatchObject({ status: 409, body: { active_run_id: (a.body as { run_id: string }).run_id } });
    orch.cancel((a.body as { run_id: string }).run_id);
    await orch.lastExecution;
  });

  it('cancels a running run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { orch, statuses } = setup({
      runner: {
        measure: async (ctx) => {
          release();
          await new Promise<void>((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
          return [];
        },
      },
    });
    const r = await orch.start({ scenario: 'ping', config: { warmup_s: 0 } });
    const id = (r.body as { run_id: string }).run_id;
    const events: RunStreamEvent[] = [];
    orch.subscribe(id, (e) => events.push(e));
    await gate;
    expect(orch.currentPhase(id)).toMatchObject({ status: 'running', phase: 'run', rep: 1, target: 'go' });
    expect(orch.cancel(id)).toBe(true);
    await orch.lastExecution;
    expect(statuses.at(-1)).toBe('cancelled');
    expect(events.at(-1)).toEqual({ type: 'cancelled' });
    expect(orch.activeRunId()).toBeNull();
  });

  it('fails preflight when the other stack is active', async () => {
    const { orch, statuses, calls } = setup({ otherStack: true });
    const r = await orch.start({ scenario: 'ping' });
    const events: RunStreamEvent[] = [];
    orch.subscribe((r.body as { run_id: string }).run_id, (e) => events.push(e));
    await orch.lastExecution;
    expect(statuses).toEqual(['preflight', 'failed']);
    expect(calls).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'failed', error: expect.stringMatching(/other stack/) });
  });

  it('fails preflight when a selected target is unhealthy but ignores unselected ones', async () => {
    const bad = setup({ unhealthy: 'python' });
    await bad.orch.start({ scenario: 'ping' });
    await bad.orch.lastExecution;
    expect(bad.statuses.at(-1)).toBe('failed');
    const ok = setup({ unhealthy: 'python' });
    await ok.orch.start({ scenario: 'ping', config: { targets: ['go'], reps: 1, warmup_s: 0 } });
    await ok.orch.lastExecution;
    expect(ok.statuses.at(-1)).toBe('complete');
    expect(ok.calls).toEqual(['run:go:1']);
  });

  it('marks suspect when the dashboard CPU exceeds 85%', async () => {
    const s = setup({ dashCpu: 95 });
    const updates: unknown[] = [];
    const orig = s.store.updateRun;
    s.store.updateRun = async (id, p) => { updates.push(p); return orig(id, p); };
    await s.orch.start({ scenario: 'ping', config: { reps: 1, warmup_s: 0 } });
    await s.orch.lastExecution;
    expect(updates.at(-1)).toMatchObject({ status: 'complete', suspect: true });
  });

  it('runs interleaved scenarios (chat-gemini) with both targets in one phase', async () => {
    const s = setup({ runner: { interleaved: true } });
    await s.orch.start({ scenario: 'chat-gemini', confirm_gemini: true, config: { requests: 5, reps: 2 } });
    await s.orch.lastExecution;
    expect(s.calls).toEqual(['run:go+python:1', 'run:python+go:2']);
    expect(s.statuses.at(-1)).toBe('complete');
  });
});
