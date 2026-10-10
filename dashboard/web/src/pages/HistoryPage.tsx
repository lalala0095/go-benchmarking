import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, GitCompare, RotateCw } from 'lucide-react';
import type { PlatformMode, RunStatus, RunSummary } from '../types';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { fmtCompact, fmtDate, fmtDuration, fmtMB, fmtMs, shortId } from '../lib/format';
import { computeDelta } from '../lib/delta';
import { DeltaBadge } from '../components/DeltaBadge';
import { PlatformBadge } from '../components/PlatformBadge';
import { SuspectFlag } from '../components/SuspectFlag';
import { EmptyState, ErrorCard, Skeleton, cx } from '../components/ui';

type SortKey = 'created_at' | 'scenario' | 'layer' | 'platform' | 'status' | 'go_rps' | 'py_rps' | 'rps_delta' | 'go_p99' | 'py_p99' | 'p99_delta' | 'go_mem' | 'py_mem';

function sortValue(r: RunSummary, k: SortKey): number | string | null {
  const h = r.headline;
  switch (k) {
    case 'created_at': return r.created_at;
    case 'scenario': return r.scenario;
    case 'layer': return r.layer;
    case 'platform': return r.platform;
    case 'status': return r.status;
    case 'go_rps': return h?.go?.rps ?? null;
    case 'py_rps': return h?.python?.rps ?? null;
    case 'rps_delta': return computeDelta(h?.go?.rps, h?.python?.rps, 'higher').pct;
    case 'go_p99': return h?.go?.p99_ms ?? null;
    case 'py_p99': return h?.python?.p99_ms ?? null;
    case 'p99_delta': return computeDelta(h?.go?.p99_ms, h?.python?.p99_ms, 'lower').pct;
    case 'go_mem': return h?.go?.mem_mb ?? null;
    case 'py_mem': return h?.python?.mem_mb ?? null;
  }
}

const STATUS_CLS: Record<RunStatus, string> = {
  complete: 'text-better', failed: 'text-worse', cancelled: 'text-muted', queued: 'text-muted', preflight: 'text-go', running: 'text-go', analyzing: 'text-go',
};

export default function HistoryPage() {
  const navigate = useNavigate();
  const [scenario, setScenario] = useState('');
  const [platform, setPlatform] = useState<PlatformMode | ''>('');
  const [status, setStatus] = useState<RunStatus | ''>('');
  const runs = useAsync(() => api.runs({ scenario, platform, status, limit: 200 }), [scenario, platform, status]);
  const scenarios = useAsync(() => api.scenarios(), []);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'created_at', dir: -1 });
  const [picked, setPicked] = useState<string[]>([]);

  const rows = useMemo(() => {
    const list = [...(runs.data ?? [])];
    list.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
    return list;
  }, [runs.data, sort]);

  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1], id] : [...p, id]));
  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => {
    const active = sort.key === k;
    const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
    return (
      <th scope="col" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={right ? 'text-right' : undefined}>
        <button type="button" className={cx('inline-flex items-center gap-1 uppercase', active && 'text-text')} onClick={() => setSort({ key: k, dir: active ? (sort.dir === 1 ? -1 : 1) : -1 })}>
          {children}
          <Icon className="h-3 w-3" aria-hidden="true" />
        </button>
      </th>
    );
  };

  const filtered = !!(scenario || platform || status);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">History</h1>
        <select className="input" value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Filter by scenario">
          <option value="">All scenarios</option>
          {scenarios.data?.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
        <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as PlatformMode | '')} aria-label="Filter by platform">
          <option value="">All platforms</option>
          <option value="compose">compose</option>
          <option value="k8s">k8s</option>
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | '')} aria-label="Filter by status">
          <option value="">Any status</option>
          {(['complete', 'failed', 'cancelled', 'running', 'queued'] as RunStatus[]).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="button" className="btn-ghost" onClick={runs.reload} aria-label="Refresh"><RotateCw className="h-4 w-4" aria-hidden="true" /></button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted">{picked.length}/2 selected</span>
          <button type="button" className="btn-primary" disabled={picked.length !== 2} onClick={() => navigate(`/compare?a=${picked[0]}&b=${picked[1]}`)}>
            <GitCompare className="h-4 w-4" aria-hidden="true" /> Compare
          </button>
        </div>
      </div>
      {runs.error && <ErrorCard title="Could not load runs" error={runs.error} onRetry={runs.reload} />}
      {runs.loading && !runs.data ? (
        <Skeleton lines={10} className="h-6" />
      ) : runs.data && !runs.data.length ? (
        filtered ? (
          <EmptyState title="No runs match these filters" />
        ) : (
          <EmptyState title="No runs yet" action={<Link className="btn-primary" to="/bench">Go to Benchmarks</Link>}>
            Start with <strong>ping</strong>, the 20-second smoke test.
          </EmptyState>
        )
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-dense w-full whitespace-nowrap text-sm">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Select</span></th>
                <Th k="created_at">Date</Th>
                <Th k="scenario">Scenario</Th>
                <Th k="layer">Layer</Th>
                <Th k="platform">Platform</Th>
                <Th k="status">Status</Th>
                <Th k="go_rps" right>Go RPS</Th>
                <Th k="py_rps" right>Py RPS</Th>
                <Th k="rps_delta" right>Δ RPS</Th>
                <Th k="go_p99" right>Go p99</Th>
                <Th k="py_p99" right>Py p99</Th>
                <Th k="p99_delta" right>Δ p99</Th>
                <Th k="go_mem" right>Go mem</Th>
                <Th k="py_mem" right>Py mem</Th>
                <th scope="col">Dur.</th>
                <th scope="col"><span className="sr-only">Suspect</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const h = r.headline;
                const sel = picked.includes(r.id);
                return (
                  <tr key={r.id} className={cx('cursor-pointer hover:bg-surface2', sel && 'bg-go/5')} onClick={() => navigate(`/bench/${r.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel} onChange={() => togglePick(r.id)} aria-label={`Select run ${shortId(r.id)} for comparison`} />
                    </td>
                    <td className="num text-xs"><Link to={`/bench/${r.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{fmtDate(r.created_at)}</Link></td>
                    <td className="font-medium">{r.scenario}</td>
                    <td className="text-xs text-muted">{r.layer}</td>
                    <td><PlatformBadge mode={r.platform} /></td>
                    <td className={cx('text-xs font-medium', STATUS_CLS[r.status])}>{r.status}</td>
                    <td className="num text-right">{fmtCompact(h?.go?.rps)}</td>
                    <td className="num text-right">{fmtCompact(h?.python?.rps)}</td>
                    <td className="text-right">{h?.go && h.python ? <DeltaBadge go={h.go.rps} py={h.python.rps} betterWhen="higher" metric="RPS" /> : '—'}</td>
                    <td className="num text-right">{fmtMs(h?.go?.p99_ms)}</td>
                    <td className="num text-right">{fmtMs(h?.python?.p99_ms)}</td>
                    <td className="text-right">{h?.go && h.python ? <DeltaBadge go={h.go.p99_ms} py={h.python.p99_ms} betterWhen="lower" metric="p99" /> : '—'}</td>
                    <td className="num text-right">{fmtMB(h?.go?.mem_mb)}</td>
                    <td className="num text-right">{fmtMB(h?.python?.mem_mb)}</td>
                    <td className="num text-xs text-muted">{fmtDuration(r.started_at, r.finished_at)}</td>
                    <td>{r.suspect && <SuspectFlag reasons={r.suspect_reasons} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
