// Run export: JSON (full detail + raw generator output), CSV (one row per target × rep), Markdown.
import type { RunDetail, RunResult, SummaryRow, Target } from '../../../shared/api.js';
import { pctChange } from './analyze.js';

export const RESULT_COLUMNS: (keyof RunResult)[] = [
  'target', 'rep', 'order_in_rep', 'requests_total', 'errors_total', 'duration_s', 'rps',
  'lat_p50_ms', 'lat_p90_ms', 'lat_p95_ms', 'lat_p99_ms', 'lat_max_ms', 'lat_mean_ms',
  'ttft_p50_ms', 'ttft_p99_ms', 'overhead_p50_ms', 'overhead_p99_ms',
  'cpu_avg_pct', 'cpu_max_pct', 'cpu_throttled_pct', 'mem_avg_mb', 'mem_max_mb',
  'rps_per_core', 'rps_per_100mb', 'max_replicas', 'rollout_errors', 'status_counts',
];

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(d: RunDetail): string {
  const head = ['run_id', 'scenario', 'layer', 'platform', 'status', 'suspect', ...RESULT_COLUMNS];
  const lines = [head.join(',')];
  for (const r of d.results) {
    lines.push([
      d.run.id, d.run.scenario, d.run.layer, d.run.platform, d.run.status, d.run.suspect,
      ...RESULT_COLUMNS.map((c) => r[c]),
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

export const fmt = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(digits);

const SUMMARY_LABELS: [keyof SummaryRow, string][] = [
  ['rps', 'RPS'], ['p50_ms', 'p50 (ms)'], ['p99_ms', 'p99 (ms)'], ['error_pct', 'Errors (%)'],
  ['cpu_pct', 'CPU avg (%)'], ['mem_mb', 'Memory avg (MB)'], ['rps_per_core', 'RPS / core'], ['rps_per_100mb', 'RPS / 100 MB'],
  ['ttft_p50_ms', 'TTFT p50 (ms)'], ['overhead_p50_ms', 'Overhead p50 (ms)'], ['rps_cv_pct', 'RPS CV across reps (%)'],
];

export function summaryTable(d: RunDetail): string {
  const targets = (['go', 'python'] as Target[]).filter((t) => d.summary[t]);
  if (!targets.length) return '_No results._\n';
  const both = targets.length === 2;
  const rows = [`| Metric | ${targets.map((t) => (t === 'go' ? 'Go' : 'Python')).join(' | ')}${both ? ' | Go vs Python |' : ' |'}`,
    `|---|${targets.map(() => '---:').join('|')}${both ? '|---:|' : '|'}`];
  for (const [k, label] of SUMMARY_LABELS) {
    const vals = targets.map((t) => d.summary[t]![k]);
    if (vals.every((v) => v === null)) continue;
    const delta = both ? ` | ${pctChange(d.summary.go![k], d.summary.python![k])}` : '';
    rows.push(`| ${label} | ${vals.map((v) => fmt(v, 2)).join(' | ')}${delta} |`);
  }
  return rows.join('\n') + '\n';
}

export function toMarkdown(d: RunDetail): string {
  const r = d.run;
  const c = r.config;
  const out: string[] = [];
  out.push(`# Benchmark run: ${r.scenario} (${r.layer}, ${r.platform})`, '');
  out.push(`- Run ID: \`${r.id}\``);
  out.push(`- Status: **${r.status}**${r.suspect ? ' (suspect)' : ''}`);
  out.push(`- Created: ${r.created_at}${r.finished_at ? ` · finished ${r.finished_at}` : ''}`);
  out.push(`- Config: targets ${c.targets.join(', ')} · concurrency ${c.concurrency}` +
    `${c.duration_s ? ` · ${c.duration_s} s` : ''}${c.requests ? ` · ${c.requests} requests` : ''}` +
    ` · warm-up ${c.warmup_s} s · cooldown ${c.cooldown_s} s · ${c.reps} rep(s)` +
    `${c.mode ? ` · mode ${c.mode}` : ''}${c.py_profile ? ` · ${c.py_profile}` : ''}`);
  if (r.notes) out.push(`- Notes: ${r.notes}`);
  if (r.error) out.push(`- Error: ${r.error}`);
  if (r.suspect_reasons.length) out.push('', '**Suspect:**', ...r.suspect_reasons.map((x) => `- ${x}`));
  out.push('', '## Summary (median of reps)', '', summaryTable(d));
  if (d.results.length) {
    out.push('## Per repetition', '',
      '| Target | Rep | Order | Requests | Errors | RPS | p50 | p90 | p99 | max | CPU avg % | Mem avg MB |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const x of d.results) {
      out.push(`| ${x.target} | ${x.rep} | ${x.order_in_rep} | ${x.requests_total} | ${x.errors_total} | ${fmt(x.rps)} | ${fmt(x.lat_p50_ms, 2)} | ${fmt(x.lat_p90_ms, 2)} | ${fmt(x.lat_p99_ms, 2)} | ${fmt(x.lat_max_ms, 2)} | ${fmt(x.cpu_avg_pct)} | ${fmt(x.mem_avg_mb)} |`);
    }
    out.push('');
  }
  if (r.environment) out.push('## Environment', '', '```json', JSON.stringify(r.environment, null, 2), '```', '');
  return out.join('\n');
}
