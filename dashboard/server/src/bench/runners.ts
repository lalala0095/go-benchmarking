// Per-scenario measurement strategies used by the orchestrator.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RunConfig, RunResult, RunSample, Target } from '../../../shared/api.js';
import type { BenchDeps } from './types.js';
import type { HttpClient } from './http.js';
import type { ScenarioDef } from './scenarios.js';
import { latencyStats, median, percentile, round, rpsPer100Mb, rpsPerCore, histogram } from './analyze.js';
import { ChatLoad, summarizeChat, type SecondStats } from './chatRunner.js';
import { CancelledError, loadBody, runOha } from './oha.js';
import { Sampler, type SamplerSummary } from './sampler.js';

export interface RunCtx {
  runId: string;
  scenario: ScenarioDef;
  config: RunConfig;
  deps: BenchDeps;
  http: HttpClient;
  signal: AbortSignal;
  cpuLimit: Record<Target, number | null>;
  dashboardCpuLimit: number | null;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  progress(s: RunSample): void;
  sleep(ms: number): Promise<void>;
}

export interface MeasureOutput {
  result: RunResult;
  raw: unknown;
  samples: RunSample[];
  dashboardCpuPct: number | null;
  /** Measurement-validity problems seen by the sampler (e.g. target restarted). */
  resources?: SamplerSummary | null;
}

export interface ScenarioRunner {
  /** All targets measured simultaneously with interleaved requests (chat-gemini). */
  interleaved?: boolean;
  prepare?(ctx: RunCtx): Promise<void>;
  beforeTarget?(ctx: RunCtx, t: Target): Promise<void>;
  warmup?(ctx: RunCtx, t: Target): Promise<void>;
  measure(ctx: RunCtx, targets: Target[], rep: number, order: number): Promise<MeasureOutput[]>;
  finish?(ctx: RunCtx, outputs: MeasureOutput[]): Promise<void>;
}

type LoadFields = Pick<RunResult,
  'requests_total' | 'errors_total' | 'status_counts' | 'duration_s' | 'rps' |
  'lat_p50_ms' | 'lat_p90_ms' | 'lat_p95_ms' | 'lat_p99_ms' | 'lat_max_ms' | 'lat_mean_ms' | 'latency_histogram'
> & Partial<Pick<RunResult, 'ttft_p50_ms' | 'ttft_p99_ms' | 'overhead_p50_ms' | 'overhead_p99_ms' | 'max_replicas' | 'rollout_errors'>>;

export function buildResult(t: Target, rep: number, order: number, load: LoadFields, res: SamplerSummary | null, cpuLimit: number | null): RunResult {
  const replicas = res?.avg_replicas && res.avg_replicas > 1 ? res.avg_replicas : 1;
  const cores = cpuLimit === null ? null : cpuLimit * replicas;
  return {
    target: t, rep, order_in_rep: order,
    requests_total: load.requests_total, errors_total: load.errors_total, status_counts: load.status_counts,
    duration_s: load.duration_s, rps: load.rps,
    lat_p50_ms: load.lat_p50_ms, lat_p90_ms: load.lat_p90_ms, lat_p95_ms: load.lat_p95_ms, lat_p99_ms: load.lat_p99_ms,
    lat_max_ms: load.lat_max_ms, lat_mean_ms: load.lat_mean_ms,
    ttft_p50_ms: load.ttft_p50_ms ?? null, ttft_p99_ms: load.ttft_p99_ms ?? null,
    overhead_p50_ms: load.overhead_p50_ms ?? null, overhead_p99_ms: load.overhead_p99_ms ?? null,
    cpu_avg_pct: res?.cpu_avg_pct ?? null, cpu_max_pct: res?.cpu_max_pct ?? null, cpu_throttled_pct: res?.cpu_throttled_pct ?? null,
    mem_avg_mb: res?.mem_avg_mb ?? null, mem_max_mb: res?.mem_max_mb ?? null,
    rps_per_core: round(rpsPerCore(load.rps, cores)),
    rps_per_100mb: round(rpsPer100Mb(load.rps, res?.mem_avg_mb ?? null)),
    max_replicas: load.max_replicas ?? res?.max_replicas ?? null,
    rollout_errors: load.rollout_errors ?? null,
    latency_histogram: load.latency_histogram,
  };
}

function sampler(ctx: RunCtx, t: Target, rep: number, clientSecond?: (sec: number) => SecondStats | null): Sampler {
  return new Sampler({
    platform: ctx.deps.platform, scrapeMetrics: ctx.deps.scrapeMetrics, target: t, rep,
    dashboardCpuLimit: ctx.dashboardCpuLimit, clientSecond, onSample: (s) => ctx.progress(s),
  });
}

function checkCancelled(ctx: RunCtx): void {
  if (ctx.signal.aborted) throw new CancelledError();
}

// ── HTTP micro-benchmarks (oha) ──────────────────────────────────────────
export function httpRunner(): ScenarioRunner {
  let body: string | undefined;
  return {
    async prepare(ctx) {
      const run = ctx.scenario.run;
      if (run.kind !== 'http') throw new Error('not an http scenario');
      if (run.body) body = await loadBody(run.body, ctx.deps.contractsDir);
    },
    async beforeTarget(ctx, t) {
      if (ctx.scenario.id === 'db-write') {
        await ctx.deps.appDbs[t].query('TRUNCATE app.bench_writes');
        ctx.log('info', `${t}: truncated app.bench_writes`);
      }
    },
    async warmup(ctx, t) {
      const run = ctx.scenario.run;
      if (run.kind !== 'http' || ctx.config.warmup_s <= 0) return;
      await runOha(ctx.deps.ohaPath, {
        url: ctx.deps.targets[t] + run.path, method: run.method, concurrency: ctx.config.concurrency,
        durationS: ctx.config.warmup_s, body, contentType: 'application/json',
      }, ctx.signal);
    },
    async measure(ctx, [t], rep, order) {
      const run = ctx.scenario.run;
      if (run.kind !== 'http') throw new Error('not an http scenario');
      const s = sampler(ctx, t!, rep);
      await s.start();
      let out: Awaited<ReturnType<typeof runOha>>;
      let res: SamplerSummary;
      try {
        out = await runOha(ctx.deps.ohaPath, {
          url: ctx.deps.targets[t!] + run.path, method: run.method, concurrency: ctx.config.concurrency,
          durationS: ctx.config.duration_s!, body, contentType: 'application/json',
        }, ctx.signal);
      } finally {
        res = await s.stop();
      }
      return [{
        result: buildResult(t!, rep, order, out.parsed, res, ctx.cpuLimit[t!]),
        raw: { generator: 'oha', oha: out.raw, aborted_at_deadline: out.parsed.aborted_at_deadline, resources: res },
        samples: s.samples,
        dashboardCpuPct: res.dashboard_cpu_avg_pct,
        resources: res,
      }];
    },
  };
}

// ── Chat (mock / Gemini) ─────────────────────────────────────────────────
type Prompts = Record<string, string>;
async function loadPrompts(contractsDir: string): Promise<Prompts> {
  return JSON.parse(await readFile(path.join(contractsDir, 'fixtures', 'prompts.json'), 'utf8')) as Prompts;
}

function promptFor(ctx: RunCtx, prompts: Prompts): string {
  const p = typeof ctx.config.params?.prompt === 'string' ? ctx.config.params.prompt : null;
  if (p) return prompts[p] ?? p;
  const key = ctx.scenario.run.kind === 'chat' ? ctx.scenario.run.prompt : 'plain';
  const msg = prompts[key];
  if (!msg) throw new Error(`prompt '${key}' missing from contracts/fixtures/prompts.json`);
  return msg;
}

function rampOf(cfg: RunConfig): { from: number; to: number; over_s: number } | undefined {
  const r = cfg.params?.ramp as { from: number; to: number; over_s: number } | undefined;
  return r && typeof r.to === 'number' ? r : undefined;
}

function userId(ctx: RunCtx): string { return `bench-${ctx.runId.slice(0, 8)}`; }

async function chatWarmup(ctx: RunCtx, t: Target, message: string): Promise<void> {
  if (ctx.config.warmup_s <= 0) return;
  const ramp = rampOf(ctx.config);
  const load = new ChatLoad({
    baseUrls: ctx.deps.targets, targets: [t], mode: ctx.config.mode ?? 'mock', message,
    concurrency: ramp ? Math.min(10, ramp.to) : ctx.config.concurrency,
    durationS: ctx.config.warmup_s, userId: userId(ctx), signal: ctx.signal,
  });
  try { await load.run(); } finally { await load.cleanup(); }
}

export function chatRunner(interleaved = false): ScenarioRunner {
  let message = '';
  return {
    interleaved,
    async prepare(ctx) { message = promptFor(ctx, await loadPrompts(ctx.deps.contractsDir)); },
    warmup: (ctx, t) => chatWarmup(ctx, t, message),
    async measure(ctx, targets, rep, order) {
      const load = new ChatLoad({
        baseUrls: ctx.deps.targets, targets, mode: ctx.config.mode ?? 'mock', message,
        concurrency: ctx.config.concurrency, ramp: rampOf(ctx.config),
        durationS: ctx.config.duration_s, requests: ctx.config.requests, userId: userId(ctx), signal: ctx.signal,
      });
      const samplers = targets.map((t) => sampler(ctx, t, rep, (sec) => load.second(t, sec)));
      await Promise.all(samplers.map((s) => s.start()));
      let duration = 0;
      let res: SamplerSummary[];
      try {
        duration = await load.run();
      } finally {
        res = await Promise.all(samplers.map((s) => s.stop()));
        const deleted = await load.cleanup();
        ctx.log('info', `deleted ${deleted} bench sessions`);
      }
      checkCancelled(ctx);
      return targets.map((t, i) => {
        const sum = summarizeChat(load.recordsFor(t), duration, { aborted_in_flight: load.aborted, interleaved });
        return {
          result: buildResult(t, rep, interleaved ? i + 1 : order, sum, res[i]!, ctx.cpuLimit[t]),
          raw: { ...sum.raw, resources: res[i] },
          samples: samplers[i]!.samples,
          dashboardCpuPct: res[i]!.dashboard_cpu_avg_pct,
          resources: res[i],
        };
      });
    },
  };
}

// ── RAG ingest (sequential) ──────────────────────────────────────────────
interface IngestTimings { read_ms?: number; chunk_ms?: number; embed_ms?: number; embed_gemini_ms?: number; embed_mock_ms?: number; db_ms?: number; total_ms?: number }

export const BENCH_COPY_SOURCE_RE = '^r[0-9]+/';

async function removeBenchCopies(ctx: RunCtx, t: Target): Promise<void> {
  try {
    const r = await ctx.deps.appDbs[t].query(`DELETE FROM app.rag_documents WHERE source ~ $1`, [BENCH_COPY_SOURCE_RE]);
    if (r.rowCount) ctx.log('info', `${t}: removed ${r.rowCount} benchmark copy documents (r{i}/…)`);
  } catch (e) {
    ctx.log('warn', `${t}: could not remove benchmark copies: ${(e as Error).message}`);
  }
}

export function ingestRunner(): ScenarioRunner {
  return {
    async measure(ctx, [t], rep, order) {
      const run = ctx.scenario.run;
      if (run.kind !== 'ingest') throw new Error('not an ingest scenario');
      const n = ctx.config.requests ?? 1;
      const s = sampler(ctx, t!, rep);
      await s.start();
      const lat: number[] = [];
      const responses: { status: number; client_ms: number; chunks?: number; documents?: number; timings?: IngestTimings }[] = [];
      const status_counts: Record<string, number> = {};
      let errors = 0;
      let chunks = 0;
      const t0 = performance.now();
      let res: SamplerSummary;
      try {
        for (let i = 0; i < n; i++) {
          checkCancelled(ctx);
          const st = performance.now();
          let status = 0;
          let body: { chunks?: number; documents?: number; timings?: IngestTimings } | null = null;
          try {
            ({ status, body } = await ctx.http.postJson<{ chunks?: number; documents?: number; timings?: IngestTimings }>(
              `${ctx.deps.targets[t!]}/v1/rag/ingest`, run.body, 15 * 60_000, ctx.signal));
          } catch (e) {
            if (ctx.signal.aborted) throw new CancelledError();
            ctx.log('warn', `${t}: ingest failed: ${(e as Error).message}`);
          }
          const ms = performance.now() - st;
          lat.push(ms);
          const key = status ? String(status) : 'conn_error';
          status_counts[key] = (status_counts[key] ?? 0) + 1;
          if (status !== 200) errors++;
          else chunks += body?.chunks ?? 0;
          responses.push({ status, client_ms: round(ms)!, chunks: body?.chunks, documents: body?.documents, timings: body?.timings });
        }
      } finally {
        res = await s.stop();
        // Benchmark-mode ingest stores copies as "r{i}/<path>"; remove them so every rep starts from
        // the same KB and later rag-search runs are not skewed by an inflated corpus.
        await removeBenchCopies(ctx, t!);
      }
      const dur = (performance.now() - t0) / 1000;
      const ls = latencyStats(lat);
      const tm = (k: keyof IngestTimings) => round(median(responses.map((r) => r.timings?.[k] ?? null)));
      const result = buildResult(t!, rep, order, {
        requests_total: n, errors_total: errors, status_counts, duration_s: round(dur)!,
        rps: dur > 0 ? round(chunks / dur)! : 0, // chunks ingested per second
        lat_p50_ms: round(ls.p50), lat_p90_ms: round(ls.p90), lat_p95_ms: round(ls.p95), lat_p99_ms: round(ls.p99),
        lat_max_ms: round(ls.max), lat_mean_ms: round(ls.mean), latency_histogram: histogram(lat),
      }, res, ctx.cpuLimit[t!]);
      ctx.log('info', `${t}: ingest rep ${rep}: ${chunks} chunks in ${dur.toFixed(2)} s (embed ${tm('embed_ms')} ms, db ${tm('db_ms')} ms)`);
      return [{
        result,
        raw: {
          generator: 'ingest', rps_unit: 'chunks/s', request: run.body, responses,
          median_timings_ms: { read: tm('read_ms'), chunk: tm('chunk_ms'), embed: tm('embed_ms'), embed_gemini: tm('embed_gemini_ms'), embed_mock: tm('embed_mock_ms'), db: tm('db_ms'), total: tm('total_ms') },
          resources: res,
        },
        samples: s.samples,
        dashboardCpuPct: res.dashboard_cpu_avg_pct,
        resources: res,
      }];
    },
  };
}

// ── Cold start ───────────────────────────────────────────────────────────
export function coldStartRunner(store: { insertStatic(t: Target, metric: string, p: 'compose' | 'k8s', v: number, env: string | null): Promise<void> }, envId: () => string | null): ScenarioRunner {
  return {
    async measure(ctx, [t], rep, order) {
      checkCancelled(ctx);
      const { readyMs } = await ctx.deps.platform.restart(t!);
      // Confirm the first healthy response from the dashboard's point of view.
      const st = performance.now();
      let healthy = false;
      while (performance.now() - st < 120_000) {
        checkCancelled(ctx);
        try {
          const r = await ctx.http.getJson(`${ctx.deps.targets[t!]}/healthz`, 2000);
          if (r.status === 200) { healthy = true; break; }
        } catch { /* not up yet */ }
        await ctx.sleep(100);
      }
      const extra = performance.now() - st;
      if (!healthy) throw new Error(`${t} did not become healthy within 120 s after restart`);
      ctx.log('info', `${t}: ready in ${readyMs.toFixed(0)} ms (+${extra.toFixed(0)} ms until dashboard saw /healthz 200)`);
      const v = round(readyMs)!;
      return [{
        result: buildResult(t!, rep, order, {
          requests_total: 1, errors_total: 0, status_counts: { '200': 1 }, duration_s: round(readyMs / 1000)!, rps: 0,
          lat_p50_ms: v, lat_p90_ms: v, lat_p95_ms: v, lat_p99_ms: v, lat_max_ms: v, lat_mean_ms: v, latency_histogram: null,
        }, null, ctx.cpuLimit[t!]),
        raw: { generator: 'cold-start', ready_ms: readyMs, dashboard_health_ms: round(extra) },
        samples: [],
        dashboardCpuPct: null,
      }];
    },
    async finish(ctx, outputs) {
      for (const t of ctx.config.targets) {
        const vals = outputs.filter((o) => o.result.target === t).map((o) => o.result.lat_p50_ms);
        const med = median(vals);
        if (med === null) continue;
        const mode = ctx.deps.platform.mode;
        await store.insertStatic(t, 'cold_start_ms', mode, round(med)!, envId());
        if (mode === 'k8s') await store.insertStatic(t, 'pod_ready_ms', mode, round(med)!, envId());
      }
    },
  };
}

// ── k8s: HPA scale-out ───────────────────────────────────────────────────
export function scaleOutRunner(): ScenarioRunner {
  const inner = chatRunner(false);
  return {
    async prepare(ctx) {
      if (!ctx.deps.platform.setHpa) throw new Error('platform does not support HPA (scale-out is k8s-only)');
      await inner.prepare!(ctx);
    },
    warmup: (ctx, t) => inner.warmup!(ctx, t),
    async measure(ctx, [t], rep, order) {
      const p = ctx.deps.platform;
      const h = (ctx.config.params?.hpa ?? {}) as { min?: number; max?: number; cpu?: number };
      const hpa = { minReplicas: h.min ?? 1, maxReplicas: h.max ?? 4, cpuUtilization: h.cpu ?? 70 };
      await p.setHpa!(t!, hpa);
      ctx.log('info', `${t}: HPA set ${hpa.minReplicas}–${hpa.maxReplicas} replicas @ ${hpa.cpuUtilization}% CPU`);
      let out: MeasureOutput[];
      try {
        out = await inner.measure(ctx, [t!], rep, order);
      } finally {
        await p.setHpa!(t!, null).catch((e) => ctx.log('warn', `${t}: removing HPA failed: ${(e as Error).message}`));
        if (p.scale) await p.scale(t!, 1).catch((e) => ctx.log('warn', `${t}: scale to 1 failed: ${(e as Error).message}`));
        const st = Date.now();
        while (Date.now() - st < 180_000) {
          const n = await p.replicas(t!).catch(() => -1);
          if (n === 1) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        ctx.log('info', `${t}: reset to 1 replica`);
      }
      const o = out[0]!;
      const firstScale = o.samples.find((s) => (s.replicas ?? 0) > 1);
      o.raw = {
        ...(o.raw as object), hpa,
        time_to_first_scale_s: firstScale ? firstScale.t_offset_s : null,
        replicas_timeline: o.samples.map((s) => [s.t_offset_s, s.replicas]),
      };
      return out;
    },
  };
}

// ── k8s: rollout disruption ──────────────────────────────────────────────
export function rolloutRunner(): ScenarioRunner {
  let message = '';
  return {
    async prepare(ctx) {
      if (!ctx.deps.platform.rollout) throw new Error('platform does not support rollouts (rollout-disruption is k8s-only)');
      message = promptFor(ctx, await loadPrompts(ctx.deps.contractsDir));
    },
    warmup: (ctx, t) => chatWarmup(ctx, t, message),
    async measure(ctx, [t], rep, order) {
      const atS = Number(ctx.config.params?.rollout_at_s ?? 15);
      const tailS = Number(ctx.config.params?.tail_s ?? 10);
      const minS = ctx.config.duration_s ?? 60;
      const load = new ChatLoad({
        baseUrls: ctx.deps.targets, targets: [t!], mode: 'mock', message,
        concurrency: ctx.config.concurrency, userId: userId(ctx), signal: ctx.signal,
      });
      const s = sampler(ctx, t!, rep, (sec) => load.second(t!, sec));
      await s.start();
      const runP = load.run();
      let rollout: Awaited<ReturnType<NonNullable<typeof ctx.deps.platform.rollout>>> | null = null;
      let rolloutEndS = atS;
      let duration = 0;
      let res: SamplerSummary;
      try {
        await ctx.sleep(atS * 1000);
        ctx.log('info', `${t}: starting rolling restart at t=${atS}s`);
        rollout = await ctx.deps.platform.rollout!(t!);
        rolloutEndS = load.elapsedS();
        ctx.log('info', `${t}: rollout complete after ${(rollout.durationMs / 1000).toFixed(1)} s (${rollout.newPods.length} new pods)`);
        const remaining = Math.max(tailS, minS - rolloutEndS);
        await ctx.sleep(remaining * 1000);
      } finally {
        load.stop(true);
        duration = await runP;
        res = await s.stop();
        await load.cleanup();
      }
      checkCancelled(ctx);
      const recs = load.recordsFor(t!);
      const before = recs.filter((r) => r.ok && r.end_ms < atS * 1000).map((r) => r.latency_ms);
      const during = recs.filter((r) => r.ok && r.end_ms >= atS * 1000 && r.end_ms <= (rolloutEndS + tailS) * 1000).map((r) => r.latency_ms);
      const rolloutErrors = recs.filter((r) => !r.ok && r.end_ms >= atS * 1000).length;
      const baseP99 = round(percentile(before, 99));
      const durP99 = round(percentile(during, 99));
      const sum = summarizeChat(recs, duration, {
        rollout, rollout_at_s: atS, rollout_end_s: round(rolloutEndS),
        baseline_p99_ms: baseP99, rollout_p99_ms: durP99,
        p99_spike_ratio: baseP99 && durP99 ? round(durP99 / baseP99) : null,
      });
      return [{
        result: buildResult(t!, rep, order, { ...sum, rollout_errors: rolloutErrors }, res, ctx.cpuLimit[t!]),
        raw: { ...sum.raw, resources: res },
        samples: s.samples,
        dashboardCpuPct: res.dashboard_cpu_avg_pct,
        resources: res,
      }];
    },
  };
}
