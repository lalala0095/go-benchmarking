import type { RunResult, Target } from '../types';
import { fmtMs, median } from '../lib/format';
import { DeltaBadge } from './DeltaBadge';

export const PERCENTILES = [
  { key: 'lat_p50_ms', label: 'p50' },
  { key: 'lat_p90_ms', label: 'p90' },
  { key: 'lat_p95_ms', label: 'p95' },
  { key: 'lat_p99_ms', label: 'p99' },
  { key: 'lat_max_ms', label: 'max' },
] as const;

export interface PercentileRow { label: string; go: number | null; python: number | null }

/** Median across reps for each percentile, per target. */
export function percentileRows(results: RunResult[]): PercentileRow[] {
  const pick = (t: Target, k: (typeof PERCENTILES)[number]['key']) => median(results.filter((r) => r.target === t).map((r) => r[k]));
  return PERCENTILES.map((p) => ({ label: p.label, go: pick('go', p.key), python: pick('python', p.key) }));
}

export function PercentileTable({ results, caption }: { results: RunResult[]; caption?: string }) {
  const rows = percentileRows(results);
  const reps = new Set(results.map((r) => r.rep)).size;
  return (
    <table className="table-dense w-full text-sm">
      <caption className="mb-1 text-left text-xs text-muted">{caption ?? `Latency, median across ${reps} rep${reps === 1 ? '' : 's'}`}</caption>
      <thead>
        <tr>
          <th scope="col">Percentile</th>
          <th scope="col" className="text-right"><span className="text-gofg">Go</span></th>
          <th scope="col" className="text-right"><span className="text-pyfg">Python</span></th>
          <th scope="col" className="text-right">Δ Go vs Py</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row" className="num px-2 py-1.5 text-left font-medium">{r.label}</th>
            <td className="num text-right">{fmtMs(r.go)}</td>
            <td className="num text-right">{fmtMs(r.python)}</td>
            <td className="text-right"><DeltaBadge go={r.go} py={r.python} betterWhen="lower" metric={`${r.label} latency`} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
