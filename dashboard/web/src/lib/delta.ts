import type { Target } from '../types';
import { MINUS, isNum } from './format';

export type BetterWhen = 'lower' | 'higher';

export interface DeltaResult {
  /** Go relative to Python, in percent: (go − py) / py × 100. */
  pct: number | null;
  /** go / py */
  ratio: number | null;
  better: Target | null;
  /** Display label, e.g. "−68%", "+12%", "4.1×". */
  label: string;
}

/** Ties within ±0.5% are reported as no winner. */
export const TIE_PCT = 0.5;

export function computeDelta(go: number | null | undefined, py: number | null | undefined, betterWhen: BetterWhen): DeltaResult {
  if (!isNum(go) || !isNum(py)) return { pct: null, ratio: null, better: null, label: '—' };
  if (py === 0) {
    if (go === 0) return { pct: 0, ratio: null, better: null, label: '0%' };
    return { pct: null, ratio: null, better: betterWhen === 'lower' ? 'python' : 'go', label: '∞' };
  }
  const ratio = go / py;
  const pct = (ratio - 1) * 100;
  let better: Target | null = null;
  if (Math.abs(pct) >= TIE_PCT) {
    const goIsLower = go < py;
    better = (betterWhen === 'lower') === goIsLower ? 'go' : 'python';
  }
  return { pct, ratio, better, label: formatDeltaLabel(pct, ratio) };
}

export function formatDeltaLabel(pct: number, ratio: number): string {
  if (ratio >= 2) return `${ratio.toFixed(1)}×`;
  const rounded = Math.round(pct);
  if (rounded === 0) return `${pct >= 0 ? '+' : MINUS}${Math.abs(pct).toFixed(1)}%`;
  return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded)}%`;
}

/** Human sentence for tooltips / screen readers. */
export function describeDelta(d: DeltaResult, betterWhen: BetterWhen, metric = 'value', names: [string, string] = ['Go', 'Python']): string {
  if (d.pct === null || d.ratio === null) return `${metric}: no comparison available`;
  const dir = d.ratio >= 1 ? 'higher' : 'lower';
  const amount = d.ratio >= 2 ? `${d.ratio.toFixed(1)}×` : `${Math.abs(d.pct).toFixed(1)}%`;
  const verdict = d.better ? `${d.better === 'go' ? names[0] : names[1]} is better (${betterWhen} is better)` : 'effectively tied';
  return `${metric}: ${names[0]} is ${amount} ${dir} than ${names[1]} — ${verdict}`;
}

/** Metrics → which direction is better. */
export const BETTER_WHEN: Record<string, BetterWhen> = {
  rps: 'higher',
  rps_per_core: 'higher',
  rps_per_100mb: 'higher',
  p50_ms: 'lower',
  p90_ms: 'lower',
  p95_ms: 'lower',
  p99_ms: 'lower',
  max_ms: 'lower',
  mean_ms: 'lower',
  mem_mb: 'lower',
  cpu_pct: 'lower',
  overhead_p50_ms: 'lower',
  ttft_p50_ms: 'lower',
  error_pct: 'lower',
  rps_cv_pct: 'lower',
};
