import { useMemo } from 'react';
import type { RunResult, Target } from '../types';
import { fmtMs } from '../lib/format';
import { COLOR, SeriesChart, type Row } from './charts';

/** Merge per-rep histograms per target and normalise to % of requests, keyed by bucket upper bound. */
export function histogramRows(results: RunResult[]): Row[] {
  const acc = new Map<number, { go: number; python: number }>();
  const totals: Record<Target, number> = { go: 0, python: 0 };
  for (const r of results) {
    for (const b of r.latency_histogram ?? []) {
      const e = acc.get(b.le_ms) ?? { go: 0, python: 0 };
      e[r.target] += b.count;
      totals[r.target] += b.count;
      acc.set(b.le_ms, e);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([le]) => le > 0 && Number.isFinite(le))
    .map(([le, v]) => ({
      x: le,
      go: totals.go ? (v.go / totals.go) * 100 : null,
      python: totals.python ? (v.python / totals.python) * 100 : null,
    }));
}

export function LatencyHistogram({ results, height = 220 }: { results: RunResult[]; height?: number }) {
  const rows = useMemo(() => histogramRows(results), [results]);
  if (!rows.length) return <p className="text-sm text-muted">No histogram data recorded for this run.</p>;
  return (
    <SeriesChart
      data={rows}
      series={[
        { key: 'go', label: 'Go', color: COLOR.go },
        { key: 'python', label: 'Python', color: COLOR.python },
      ]}
      height={height}
      unit="% of requests"
      xScale="log"
      xFormat={(x) => `≤${fmtMs(x)}`}
      yFormat={(v) => `${v.toFixed(0)}%`}
      area
      step
      legend
      ariaLabel="Latency distribution histogram, log scale, Go and Python overlaid"
    />
  );
}
