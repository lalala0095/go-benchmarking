// Benchmark orchestrator: one active run at a time, run protocol of docs/02 §6.
// queued → preflight → running → analyzing → complete | failed | cancelled
import type {
  PlatformInfo, PlatformMode, RunConfig, RunDetail, RunPhase, RunResult, RunSample, RunStatus, RunStreamEvent,
  ServerInfo, StartRunRequest, Target,
} from '../../../shared/api.js';
import { TARGETS } from '../../../shared/api.js';
import type { BenchDeps } from './types.js';
import { undiciHttp, type HttpClient } from './http.js';
import { CancelledError } from './oha.js';
import { resolveConfig, targetOrder, type ScenarioDef } from './scenarios.js';
import { suspectReasons } from './analyze.js';
import {
  chatRunner, coldStartRunner, httpRunner, ingestRunner, rolloutRunner, scaleOutRunner,
  type MeasureOutput, type RunCtx, type ScenarioRunner,
} from './runners.js';
import { isUniqueViolation, type EnvironmentInput, type Store } from './store.js';

export type StoreLike = Pick<Store,
  'failStaleRuns' | 'activeRunId' | 'insertRun' | 'updateRun' | 'upsertEnvironment' | 'insertResult' |
  'insertSamples' | 'getRunDetail' | 'insertStatic'>;

export type StartResult =
  | { status: 201; body: { run_id: string } }
  | { status: 409; body: { error: string; active_run_id: string | null } }
  | { status: 400; body: { error: string } };

type PhaseEvent = Extract<RunStreamEvent, { type: 'phase' }>;
type Listener = (ev: RunStreamEvent) => void;

interface ActiveRun {
  id: string;
  scenario: ScenarioDef;
  config: RunConfig;
  abort: AbortController;
  phase: PhaseEvent;
  environmentId: string | null;
}

export interface OrchestratorOptions {
  store: StoreLike;
  http?: HttpClient;
  runnerFor?: (s: ScenarioDef, o: Orchestrator) => ScenarioRunner;
  /** Abortable sleep (tests pass a fast one). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new CancelledError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Strip fields that change on every restart so equal environments dedupe by hash. */
function stableInfo(info: ServerInfo | null): Record<string, unknown> {
  if (!info) return {};
  const { started_at: _s, ...rest } = info;
  return rest;
}

export class Orchestrator {
  private active: ActiveRun | null = null;
  private starting = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly ready: Promise<void>;
  private readonly http: HttpClient;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Resolves when the background execution of the most recent run finishes (tests). */
  lastExecution: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BenchDeps, private readonly opts: OrchestratorOptions) {
    this.http = opts.http ?? undiciHttp;
    this.sleepFn = opts.sleep ?? abortableSleep;
    this.ready = opts.store.failStaleRuns().then(
      (n) => { if (n) console.warn(`[bench] marked ${n} stale active run(s) as failed`); },
      (e) => { console.error('[bench] failStaleRuns failed:', (e as Error).message); },
    );
  }

  activeRunId(): string | null { return this.active?.id ?? null; }

  currentPhase(id: string): PhaseEvent | null { return this.active?.id === id ? this.active.phase : null; }

  subscribe(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.listeners.delete(id); };
  }

  private emit(id: string, ev: RunStreamEvent): void {
    for (const fn of this.listeners.get(id) ?? []) {
      try { fn(ev); } catch { /* listener errors never break the run */ }
    }
  }

  cancel(id: string): boolean {
    if (this.active?.id !== id) return false;
    this.active.abort.abort();
    return true;
  }

  async start(req: StartRunRequest): Promise<StartResult> {
    await this.ready;
    const r = resolveConfig(req, this.deps.platform.mode);
    if (!r.ok) return { status: 400, body: { error: r.error } };
    if (this.active || this.starting) {
      return { status: 409, body: { error: 'another benchmark run is active', active_run_id: this.active?.id ?? null } };
    }
    this.starting = true;
    let id: string;
    try {
      ({ id } = await this.opts.store.insertRun({
        scenario: r.scenario.id, layer: r.scenario.layer, platform: this.deps.platform.mode,
        config: r.config, notes: typeof req.notes === 'string' ? req.notes : null,
      }));
    } catch (e) {
      this.starting = false;
      if (isUniqueViolation(e)) {
        const active = await this.opts.store.activeRunId().catch(() => null);
        return { status: 409, body: { error: 'another benchmark run is active', active_run_id: active } };
      }
      throw e;
    }
    const now = new Date().toISOString();
    this.active = {
      id, scenario: r.scenario, config: r.config, abort: new AbortController(), environmentId: null,
      phase: { type: 'phase', status: 'queued', phase: 'preflight', rep: 0, reps: r.config.reps, target: null, started_at: now },
    };
    this.starting = false;
    this.lastExecution = this.execute(this.active);
    return { status: 201, body: { run_id: id } };
  }

  private setPhase(run: ActiveRun, status: RunStatus, phase: RunPhase, rep: number, target: Target | null): void {
    run.phase = { type: 'phase', status, phase, rep, reps: run.config.reps, target, started_at: new Date().toISOString() };
    this.emit(run.id, run.phase);
  }

  private log(run: ActiveRun, level: 'info' | 'warn' | 'error', message: string): void {
    this.emit(run.id, { type: 'log', level, message });
  }

  private runnerFor(s: ScenarioDef): ScenarioRunner {
    if (this.opts.runnerFor) return this.opts.runnerFor(s, this);
    switch (s.run.kind) {
      case 'http': return httpRunner();
      case 'chat': return chatRunner(s.id === 'chat-gemini');
      case 'ingest': return ingestRunner();
      case 'cold-start': return coldStartRunner(this.opts.store, () => this.active?.environmentId ?? null);
      case 'scale-out': return scaleOutRunner();
      case 'rollout': return rolloutRunner();
    }
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { store } = this.opts;
    const signal = run.abort.signal;
    try {
      // ── preflight ──
      await store.updateRun(run.id, { status: 'preflight', started_at: new Date() });
      this.setPhase(run, 'preflight', 'preflight', 0, null);
      const pre = await this.preflight(run);

      const runner = this.runnerFor(run.scenario);
      const ctx: RunCtx = {
        runId: run.id, scenario: run.scenario, config: run.config, deps: this.deps, http: this.http, signal,
        cpuLimit: pre.cpuLimit, dashboardCpuLimit: pre.dashboardCpuLimit,
        log: (l, m) => this.log(run, l, m),
        progress: (s: RunSample) => this.emit(run.id, {
          type: 'progress', target: s.target, rep: s.rep, t_offset_s: s.t_offset_s, rps: s.rps,
          p50_ms: s.lat_p50_ms, p99_ms: s.lat_p99_ms, errors: s.errors ?? 0, cpu_pct: s.cpu_pct, mem_mb: s.mem_mb, replicas: s.replicas,
        }),
        sleep: (ms) => this.sleepFn(ms, signal),
      };
      await runner.prepare?.(ctx);

      // ── running ──
      await store.updateRun(run.id, { status: 'running' });
      const outputs: MeasureOutput[] = [];
      const cfg = run.config;
      for (let rep = 1; rep <= cfg.reps; rep++) {
        const order = targetOrder(cfg.targets, rep);
        const groups: Target[][] = runner.interleaved ? [order] : order.map((t) => [t]);
        for (let gi = 0; gi < groups.length; gi++) {
          const group = groups[gi]!;
          const label = group.length === 1 ? group[0]! : null;
          if (signal.aborted) throw new CancelledError();
          for (const t of group) await runner.beforeTarget?.(ctx, t);
          if (cfg.warmup_s > 0 && runner.warmup) {
            this.setPhase(run, 'running', 'warmup', rep, label);
            for (const t of group) await runner.warmup(ctx, t);
          }
          this.setPhase(run, 'running', 'run', rep, label);
          const outs = await runner.measure(ctx, group, rep, gi + 1);
          for (const o of outs) {
            await store.insertResult(run.id, o.result, o.raw);
            if (o.samples.length) await store.insertSamples(run.id, o.samples);
            outputs.push(o);
            this.log(run, 'info', `${o.result.target} rep ${rep}: ${o.result.rps.toFixed(1)} rps, p99 ${o.result.lat_p99_ms ?? '–'} ms, errors ${o.result.errors_total}`);
          }
          const last = rep === cfg.reps && gi === groups.length - 1;
          if (!last && cfg.cooldown_s > 0) {
            this.setPhase(run, 'running', 'cooldown', rep, label);
            await this.sleepFn(cfg.cooldown_s * 1000, signal);
          }
        }
      }
      if (signal.aborted) throw new CancelledError();

      // ── analyzing ──
      await store.updateRun(run.id, { status: 'analyzing' });
      this.setPhase(run, 'analyzing', 'analyze', cfg.reps, null);
      await runner.finish?.(ctx, outputs);
      const kind = run.scenario.run.kind;
      const reasons = suspectReasons({
        results: outputs.map((o) => o.result),
        dashboardCpuPct: outputs.map((o) => o.dashboardCpuPct),
        skipCv: kind === 'cold-start' || kind === 'scale-out' || kind === 'rollout',
      });
      for (const o of outputs) {
        if (o.resources?.counter_resets && kind !== 'rollout' && kind !== 'scale-out') {
          reasons.push(`${o.result.target} rep ${o.result.rep}: server restarted during measurement (metric counters reset)`);
        }
      }
      if (kind === 'rollout') {
        // errors are the measurement here, not a validity problem
        for (let i = reasons.length - 1; i >= 0; i--) if (reasons[i]!.includes('error rate')) reasons.splice(i, 1);
      }
      await store.updateRun(run.id, {
        status: 'complete', finished_at: new Date(), suspect: reasons.length > 0, suspect_reasons: reasons,
      });
      run.phase = { ...run.phase, status: 'complete' };
      const detail = await store.getRunDetail(run.id);
      this.emit(run.id, { type: 'complete', run: detail ?? fallbackDetail(run, this.deps.platform.mode, outputs.map((o) => o.result)) });
    } catch (e) {
      const cancelled = e instanceof CancelledError || signal.aborted;
      const message = cancelled ? 'cancelled by user' : (e as Error)?.message ?? String(e);
      await store.updateRun(run.id, {
        status: cancelled ? 'cancelled' : 'failed', finished_at: new Date(), error: cancelled ? null : message,
      }).catch((err) => console.error('[bench] could not persist terminal status:', (err as Error).message));
      run.phase = { ...run.phase, status: cancelled ? 'cancelled' : 'failed' };
      if (cancelled) this.emit(run.id, { type: 'cancelled' });
      else {
        this.log(run, 'error', message);
        this.emit(run.id, { type: 'failed', error: message });
      }
    } finally {
      if (this.active === run) this.active = null;
    }
  }

  private async preflight(run: ActiveRun): Promise<{ cpuLimit: Record<Target, number | null>; dashboardCpuLimit: number | null }> {
    const p = this.deps.platform;
    if (await p.isOtherStackActive()) {
      throw new Error(`the other stack is active (platform=${p.mode}); stop it first (make mode-${p.mode})`);
    }
    const pinfo: PlatformInfo = await p.info();
    const infos: Record<Target, ServerInfo | null> = { go: null, python: null };
    for (const t of TARGETS) {
      const selected = run.config.targets.includes(t);
      const base = this.deps.targets[t];
      try {
        const h = await this.http.getJson<{ status?: string }>(`${base}/healthz`, 5000);
        if (h.status !== 200) throw new Error(`/healthz returned ${h.status}`);
        const i = await this.http.getJson<ServerInfo>(`${base}/v1/info`, 5000);
        if (i.status !== 200 || !i.body) throw new Error(`/v1/info returned ${i.status}`);
        infos[t] = i.body;
      } catch (e) {
        if (selected) throw new Error(`${t} is not healthy at ${base}: ${(e as Error).message}`);
      }
    }
    this.log(run, 'info', `targets healthy: ${run.config.targets.join(', ')} on ${p.mode}`);

    // record the Python worker profile with the run (informational)
    if (!run.config.py_profile && infos.python) {
      run.config.py_profile = infos.python.workers > 1 ? 'py-Nw' : 'py-1w';
    }
    const env: EnvironmentInput = {
      platform: p.mode,
      git_sha: this.deps.gitSha || null,
      host_info: {
        ...pinfo.host,
        k8s: pinfo.k8s ? { node: pinfo.k8s.node, k3s_version: pinfo.k8s.k3s_version, overlay: pinfo.k8s.overlay } : undefined,
        limits: { postgres: pinfo.limits.postgres ?? null, dashboard: pinfo.limits.dashboard ?? null },
      },
      go_info: { info: stableInfo(infos.go), limits: pinfo.limits.go ?? null, image: pinfo.images?.go ?? null },
      py_info: { info: stableInfo(infos.python), limits: pinfo.limits.python ?? null, image: pinfo.images?.python ?? null },
    };
    run.environmentId = await this.opts.store.upsertEnvironment(env);
    await this.opts.store.updateRun(run.id, { environment_id: run.environmentId, config: run.config });

    await this.housekeeping(run);

    const cpuLimit: Record<Target, number | null> = { go: null, python: null };
    for (const t of TARGETS) cpuLimit[t] = pinfo.limits[t]?.cpus ?? infos[t]?.cgroup_cpu_limit ?? null;
    return { cpuLimit, dashboardCpuLimit: pinfo.limits.dashboard?.cpus ?? null };
  }

  private async housekeeping(run: ActiveRun): Promise<void> {
    const id = run.scenario.id;
    if (id === 'db-write') {
      for (const t of run.config.targets) await this.deps.appDbs[t].query('TRUNCATE app.bench_writes');
      this.log(run, 'info', 'truncated app.bench_writes');
    }
    if (id.startsWith('rag-search') || id === 'chat-mock-rag') {
      const chunks: Partial<Record<Target, number>> = {};
      for (const t of run.config.targets) {
        const base = this.deps.targets[t];
        const st = await this.http.getJson<{ documents?: number; chunks?: number }>(`${base}/v1/rag/stats`, 5000);
        if (st.status !== 200) throw new Error(`${t}: /v1/rag/stats returned ${st.status}`);
        if (!st.body?.documents) {
          this.log(run, 'info', `${t}: knowledge base empty, ingesting default corpus`);
          const r = await this.http.postJson<{ chunks?: number }>(`${base}/v1/rag/ingest`, { corpus: 'default' }, 15 * 60_000, run.abort.signal);
          if (r.status !== 200) throw new Error(`${t}: ingest returned ${r.status}`);
          chunks[t] = r.body?.chunks ?? 0;
        } else {
          chunks[t] = st.body.chunks ?? 0;
        }
      }
      if (chunks.go !== undefined && chunks.python !== undefined && chunks.go !== chunks.python) {
        this.log(run, 'warn', `knowledge bases differ: go ${chunks.go} chunks vs python ${chunks.python} chunks`);
      }
    }
  }
}

function fallbackDetail(run: ActiveRun, platform: PlatformMode, results: RunResult[]): RunDetail {
  return {
    run: {
      id: run.id, scenario: run.scenario.id, layer: run.scenario.layer, platform, status: 'complete',
      suspect: false, suspect_reasons: [], config: run.config, created_at: run.phase.started_at, started_at: null, finished_at: null,
    },
    results, samples: [], summary: {}, deltas: [],
  };
}
