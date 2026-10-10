// Persistence for runs, results, samples, environments, static measurements and DX notes
// (db/init/dashboard-schema.psql).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type {
  Layer, PlatformMode, RunConfig, RunDetail, RunResult, RunSample, RunStatus, RunSummary,
  StaticMeasurement, Target,
} from '../../../shared/api.js';
import { deltas, summarize } from './analyze.js';

export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'preflight', 'running', 'analyzing'];

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** Stable JSON (sorted keys) so equal environments hash identically. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface EnvironmentInput {
  platform: PlatformMode;
  git_sha: string | null;
  host_info: Record<string, unknown>;
  go_info: Record<string, unknown>;
  py_info: Record<string, unknown>;
}

export class Store {
  constructor(private readonly db: pg.Pool) {}

  /** Runs left active by a crashed/restarted dashboard would block the one-active index forever. */
  async failStaleRuns(): Promise<number> {
    const r = await this.db.query(
      `UPDATE benchmark_runs SET status='failed', error=COALESCE(error,'dashboard restarted during run'), finished_at=now()
       WHERE status = ANY($1::run_status[])`, [ACTIVE_STATUSES]);
    return r.rowCount ?? 0;
  }

  async activeRunId(): Promise<string | null> {
    const r = await this.db.query(`SELECT id FROM benchmark_runs WHERE status = ANY($1::run_status[]) LIMIT 1`, [ACTIVE_STATUSES]);
    return r.rows[0]?.id ?? null;
  }

  async insertRun(x: { scenario: string; layer: Layer; platform: PlatformMode; config: RunConfig; notes?: string | null }): Promise<{ id: string; created_at: string }> {
    const r = await this.db.query(
      `INSERT INTO benchmark_runs (scenario, layer, platform, config, status, notes) VALUES ($1,$2,$3,$4,'queued',$5) RETURNING id, created_at`,
      [x.scenario, x.layer, x.platform, JSON.stringify(x.config), x.notes ?? null]);
    return { id: r.rows[0].id, created_at: iso(r.rows[0].created_at)! };
  }

  async updateRun(id: string, patch: Partial<{
    status: RunStatus; started_at: Date; finished_at: Date; error: string | null; environment_id: string;
    suspect: boolean; suspect_reasons: string[]; config: RunConfig;
  }>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      vals.push(k === 'config' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return;
    vals.push(id);
    await this.db.query(`UPDATE benchmark_runs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }

  async upsertEnvironment(env: EnvironmentInput): Promise<string> {
    const hash = createHash('sha256').update(stableStringify(env)).digest('hex');
    const r = await this.db.query(
      `INSERT INTO environments (hash, platform, git_sha, host_info, go_info, py_info) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (hash) DO UPDATE SET hash = EXCLUDED.hash RETURNING id`,
      [hash, env.platform, env.git_sha, JSON.stringify(env.host_info), JSON.stringify(env.go_info), JSON.stringify(env.py_info)]);
    return r.rows[0].id;
  }

  async insertResult(runId: string, r: RunResult, raw: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO run_results (run_id, target, rep, order_in_rep, requests_total, errors_total, status_counts, duration_s, rps,
         lat_p50_ms, lat_p90_ms, lat_p95_ms, lat_p99_ms, lat_max_ms, lat_mean_ms, ttft_p50_ms, ttft_p99_ms,
         overhead_p50_ms, overhead_p99_ms, cpu_avg_pct, cpu_max_pct, cpu_throttled_pct, max_replicas, rollout_errors,
         mem_avg_mb, mem_max_mb, rps_per_core, rps_per_100mb, latency_histogram, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       ON CONFLICT (run_id, target, rep) DO NOTHING`,
      [runId, r.target, r.rep, r.order_in_rep, r.requests_total, r.errors_total, JSON.stringify(r.status_counts), r.duration_s, r.rps,
        r.lat_p50_ms, r.lat_p90_ms, r.lat_p95_ms, r.lat_p99_ms, r.lat_max_ms, r.lat_mean_ms, r.ttft_p50_ms, r.ttft_p99_ms,
        r.overhead_p50_ms, r.overhead_p99_ms, r.cpu_avg_pct, r.cpu_max_pct, r.cpu_throttled_pct,
        r.max_replicas === null ? null : Math.round(r.max_replicas), r.rollout_errors,
        r.mem_avg_mb, r.mem_max_mb, r.rps_per_core, r.rps_per_100mb,
        r.latency_histogram ? JSON.stringify(r.latency_histogram) : null, raw === undefined ? null : JSON.stringify(raw)]);
  }

  async insertSamples(runId: string, samples: readonly RunSample[]): Promise<void> {
    const COLS = 13;
    for (let i = 0; i < samples.length; i += 500) {
      const chunk = samples.slice(i, i + 500);
      const vals: unknown[] = [];
      const rows = chunk.map((s, j) => {
        vals.push(runId, s.target, s.rep, Math.round(s.t_offset_s), s.rps, s.lat_p50_ms, s.lat_p99_ms,
          s.errors === null ? null : Math.round(s.errors), s.cpu_pct, s.mem_mb,
          s.threads === null ? null : Math.round(s.threads), s.db_pool_in_use === null ? null : Math.round(s.db_pool_in_use),
          s.replicas === null ? null : Math.round(s.replicas));
        return `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`;
      });
      await this.db.query(
        `INSERT INTO run_samples (run_id, target, rep, t_offset_s, rps, lat_p50_ms, lat_p99_ms, errors, cpu_pct, mem_mb, threads, db_pool_in_use, replicas)
         VALUES ${rows.join(',')} ON CONFLICT DO NOTHING`, vals);
    }
  }

  async listRuns(f: { scenario?: string; platform?: string; status?: string; limit?: number }): Promise<RunSummary[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.scenario) { vals.push(f.scenario); where.push(`r.scenario = $${vals.length}`); }
    if (f.platform) { vals.push(f.platform); where.push(`r.platform = $${vals.length}`); }
    if (f.status) { vals.push(f.status); where.push(`r.status::text = $${vals.length}`); }
    vals.push(Math.min(Math.max(f.limit ?? 100, 1), 1000));
    const runs = await this.db.query(
      `SELECT r.* FROM benchmark_runs r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.created_at DESC LIMIT $${vals.length}`, vals);
    if (!runs.rows.length) return [];
    const ids = runs.rows.map((r) => r.id);
    const heads = await this.db.query(
      `SELECT s.run_id, s.target, s.rps_median, s.p99_median, s.mem_median, s.overhead_p50_median
       FROM run_summary s WHERE s.run_id = ANY($1::uuid[])`, [ids]);
    const byRun = new Map<string, RunSummary['headline']>();
    for (const h of heads.rows) {
      const cur = byRun.get(h.run_id) ?? {};
      cur[h.target as Target] = {
        rps: num(h.rps_median), p99_ms: num(h.p99_median), mem_mb: num(h.mem_median), overhead_p50_ms: num(h.overhead_p50_median),
      };
      byRun.set(h.run_id, cur);
    }
    return runs.rows.map((r) => ({ ...mapRun(r), headline: byRun.get(r.id) ?? {} }));
  }

  async getRunDetail(id: string): Promise<RunDetail | null> {
    if (!isUuid(id)) return null;
    const run = await this.db.query(
      `SELECT r.*, CASE WHEN e.id IS NULL THEN NULL ELSE to_jsonb(e) - 'hash' END AS environment FROM benchmark_runs r LEFT JOIN environments e ON e.id = r.environment_id WHERE r.id = $1`, [id]);
    if (!run.rows.length) return null;
    const [res, samp] = await Promise.all([
      this.db.query(`SELECT * FROM run_results WHERE run_id = $1 ORDER BY rep, order_in_rep`, [id]),
      this.db.query(`SELECT * FROM run_samples WHERE run_id = $1 ORDER BY target, rep, t_offset_s`, [id]),
    ]);
    const results = res.rows.map(mapResult);
    const summary = summarize(results);
    const row = run.rows[0];
    const headline: RunSummary['headline'] = {};
    for (const [t, s] of Object.entries(summary) as [Target, NonNullable<(typeof summary)['go']>][]) {
      headline[t] = { rps: s.rps, p99_ms: s.p99_ms, mem_mb: s.mem_mb, overhead_p50_ms: s.overhead_p50_ms };
    }
    return {
      run: { ...mapRun(row), headline, environment: row.environment ?? null, error: row.error ?? null, notes: row.notes ?? null },
      results,
      samples: samp.rows.map(mapSample),
      summary,
      deltas: deltas(summary),
    };
  }

  async rawSummaries(id: string): Promise<{ target: Target; rep: number; raw_summary: unknown }[]> {
    if (!isUuid(id)) return [];
    const r = await this.db.query(`SELECT target, rep, raw_summary FROM run_results WHERE run_id = $1 ORDER BY rep, order_in_rep`, [id]);
    return r.rows;
  }

  async deleteRun(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const r = await this.db.query(`DELETE FROM benchmark_runs WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Latest complete run per (scenario, platform), preferring non-suspect ones. */
  async latestRunIdsForReport(): Promise<string[]> {
    const r = await this.db.query(
      `SELECT DISTINCT ON (scenario, platform) id FROM benchmark_runs WHERE status = 'complete'
       ORDER BY scenario, platform, suspect ASC, created_at DESC`);
    return r.rows.map((x) => x.id);
  }

  async latestStatic(): Promise<StaticMeasurement[]> {
    const r = await this.db.query(
      `SELECT DISTINCT ON (target, metric, platform) target, metric, platform, value, measured_at
       FROM static_measurements ORDER BY target, metric, platform, measured_at DESC`);
    return r.rows.map((x) => ({ target: x.target, metric: x.metric, platform: x.platform, value: Number(x.value), measured_at: iso(x.measured_at)! }));
  }

  async insertStatic(target: Target, metric: string, platform: PlatformMode, value: number, environmentId: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO static_measurements (target, metric, platform, value, environment_id) VALUES ($1,$2,$3,$4,$5)`,
      [target, metric, platform, value, environmentId]);
  }

  async dxNotes(): Promise<Record<Target, { markdown: string; updated_at: string }>> {
    const r = await this.db.query(`SELECT target, markdown, updated_at FROM dx_notes`);
    const out: Record<Target, { markdown: string; updated_at: string }> = {
      go: { markdown: '', updated_at: new Date(0).toISOString() },
      python: { markdown: '', updated_at: new Date(0).toISOString() },
    };
    for (const x of r.rows) out[x.target as Target] = { markdown: x.markdown, updated_at: iso(x.updated_at)! };
    return out;
  }

  async putDxNotes(target: Target, markdown: string): Promise<void> {
    await this.db.query(
      `INSERT INTO dx_notes (target, markdown, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (target) DO UPDATE SET markdown = EXCLUDED.markdown, updated_at = now()`, [target, markdown]);
  }
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function mapRun(r: Record<string, unknown>): RunSummary {
  return {
    id: r.id as string,
    scenario: r.scenario as string,
    layer: r.layer as Layer,
    platform: r.platform as PlatformMode,
    status: r.status as RunStatus,
    suspect: !!r.suspect,
    suspect_reasons: (r.suspect_reasons as string[]) ?? [],
    config: r.config as RunConfig,
    created_at: iso(r.created_at)!,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
  };
}

export function mapResult(r: Record<string, unknown>): RunResult {
  return {
    target: r.target as Target,
    rep: Number(r.rep),
    order_in_rep: Number(r.order_in_rep),
    requests_total: Number(r.requests_total),
    errors_total: Number(r.errors_total),
    status_counts: (r.status_counts as Record<string, number>) ?? {},
    duration_s: Number(r.duration_s),
    rps: Number(r.rps),
    lat_p50_ms: num(r.lat_p50_ms), lat_p90_ms: num(r.lat_p90_ms), lat_p95_ms: num(r.lat_p95_ms), lat_p99_ms: num(r.lat_p99_ms),
    lat_max_ms: num(r.lat_max_ms), lat_mean_ms: num(r.lat_mean_ms),
    ttft_p50_ms: num(r.ttft_p50_ms), ttft_p99_ms: num(r.ttft_p99_ms),
    overhead_p50_ms: num(r.overhead_p50_ms), overhead_p99_ms: num(r.overhead_p99_ms),
    cpu_avg_pct: num(r.cpu_avg_pct), cpu_max_pct: num(r.cpu_max_pct), cpu_throttled_pct: num(r.cpu_throttled_pct),
    mem_avg_mb: num(r.mem_avg_mb), mem_max_mb: num(r.mem_max_mb),
    rps_per_core: num(r.rps_per_core), rps_per_100mb: num(r.rps_per_100mb),
    max_replicas: num(r.max_replicas), rollout_errors: num(r.rollout_errors),
    latency_histogram: (r.latency_histogram as RunResult['latency_histogram']) ?? null,
  };
}

function mapSample(r: Record<string, unknown>): RunSample {
  return {
    target: r.target as Target, rep: Number(r.rep), t_offset_s: Number(r.t_offset_s),
    rps: num(r.rps), lat_p50_ms: num(r.lat_p50_ms), lat_p99_ms: num(r.lat_p99_ms), errors: num(r.errors),
    cpu_pct: num(r.cpu_pct), mem_mb: num(r.mem_mb), threads: num(r.threads), db_pool_in_use: num(r.db_pool_in_use), replicas: num(r.replicas),
  };
}
