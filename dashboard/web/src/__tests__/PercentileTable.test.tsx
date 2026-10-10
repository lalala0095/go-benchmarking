import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PercentileTable, percentileRows } from '../components/PercentileTable';
import type { RunResult, Target } from '../types';

function res(target: Target, rep: number, p50: number, p99: number): RunResult {
  return {
    target, rep, order_in_rep: 1, requests_total: 1000, errors_total: 0, status_counts: {}, duration_s: 20, rps: 50,
    lat_p50_ms: p50, lat_p90_ms: p50 * 2, lat_p95_ms: p50 * 3, lat_p99_ms: p99, lat_max_ms: p99 * 2, lat_mean_ms: p50,
    ttft_p50_ms: null, ttft_p99_ms: null, overhead_p50_ms: null, overhead_p99_ms: null, cpu_avg_pct: null, cpu_max_pct: null,
    cpu_throttled_pct: null, mem_avg_mb: null, mem_max_mb: null, rps_per_core: null, rps_per_100mb: null, max_replicas: null,
    rollout_errors: null, latency_histogram: null,
  };
}

const results = [res('go', 1, 1, 4), res('go', 2, 3, 6), res('go', 3, 2, 5), res('python', 1, 10, 40), res('python', 2, 8, 30), res('python', 3, 12, 50)];

describe('percentileRows', () => {
  it('takes the median across reps per target', () => {
    const rows = percentileRows(results);
    expect(rows.map((r) => r.label)).toEqual(['p50', 'p90', 'p95', 'p99', 'max']);
    expect(rows[0]).toEqual({ label: 'p50', go: 2, python: 10 });
    expect(rows[3]).toEqual({ label: 'p99', go: 5, python: 40 });
  });
  it('returns null for a missing target', () => {
    const rows = percentileRows(results.filter((r) => r.target === 'go'));
    expect(rows[0].python).toBeNull();
  });
});

describe('<PercentileTable>', () => {
  it('renders Go first and a delta column favouring the lower latency', () => {
    render(<PercentileTable results={results} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Percentile', 'Go', 'Python', 'Δ Go vs Py']);
    const p50 = screen.getByRole('row', { name: /^p50/ });
    const badge = within(p50).getByLabelText(/p50 latency/);
    expect(badge).toHaveTextContent('−80%');
    expect(badge).toHaveAttribute('data-better', 'go');
    expect(screen.getByText(/median across 3 reps/)).toBeInTheDocument();
  });
});
