import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, GitCompare, RotateCw, Square } from 'lucide-react';
import type { RunDetail, RunStreamEvent, Target } from '../types';
import { TARGET_ORDER, TARGET_LABEL } from '../types';
import { api, ApiError, downloadBlob, type ExportFormat } from '../api';
import { useAsync } from '../hooks/useAsync';
import { fmtCompact, fmtDate, fmtDuration, fmtMs, fmtMB, fmtPct, shortId } from '../lib/format';
import { TERMINAL, initialLiveRun, latestProgress, liveRunReducer, type LiveRunState } from '../lib/runData';
import { RunPhaseStepper } from '../components/RunPhaseStepper';
import { RunResults } from '../components/RunResults';
import { PlatformBadge } from '../components/PlatformBadge';
import { SuspectFlag } from '../components/SuspectFlag';
import { TargetBadge } from '../components/TargetBadge';
import { PairedChart, type Row } from '../components/charts';
import { useRunLauncher } from '../components/RunLauncher';
import { Dialog, EmptyState, ErrorCard, PageSkeleton, Skeleton, cx } from '../components/ui';

type Action = { type: 'event'; e: RunStreamEvent } | { type: 'init'; status: LiveRunState['status'] };
function reducer(s: LiveRunState, a: Action): LiveRunState {
  return a.type === 'init' ? initialLiveRun(a.status) : liveRunReducer(s, a.e);
}

export default function RunPage() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const detail = useAsync(() => api.run(runId), [runId]);
  const scenarios = useAsync(() => api.scenarios(), []);
  const [live, dispatch] = useReducer(reducer, initialLiveRun());
  const [streamErr, setStreamErr] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [actionErr, setActionErr] = useState<unknown>();
  const { launch, ui: launcherUi } = useRunLauncher();

  const baseStatus = detail.data?.run.status;
  const needsStream = !!detail.data && !TERMINAL.has(baseStatus ?? '');
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  useEffect(() => {
    if (!needsStream) return;
    dispatch({ type: 'init', status: baseStatus ?? 'queued' });
    setStreamErr(false);
    const unsub = api.runStream(runId, {
      onEvent: (e) => {
        setStreamErr(false);
        dispatch({ type: 'event', e });
      },
      onError: () => setStreamErr(true),
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, needsStream]);

  // Once the stream completes, swap in the full detail.
  useEffect(() => {
    if (live.detail) detail.setData(live.detail);
    else if (live.status === 'failed' || live.status === 'cancelled') detail.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.detail, live.status === 'failed' || live.status === 'cancelled']);

  const d = detail.data;
  const scenario = scenarios.data?.find((s) => s.id === d?.run.scenario);
  const status = needsStream ? live.status : d?.run.status;

  const doExport = async (format: ExportFormat) => {
    setExporting(format);
    setActionErr(undefined);
    try {
      const { blob, filename } = await api.exportRun(runId, format);
      downloadBlob(blob, filename);
    } catch (e) {
      setActionErr(e);
    } finally {
      setExporting(null);
    }
  };
  const cancel = async () => {
    try {
      await api.cancelRun(runId);
    } catch (e) {
      setActionErr(e);
    }
  };

  if (detail.loading && !d) return <PageSkeleton />;
  if (notFound) return <EmptyState title="Run not found" action={<Link className="btn" to="/history">Back to history</Link>}>No run with id <code className="font-mono">{runId}</code>.</EmptyState>;
  if (detail.error && !d) return <ErrorCard title="Could not load run" error={detail.error} onRetry={detail.reload} />;
  if (!d) return null;

  const complete = status === 'complete' && d.results.length > 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/history" className="btn-ghost" aria-label="Back to history"><ArrowLeft className="h-4 w-4" aria-hidden="true" /></Link>
        <h1 className="text-lg font-semibold">{scenario?.title ?? d.run.scenario}</h1>
        <code className="font-mono text-xs text-muted">{shortId(d.run.id)}</code>
        <PlatformBadge mode={d.run.platform} />
        <span className={cx('chip', status === 'complete' ? 'text-better' : status === 'failed' ? 'text-worse' : 'text-muted')}>{status}</span>
        {d.run.suspect && <SuspectFlag reasons={d.run.suspect_reasons} />}
        <span className="text-xs text-muted">
          {fmtDate(d.run.created_at)} · {fmtDuration(d.run.started_at, d.run.finished_at)} · c={d.run.config.concurrency}
          {d.run.config.duration_s ? ` · ${d.run.config.duration_s}s` : ''}
          {d.run.config.requests ? ` · ${d.run.config.requests} req` : ''} · {d.run.config.reps} reps
          {d.run.config.py_profile ? ` · ${d.run.config.py_profile}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {!TERMINAL.has(status ?? '') ? (
            <button type="button" className="btn-danger" onClick={() => void cancel()}>
              <Square className="h-4 w-4" aria-hidden="true" /> Cancel run
            </button>
          ) : (
            <>
              {complete && (['json', 'csv', 'md'] as ExportFormat[]).map((f) => (
                <button key={f} type="button" className="btn" onClick={() => void doExport(f)} disabled={!!exporting}>
                  <Download className="h-4 w-4" aria-hidden="true" /> {f.toUpperCase()}
                </button>
              ))}
              {complete && (
                <button type="button" className="btn" onClick={() => setCompareOpen(true)}>
                  <GitCompare className="h-4 w-4" aria-hidden="true" /> Compare with…
                </button>
              )}
              <button type="button" className="btn-primary" disabled={!scenario} onClick={() => scenario && launch({ scenario, config: d.run.config, notes: `re-run of ${shortId(d.run.id)}` })}>
                <RotateCw className="h-4 w-4" aria-hidden="true" /> Re-run
              </button>
            </>
          )}
        </div>
      </div>
      {launcherUi}
      {actionErr !== undefined && <ErrorCard error={actionErr} />}
      {d.run.notes && <p className="text-sm text-muted">Notes: {d.run.notes}</p>}

      {!TERMINAL.has(status ?? '') && <RunningView live={live} detail={d} streamErr={streamErr} />}
      {status === 'failed' && <ErrorCard title="Run failed" error={live.error ?? d.run.error ?? 'Unknown error'} hint="Check the dashboard server logs and target health, then re-run." />}
      {status === 'cancelled' && <EmptyState title="Run cancelled">Partial data is discarded. Start it again with Re-run.</EmptyState>}
      {complete && <RunResults d={d} />}
      {status === 'complete' && !d.results.length && <Skeleton className="h-64" />}

      <CompareDialog open={compareOpen} onClose={() => setCompareOpen(false)} run={d} onPick={(other) => navigate(`/compare?a=${d.run.id}&b=${other}`)} />
    </div>
  );
}

function RunningView({ live, detail, streamErr }: { live: LiveRunState; detail: RunDetail; streamErr: boolean }) {
  const ph = live.phase;
  const rep = ph?.rep ?? 0;
  const rows = useMemo(() => {
    const cur = live.progress.filter((p) => p.rep === (rep || 1));
    const mk = (k: 'rps' | 'p99_ms' | 'cpu_pct' | 'mem_mb'): Row[] => {
      const by = new Map<number, Row>();
      for (const p of cur) {
        const r = by.get(p.t_offset_s) ?? { x: p.t_offset_s };
        r[p.target] = p[k];
        by.set(p.t_offset_s, r);
      }
      return [...by.values()].sort((a, b) => a.x - b.x);
    };
    return { rps: mk('rps'), p99: mk('p99_ms'), cpu: mk('cpu_pct'), mem: mk('mem_mb') };
  }, [live.progress, rep]);

  return (
    <div className="space-y-4">
      {streamErr && <ErrorCard compact title="Live stream interrupted" error="Reconnecting to /api/runs/:id/stream…" />}
      <div className="card p-4">
        <RunPhaseStepper status={live.status} phase={ph?.phase ?? null} rep={rep} reps={ph?.reps ?? detail.run.config.reps} target={ph?.target ?? null} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TARGET_ORDER.filter((t) => detail.run.config.targets.includes(t)).map((t) => (
          <BigRps key={t} target={t} live={live} active={ph?.target === t && ph.phase === 'run'} />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <PairedChart title={`Live RPS · rep ${rep || 1}`} data={rows.rps} mode="overlay" height={160} />
        <PairedChart title="Live p99 latency" unit="ms" data={rows.p99} mode="overlay" height={160} latestFormat={fmtMs} />
        <PairedChart title="Live CPU" unit="%" data={rows.cpu} mode="overlay" height={160} />
        <PairedChart title="Live memory" unit="MB" data={rows.mem} mode="overlay" height={160} latestFormat={fmtMB} />
      </div>
      <section className="card" aria-label="Run log">
        <h2 className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Log</h2>
        <ol className="max-h-56 overflow-y-auto p-3 font-mono text-xs" aria-live="polite">
          {live.logs.length === 0 && <li className="text-muted">Waiting for events…</li>}
          {live.logs.map((l, i) => (
            <li key={i} className={l.level === 'error' ? 'text-worse' : l.level === 'warn' ? 'text-warn' : ''}>
              <span className="text-muted">{new Date(l.at).toLocaleTimeString('en-US', { hour12: false })}</span> {l.message}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function BigRps({ target, live, active }: { target: Target; live: LiveRunState; active: boolean }) {
  const p = latestProgress(live, target);
  return (
    <div className={cx('card p-4', active && (target === 'go' ? 'border-go' : 'border-py'))}>
      <div className="flex items-center justify-between">
        <TargetBadge target={target} />
        <span className="text-xs text-muted">{active ? 'measuring now' : p ? `rep ${p.rep} done` : 'waiting'}</span>
      </div>
      <div className="num mt-2 text-4xl font-semibold" aria-live="polite" aria-label={`${TARGET_LABEL[target]} requests per second`}>
        {fmtCompact(p?.rps)} <span className="text-base font-normal text-muted">RPS</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
        <span>p50 <span className="num text-text">{fmtMs(p?.p50_ms)}</span></span>
        <span>p99 <span className="num text-text">{fmtMs(p?.p99_ms)}</span></span>
        <span>errors <span className={cx('num', p?.errors ? 'text-worse' : 'text-text')}>{p?.errors ?? '—'}</span></span>
        <span>CPU <span className="num text-text">{fmtPct(p?.cpu_pct, 0)}</span></span>
        <span>mem <span className="num text-text">{fmtMB(p?.mem_mb)}</span></span>
        {p?.replicas != null && <span>replicas <span className="num text-text">{p.replicas}</span></span>}
      </div>
    </div>
  );
}

function CompareDialog({ open, onClose, run, onPick }: { open: boolean; onClose: () => void; run: RunDetail; onPick: (id: string) => void }) {
  const [sameScenario, setSameScenario] = useState(true);
  const runs = useAsync(() => api.runs({ scenario: sameScenario ? run.run.scenario : undefined, status: 'complete', limit: 50 }), [open, sameScenario], { enabled: open });
  const list = (runs.data ?? []).filter((r) => r.id !== run.run.id);
  return (
    <Dialog open={open} onClose={onClose} title="Compare with…" wide>
      <label className="mb-3 inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sameScenario} onChange={(e) => setSameScenario(e.target.checked)} /> Same scenario only ({run.run.scenario})
      </label>
      {runs.loading && !runs.data ? (
        <Skeleton lines={4} />
      ) : runs.error ? (
        <ErrorCard compact error={runs.error} onRetry={runs.reload} />
      ) : !list.length ? (
        <p className="text-sm text-muted">No other completed runs to compare with.</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((r) => (
            <li key={r.id}>
              <button type="button" className="flex w-full flex-wrap items-center gap-3 px-2 py-2 text-left text-sm hover:bg-surface2" onClick={() => onPick(r.id)}>
                <code className="font-mono text-xs">{shortId(r.id)}</code>
                <span className="font-medium">{r.scenario}</span>
                <PlatformBadge mode={r.platform} />
                {r.suspect && <SuspectFlag reasons={r.suspect_reasons} />}
                <span className="text-xs text-muted">{fmtDate(r.created_at)}</span>
                <span className="num ml-auto text-xs">Go {fmtCompact(r.headline?.go?.rps)} · Py {fmtCompact(r.headline?.python?.rps)} RPS</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
