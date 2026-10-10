import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Download } from 'lucide-react';
import type { RunDetail, Target } from '../types';
import { TARGET_ORDER, TARGET_LABEL } from '../types';
import { api, downloadBlob } from '../api';
import { useAsync } from '../hooks/useAsync';
import { computeDelta } from '../lib/delta';
import { fmtCompact, fmtDate, fmtMs, shortId } from '../lib/format';
import { SUMMARY_METRICS, samplesToRows } from '../lib/runData';
import { DeltaBadge } from '../components/DeltaBadge';
import { HeadlineBanner, fmtKind } from '../components/RunResults';
import { PlatformBadge } from '../components/PlatformBadge';
import { SuspectFlag } from '../components/SuspectFlag';
import { COLOR, SeriesChart, type Row } from '../components/charts';
import { Card, EmptyState, ErrorCard, PageSkeleton } from '../components/ui';

export default function ComparePage() {
  const [params, setParams] = useSearchParams();
  const a = params.get('a');
  const b = params.get('b');
  if (!a || !b) return <ComparePicker onPick={(x, y) => setParams({ a: x, b: y })} />;
  return <CompareView a={a} b={b} swap={() => setParams({ a: b, b: a })} />;
}

function ComparePicker({ onPick }: { onPick: (a: string, b: string) => void }) {
  const runs = useAsync(() => api.runs({ status: 'complete', limit: 100 }), []);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const label = (id: string) => {
    const r = runs.data?.find((x) => x.id === id);
    return r ? `${r.scenario} · ${r.platform} · ${fmtDate(r.created_at)} · ${shortId(r.id)}` : id;
  };
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Compare runs</h1>
      <p className="text-sm text-muted">Pick two completed runs: e.g. the same scenario on Compose vs k8s, or before/after a change. You can also select two rows in <Link className="underline" to="/history">History</Link>.</p>
      {runs.error && <ErrorCard error={runs.error} onRetry={runs.reload} />}
      {runs.data && runs.data.length < 2 ? (
        <EmptyState title="Need at least two completed runs" action={<Link className="btn-primary" to="/bench">Go to Benchmarks</Link>}>
          No runs yet? Start with <strong>ping</strong>, the 20-second smoke test.
        </EmptyState>
      ) : (
        <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); if (a && b) onPick(a, b); }}>
          {([['Run A', a, setA], ['Run B', b, setB]] as const).map(([l, v, set]) => (
            <label key={l} className="flex min-w-[260px] flex-1 flex-col gap-1">
              <span className="label">{l}</span>
              <select className="input" value={v} onChange={(e) => set(e.target.value)} disabled={runs.loading}>
                <option value="">Select…</option>
                {runs.data?.map((r) => <option key={r.id} value={r.id}>{label(r.id)}</option>)}
              </select>
            </label>
          ))}
          <button type="submit" className="btn-primary" disabled={!a || !b || a === b}>Compare</button>
        </form>
      )}
    </div>
  );
}

function RunHeader({ d, tag }: { d: RunDetail; tag: string }) {
  const c = d.run.config;
  return (
    <div className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-surface2 px-1.5 font-mono text-xs font-semibold">{tag}</span>
        <Link to={`/bench/${d.run.id}`} className="font-semibold hover:underline">{d.run.scenario}</Link>
        <code className="font-mono text-xs text-muted">{shortId(d.run.id)}</code>
        <PlatformBadge mode={d.run.platform} />
        {d.run.suspect && <SuspectFlag reasons={d.run.suspect_reasons} />}
      </div>
      <p className="num text-xs text-muted">
        {fmtDate(d.run.created_at)} · c={c.concurrency}{c.duration_s ? ` · ${c.duration_s}s` : ''}{c.requests ? ` · ${c.requests} req` : ''} · {c.reps} reps{c.py_profile ? ` · ${c.py_profile}` : ''}
      </p>
      <HeadlineBanner d={d} />
    </div>
  );
}

function mergeRows(a: RunDetail, b: RunDetail, key: 'rps' | 'lat_p99_ms' | 'cpu_pct' | 'mem_mb'): Row[] {
  const by = new Map<number, Row>();
  for (const [tag, d] of [['a', a], ['b', b]] as const) {
    for (const r of samplesToRows(d.samples, 'all', key)) {
      const row = by.get(r.x) ?? { x: r.x };
      for (const t of TARGET_ORDER) row[`${tag}_${t}`] = r[t] ?? null;
      by.set(r.x, row);
    }
  }
  return [...by.values()].sort((x, y) => x.x - y.x);
}

const SERIES = [
  { key: 'a_go', label: 'A · Go', color: COLOR.go },
  { key: 'a_python', label: 'A · Python', color: COLOR.python },
  { key: 'b_go', label: 'B · Go', color: COLOR.go, dashed: true },
  { key: 'b_python', label: 'B · Python', color: COLOR.python, dashed: true },
];

export function compareMarkdown(a: RunDetail, b: RunDetail): string {
  const lines = [
    `# Comparison: ${a.run.scenario} (${a.run.platform}) vs ${b.run.scenario} (${b.run.platform})`,
    '',
    `- A: \`${a.run.id}\` · ${a.run.created_at} · platform ${a.run.platform}${a.run.suspect ? ' · SUSPECT' : ''}`,
    `- B: \`${b.run.id}\` · ${b.run.created_at} · platform ${b.run.platform}${b.run.suspect ? ' · SUSPECT' : ''}`,
    '',
    '| metric | A Go | B Go | Δ Go (B vs A) | A Py | B Py | Δ Py (B vs A) |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const m of SUMMARY_METRICS) {
    const cells: string[] = [m.label];
    for (const t of TARGET_ORDER) {
      const va = a.summary[t]?.[m.key];
      const vb = b.summary[t]?.[m.key];
      cells.push(fmtKind(va, m.kind), fmtKind(vb, m.kind), computeDelta(vb, va, m.betterWhen).label);
    }
    if (cells.slice(1).every((c) => c === '—')) continue;
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('', '_Δ = B relative to A. Generated by the ADK bench dashboard._', '');
  return lines.join('\n');
}

function CompareView({ a, b, swap }: { a: string; b: string; swap: () => void }) {
  const data = useAsync(() => api.compare(a, b), [a, b]);
  const charts = useMemo(() => {
    if (!data.data) return null;
    const { a: A, b: B } = data.data;
    return { rps: mergeRows(A, B, 'rps'), p99: mergeRows(A, B, 'lat_p99_ms'), cpu: mergeRows(A, B, 'cpu_pct'), mem: mergeRows(A, B, 'mem_mb') };
  }, [data.data]);

  if (data.loading && !data.data) return <PageSkeleton />;
  if (data.error) return <ErrorCard title="Could not load comparison" error={data.error} onRetry={data.reload} />;
  if (!data.data || !charts) return null;
  const { a: A, b: B } = data.data;
  const crossPlatform = A.run.platform !== B.run.platform;
  const metrics = SUMMARY_METRICS.filter((m) => TARGET_ORDER.some((t) => A.summary[t]?.[m.key] != null || B.summary[t]?.[m.key] != null));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Compare</h1>
        {crossPlatform && <span className="chip text-go">cross-platform: {A.run.platform} vs {B.run.platform}</span>}
        {A.run.scenario !== B.run.scenario && <span className="chip text-warn">different scenarios: interpret with care</span>}
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn" onClick={swap}><ArrowLeftRight className="h-4 w-4" aria-hidden="true" /> Swap A/B</button>
          <button type="button" className="btn" onClick={() => downloadBlob(new Blob([compareMarkdown(A, B)], { type: 'text/markdown' }), `compare-${shortId(A.run.id)}-${shortId(B.run.id)}.md`)}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export MD
          </button>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <RunHeader d={A} tag="A" />
        <RunHeader d={B} tag="B" />
      </div>
      <Card title="B relative to A, per target" bodyClass="p-0 overflow-x-auto">
        <table className="table-dense w-full whitespace-nowrap text-sm">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {TARGET_ORDER.map((t) => (
                <th key={t} scope="colgroup" colSpan={3} className="text-center">
                  <span className={t === 'go' ? 'text-gofg' : 'text-pyfg'}>{TARGET_LABEL[t]}</span>
                </th>
              ))}
            </tr>
            <tr>
              <th />
              {TARGET_ORDER.map((t) => (
                <ColHeads key={t} />
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.key}>
                <th scope="row" className="px-2 py-1.5 text-left font-normal">{m.label}</th>
                {TARGET_ORDER.map((t: Target) => (
                  <Cells key={t} va={A.summary[t]?.[m.key]} vb={B.summary[t]?.[m.key]} kind={m.kind} bw={m.betterWhen} label={`${TARGET_LABEL[t]} ${m.label}`} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-muted">Charts: solid = run A, dashed = run B; seconds since each target's start, averaged across reps.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {([['RPS', charts.rps, fmtCompact], ['p99 latency (ms)', charts.p99, fmtMs], ['CPU (%)', charts.cpu, fmtCompact], ['Memory (MB)', charts.mem, fmtCompact]] as const).map(([title, rows, f]) => (
          <div key={title} className="card p-3">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
            <SeriesChart data={rows} series={SERIES} legend height={200} yFormat={(v) => f(v)} ariaLabel={`${title} over time for runs A and B, Go and Python`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ColHeads() {
  return (
    <>
      <th scope="col" className="text-right">A</th>
      <th scope="col" className="text-right">B</th>
      <th scope="col" className="text-right">Δ B vs A</th>
    </>
  );
}

function Cells({ va, vb, kind, bw, label }: { va: number | null | undefined; vb: number | null | undefined; kind: (typeof SUMMARY_METRICS)[number]['kind']; bw: 'lower' | 'higher'; label: string }) {
  return (
    <>
      <td className="num text-right">{fmtKind(va, kind)}</td>
      <td className="num text-right">{fmtKind(vb, kind)}</td>
      <td className="text-right"><DeltaBadge go={vb} py={va} betterWhen={bw} metric={label} names={['B', 'A']} /></td>
    </>
  );
}
