import type { RunDetail, RunSample, RunStreamEvent, SummaryRow, Target } from '../types';
import type { Row } from '../components/charts';

export const TERMINAL = new Set(['complete', 'failed', 'cancelled']);

export function samplesToRows(samples: RunSample[], rep: number | 'all', key: keyof RunSample): Row[] {
  const by = new Map<number, Row>();
  const reps = rep === 'all' ? null : rep;
  // For "all": average across reps at each t_offset.
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (reps !== null && s.rep !== reps) continue;
    const v = s[key];
    if (typeof v !== 'number') continue;
    const x = Math.round(s.t_offset_s * 10) / 10;
    const row = by.get(x) ?? { x };
    const ck = `${x}:${s.target}`;
    const n = counts.get(ck) ?? 0;
    const prev = (row[s.target] as number | null | undefined) ?? 0;
    row[s.target] = (prev * n + v) / (n + 1);
    counts.set(ck, n + 1);
    by.set(x, row);
  }
  return [...by.values()].sort((a, b) => a.x - b.x);
}

export function hasData(rows: Row[]): boolean {
  return rows.some((r) => typeof r.go === 'number' || typeof r.python === 'number');
}

export type SummaryMetric = { key: keyof SummaryRow; label: string; betterWhen: 'lower' | 'higher'; kind: 'num' | 'ms' | 'pct' | 'mb' };
export const SUMMARY_METRICS: SummaryMetric[] = [
  { key: 'rps', label: 'Throughput (RPS)', betterWhen: 'higher', kind: 'num' },
  { key: 'p50_ms', label: 'Latency p50', betterWhen: 'lower', kind: 'ms' },
  { key: 'p99_ms', label: 'Latency p99', betterWhen: 'lower', kind: 'ms' },
  { key: 'mem_mb', label: 'Memory peak', betterWhen: 'lower', kind: 'mb' },
  { key: 'cpu_pct', label: 'CPU avg', betterWhen: 'lower', kind: 'pct' },
  { key: 'rps_per_core', label: 'RPS / core', betterWhen: 'higher', kind: 'num' },
  { key: 'rps_per_100mb', label: 'RPS / 100 MB', betterWhen: 'higher', kind: 'num' },
  { key: 'overhead_p50_ms', label: 'Server overhead p50', betterWhen: 'lower', kind: 'ms' },
  { key: 'ttft_p50_ms', label: 'TTFT p50', betterWhen: 'lower', kind: 'ms' },
  { key: 'error_pct', label: 'Errors', betterWhen: 'lower', kind: 'pct' },
  { key: 'rps_cv_pct', label: 'RPS variance (CV)', betterWhen: 'lower', kind: 'pct' },
];

export function isChatScenario(d: RunDetail): boolean {
  return d.run.scenario.startsWith('chat') || d.run.layer === 'L3' || d.run.layer === 'L4' || !!d.run.config.mode;
}

export interface LiveRunState {
  status: RunDetail['run']['status'];
  phase: Extract<RunStreamEvent, { type: 'phase' }> | null;
  progress: Extract<RunStreamEvent, { type: 'progress' }>[];
  logs: { level: 'info' | 'warn' | 'error'; message: string; at: number }[];
  error: string | null;
  detail: RunDetail | null;
}

export const initialLiveRun = (status: LiveRunState['status'] = 'queued'): LiveRunState => ({ status, phase: null, progress: [], logs: [], error: null, detail: null });

export function liveRunReducer(s: LiveRunState, e: RunStreamEvent): LiveRunState {
  switch (e.type) {
    case 'phase':
      return { ...s, status: e.status, phase: e };
    case 'progress':
      return { ...s, progress: s.progress.length > 4000 ? [...s.progress.slice(-3000), e] : [...s.progress, e] };
    case 'log':
      return { ...s, logs: [...s.logs.slice(-299), { level: e.level, message: e.message, at: Date.now() }] };
    case 'complete':
      return { ...s, status: 'complete', detail: e.run };
    case 'failed':
      return { ...s, status: 'failed', error: e.error };
    case 'cancelled':
      return { ...s, status: 'cancelled' };
    default:
      return s;
  }
}

export function latestProgress(s: LiveRunState, t: Target) {
  for (let i = s.progress.length - 1; i >= 0; i--) if (s.progress[i].target === t) return s.progress[i];
  return undefined;
}
