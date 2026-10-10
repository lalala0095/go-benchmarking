import { useMemo, useState } from 'react';
import type { RunDetail, SummaryRow } from '../types';
import { TARGET_ORDER } from '../types';
import { fmtCompact, fmtMB, fmtMs, fmtNum, fmtPct, isNum } from '../lib/format';
import { SUMMARY_METRICS, hasData, isChatScenario, samplesToRows, type SummaryMetric } from '../lib/runData';
import { DeltaBadge } from './DeltaBadge';
import { PercentileTable } from './PercentileTable';
import { LatencyHistogram } from './LatencyHistogram';
import { PairedChart, SeriesChart, GO_PY_SERIES } from './charts';
import { SuspectFlag } from './SuspectFlag';
import { Card, EmptyState, Segmented } from './ui';

export function fmtKind(v: number | null | undefined, kind: SummaryMetric['kind']): string {
  switch (kind) {
    case 'ms':
      return fmtMs(v);
    case 'pct':
      return fmtPct(v, 2);
    case 'mb':
      return fmtMB(v);
    default:
      return isNum(v) && Math.abs(v) < 100 ? fmtNum(v, 1) : fmtNum(v);
  }
}

export function HeadlineBanner({ d }: { d: RunDetail }) {
  const g = d.summary.go;
  const p = d.summary.python;
  if (!g || !p) {
    return <div className="card px-4 py-3 text-sm text-muted">Single-target run: no Go-vs-Python delta.</div>;
  }
  const chat = isChatScenario(d);
  const items: { key: keyof SummaryRow; label: string; bw: 'lower' | 'higher' }[] = [
    { key: 'rps', label: 'RPS', bw: 'higher' },
    { key: 'p99_ms', label: 'p99', bw: 'lower' },
    { key: 'mem_mb', label: 'memory', bw: 'lower' },
    { key: 'rps_per_core', label: 'RPS/core', bw: 'higher' },
  ];
  if (chat) items.splice(1, 0, { key: 'overhead_p50_ms', label: 'overhead p50', bw: 'lower' });
  return (
    <div className="card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3" aria-label="Headline deltas, Go relative to Python">
      <span className="text-sm font-semibold">Go vs Python</span>
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1.5 text-sm">
          <DeltaBadge go={g[i.key]} py={p[i.key]} betterWhen={i.bw} metric={i.label} className="text-sm" />
          <span className="text-muted">{i.label}</span>
        </span>
      ))}
      {chat && d.run.layer === 'L4' && <span className="text-xs text-muted">Gemini latency dominates totals; overhead is the server-side signal.</span>}
    </div>
  );
}

export function SummaryTable({ d }: { d: RunDetail }) {
  const metrics = SUMMARY_METRICS.filter((m) => TARGET_ORDER.some((t) => isNum(d.summary[t]?.[m.key])));
  return (
    <table className="table-dense w-full text-sm">
      <caption className="mb-1 text-left text-xs text-muted">Median across reps</caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col" className="text-right"><span className="text-gofg">Go</span></th>
          <th scope="col" className="text-right"><span className="text-pyfg">Python</span></th>
          <th scope="col" className="text-right">Δ</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((m) => (
          <tr key={m.key}>
            <th scope="row" className="px-2 py-1.5 text-left font-normal">{m.label}</th>
            <td className="num text-right">{fmtKind(d.summary.go?.[m.key], m.kind)}</td>
            <td className="num text-right">{fmtKind(d.summary.python?.[m.key], m.kind)}</td>
            <td className="text-right"><DeltaBadge go={d.summary.go?.[m.key]} py={d.summary.python?.[m.key]} betterWhen={m.betterWhen} metric={m.label} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunResults({ d }: { d: RunDetail }) {
  const reps = useMemo(() => [...new Set(d.samples.map((s) => s.rep))].sort((a, b) => a - b), [d.samples]);
  const [rep, setRep] = useState<'all' | string>('all');
  const repSel = rep === 'all' ? 'all' : Number(rep);
  const rows = useMemo(
    () => ({
      rps: samplesToRows(d.samples, repSel, 'rps'),
      p99: samplesToRows(d.samples, repSel, 'lat_p99_ms'),
      cpu: samplesToRows(d.samples, repSel, 'cpu_pct'),
      mem: samplesToRows(d.samples, repSel, 'mem_mb'),
      replicas: samplesToRows(d.samples, repSel, 'replicas'),
      threads: samplesToRows(d.samples, repSel, 'threads'),
    }),
    [d.samples, repSel],
  );
  const showReplicas = d.run.layer === 'k8s' || hasData(rows.replicas);
  const errorsTotal = d.results.reduce((a, r) => a + r.errors_total, 0);

  return (
    <div className="space-y-4">
      {d.run.suspect && <SuspectFlag variant="banner" reasons={d.run.suspect_reasons} />}
      <HeadlineBanner d={d} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Latency percentiles">{d.results.length ? <PercentileTable results={d.results} /> : <p className="text-sm text-muted">No results.</p>}</Card>
        <Card title="Summary & derived metrics">
          <SummaryTable d={d} />
        </Card>
      </div>
      <Card title="Latency distribution (log scale, % of requests)">
        <LatencyHistogram results={d.results} />
      </Card>
      {d.samples.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Over time</h2>
            <Segmented
              label="Repetition"
              size="xs"
              value={rep}
              onChange={setRep}
              options={[{ value: 'all', label: 'avg of reps' }, ...reps.map((r) => ({ value: String(r), label: `rep ${r}` }))]}
            />
            <span className="text-xs text-muted">x = seconds since target start</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <PairedChart title="RPS" data={rows.rps} mode="overlay" height={180} />
            <PairedChart title="p99 latency" unit="ms" data={rows.p99} mode="overlay" height={180} latestFormat={fmtMs} />
            <PairedChart title="CPU" unit="%" data={rows.cpu} mode="overlay" height={180} />
            <PairedChart title="Memory" unit="MB" data={rows.mem} mode="overlay" height={180} latestFormat={fmtMB} />
            {hasData(rows.threads) && <PairedChart title="Threads / goroutines" data={rows.threads} mode="overlay" height={160} />}
            {showReplicas && (
              <div className="card p-3">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Replicas (k8s)</h3>
                {hasData(rows.replicas) ? (
                  <SeriesChart data={rows.replicas} series={GO_PY_SERIES} step legend height={160} yFormat={(v) => v.toFixed(0)} ariaLabel="Replica count over time, Go and Python" />
                ) : (
                  <p className="text-sm text-muted">No replica samples recorded.</p>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <EmptyState title="No time-series samples">This run has no per-second samples.</EmptyState>
      )}
      <Card title={`Raw results per rep (${d.results.length} rows · ${fmtNum(errorsTotal)} errors)`} bodyClass="p-0 overflow-x-auto">
        <table className="table-dense w-full text-xs">
          <thead>
            <tr>
              <th>Rep</th><th>Order</th><th>Target</th><th className="text-right">Requests</th><th className="text-right">Errors</th><th className="text-right">RPS</th>
              <th className="text-right">p50</th><th className="text-right">p99</th><th className="text-right">CPU avg</th><th className="text-right">Throttled</th><th className="text-right">Mem max</th>
              {d.results.some((r) => isNum(r.max_replicas)) && <th className="text-right">Max replicas</th>}
              {d.results.some((r) => isNum(r.rollout_errors)) && <th className="text-right">Rollout errors</th>}
            </tr>
          </thead>
          <tbody>
            {[...d.results].sort((a, b) => a.rep - b.rep || a.order_in_rep - b.order_in_rep).map((r) => (
              <tr key={`${r.rep}-${r.target}`}>
                <td className="num">{r.rep}</td>
                <td className="num">{r.order_in_rep}</td>
                <td className={r.target === 'go' ? 'text-gofg' : 'text-pyfg'}>{r.target === 'go' ? 'Go' : 'Python'}</td>
                <td className="num text-right">{fmtNum(r.requests_total)}</td>
                <td className={`num text-right ${r.errors_total ? 'text-worse' : ''}`}>{fmtNum(r.errors_total)}</td>
                <td className="num text-right">{fmtCompact(r.rps)}</td>
                <td className="num text-right">{fmtMs(r.lat_p50_ms)}</td>
                <td className="num text-right">{fmtMs(r.lat_p99_ms)}</td>
                <td className="num text-right">{fmtPct(r.cpu_avg_pct, 0)}</td>
                <td className="num text-right">{fmtPct(r.cpu_throttled_pct, 1)}</td>
                <td className="num text-right">{fmtMB(r.mem_max_mb)}</td>
                {d.results.some((x) => isNum(x.max_replicas)) && <td className="num text-right">{r.max_replicas ?? '—'}</td>}
                {d.results.some((x) => isNum(x.rollout_errors)) && <td className="num text-right">{r.rollout_errors ?? '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {d.run.environment && (
        <details className="card p-3 text-sm">
          <summary className="cursor-pointer font-medium">Environment snapshot</summary>
          <pre className="mt-2 overflow-x-auto font-mono text-xs text-muted">{JSON.stringify(d.run.environment, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
