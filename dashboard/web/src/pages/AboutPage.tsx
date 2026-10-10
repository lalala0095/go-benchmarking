import { useEffect, useState } from 'react';
import { Download, Eye, FileText, Gauge, Pencil, RotateCw, Save } from 'lucide-react';
import type { PlatformInfo, ResourceLimits, ServerInfo, StaticMeasurement, Target } from '../types';
import { TARGET_ORDER, TARGET_LABEL } from '../types';
import { api, downloadBlob, type DxNotes } from '../api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { fmtBytes, fmtDate, fmtMB, fmtMs, fmtNum, isNum } from '../lib/format';
import { DeltaBadge } from '../components/DeltaBadge';
import { HealthDot } from '../components/HealthDot';
import { PlatformBadge } from '../components/PlatformBadge';
import { TargetBadge } from '../components/TargetBadge';
import { Card, EmptyState, ErrorCard, Skeleton, Segmented, cx } from '../components/ui';

export default function AboutPage() {
  const { targets, targetsError, refreshTargets, platform } = useApp();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Environment</h1>
        <PlatformBadge mode={platform?.mode} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <PlatformPanel platform={platform} />
        <Card title="Versions" actions={<button type="button" className="btn-ghost" onClick={refreshTargets} aria-label="Refresh versions"><RotateCw className="h-4 w-4" aria-hidden="true" /></button>} bodyClass="p-0 overflow-x-auto">
          {targetsError && !targets ? <div className="p-4"><ErrorCard compact error={targetsError} onRetry={refreshTargets} /></div> : !targets ? <div className="p-4"><Skeleton lines={8} /></div> : <VersionsTable info={{ go: targets.go?.info, python: targets.python?.info }} health={{ go: targets.go, python: targets.python }} />}
        </Card>
      </div>
      <StaticPanel />
      <DxNotesPanel />
      <ReportPanel />
    </div>
  );
}

function limitsText(l: ResourceLimits | undefined): string {
  if (!l) return '—';
  const parts = [isNum(l.cpus) ? `${l.cpus} CPU` : 'no CPU limit', isNum(l.memory_bytes) ? fmtBytes(l.memory_bytes) : 'no mem limit'];
  if (l.cpuset) parts.push(`cpuset ${l.cpuset}`);
  return parts.join(' · ');
}

function PlatformPanel({ platform }: { platform: PlatformInfo | undefined }) {
  if (!platform) return <Card title="Platform"><Skeleton lines={6} /></Card>;
  const k = platform.k8s;
  const h = platform.host;
  return (
    <Card title="Platform" actions={<PlatformBadge mode={platform.mode} />}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Host</dt>
        <dd>{[h.os, h.kernel, h.arch].filter(Boolean).join(' · ') || '—'}</dd>
        <dt className="text-muted">CPU / RAM</dt>
        <dd className="num">{h.ncpu ?? '—'} cores · {fmtBytes(h.mem_bytes)}</dd>
        {(['go', 'python', 'postgres', 'dashboard'] as const).map((s) => (
          <div key={s} className="contents">
            <dt className="text-muted">Limits · {s}</dt>
            <dd className="num">{limitsText(platform.limits[s])}</dd>
          </div>
        ))}
        {TARGET_ORDER.map((t) => {
          const img = platform.images?.[t];
          return img ? (
            <div key={t} className="contents">
              <dt className="text-muted">Image · {TARGET_LABEL[t]}</dt>
              <dd className="truncate"><code className="font-mono text-xs">{img.ref}</code> <span className="num text-muted">{fmtBytes(img.size_bytes)}</span></dd>
            </div>
          ) : null;
        })}
        {k && (
          <>
            <dt className="text-muted">Node</dt>
            <dd>{k.node ?? '—'} · k3s {k.k3s_version ?? '?'} · overlay <code className="font-mono">{k.overlay ?? '?'}</code></dd>
          </>
        )}
      </dl>
      {k && (
        <div className="mt-4 space-y-3">
          <h3 className="label">Pods</h3>
          <div className="overflow-x-auto">
            <table className="table-dense w-full whitespace-nowrap text-xs">
              <thead>
                <tr><th>Pod</th><th>Target</th><th>Phase</th><th>Ready</th><th className="text-right">Restarts</th><th>QoS</th><th>Node</th></tr>
              </thead>
              <tbody>
                {k.pods.map((p) => {
                  const bad = !p.ready || !!p.reason;
                  return (
                    <tr key={p.name}>
                      <td><code className="font-mono">{p.name}</code></td>
                      <td>{p.target === 'go' || p.target === 'python' ? <TargetBadge target={p.target} size="xs" /> : p.target}</td>
                      <td className={cx(bad && 'font-medium text-worse')}>{p.reason ?? p.phase}</td>
                      <td><HealthDot status={p.ready ? 'ok' : 'down'} label={p.ready ? 'ready' : 'not ready'} /></td>
                      <td className={cx('num text-right', p.restarts > 0 && 'text-warn')}>{p.restarts}</td>
                      <td>{p.qos_class ?? '—'}</td>
                      <td>{p.node ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {k.pods.some((p) => p.reason) && (
            <p className="text-xs text-muted">
              Pods in <strong className="text-worse">{[...new Set(k.pods.filter((p) => p.reason).map((p) => p.reason))].join(', ')}</strong>: inspect with{' '}
              <code className="font-mono">kubectl describe pod &lt;name&gt; -n bench</code> and <code className="font-mono">kubectl logs --previous</code>.
            </p>
          )}
          {k.hpa && (
            <>
              <h3 className="label">HPA</h3>
              <div className="flex flex-wrap gap-3 text-sm">
                {TARGET_ORDER.map((t) => {
                  const hpa = k.hpa?.[t];
                  return hpa ? (
                    <div key={t} className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
                      <TargetBadge target={t} size="xs" />
                      <span className="num">{hpa.current} → {hpa.desired} replicas</span>
                      <span className="num text-muted">(min {hpa.min}, max {hpa.max})</span>
                    </div>
                  ) : null;
                })}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function VersionsTable({ info, health }: { info: Partial<Record<Target, ServerInfo>>; health: Partial<Record<Target, { healthy: boolean; url: string; error?: string }>> }) {
  const rows: [string, (i: ServerInfo) => string][] = [
    ['Runtime', (i) => i.runtime],
    ['ADK', (i) => i.adk_version],
    ['Framework', (i) => i.framework],
    ['Workers', (i) => String(i.workers)],
    ['GOMAXPROCS', (i) => (i.gomaxprocs != null ? String(i.gomaxprocs) : '—')],
    ['Model', (i) => i.model],
    ['Embed model', (i) => i.embed_model],
    ['Gemini configured', (i) => (i.gemini_configured ? 'yes' : 'no')],
    ['DB pool max', (i) => (i.db_pool_max != null ? String(i.db_pool_max) : '—')],
    ['cgroup CPU limit', (i) => (i.cgroup_cpu_limit != null ? `${i.cgroup_cpu_limit} CPU` : '—')],
    ['cgroup memory limit', (i) => fmtBytes(i.cgroup_memory_limit_bytes)],
    ['Started', (i) => fmtDate(i.started_at)],
  ];
  return (
    <table className="table-dense w-full text-sm">
      <thead>
        <tr>
          <th scope="col">Field</th>
          {TARGET_ORDER.map((t) => (
            <th key={t} scope="col">
              <span className="inline-flex items-center gap-2">
                <span className={t === 'go' ? 'text-gofg' : 'text-pyfg'}>{TARGET_LABEL[t]}</span>
                <HealthDot status={health[t]?.healthy ? 'ok' : 'down'} label={health[t]?.url ?? ''} showLabel={false} />
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, f]) => (
          <tr key={label}>
            <th scope="row" className="px-2 py-1.5 text-left font-normal text-muted">{label}</th>
            {TARGET_ORDER.map((t) => (
              <td key={t} className="font-mono text-xs">{info[t] ? f(info[t]!) : <span className="text-worse">{health[t]?.error ?? 'unavailable'}</span>}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const STATIC_LABELS: Record<string, { label: string; fmt: (v: number) => string }> = {
  // Names match what dashboard/server/src/bench stores in static_measurements.
  image_size_mb: { label: 'Image size', fmt: fmtMB },
  idle_mem_mb: { label: 'Idle memory', fmt: fmtMB },
  cold_start_ms: { label: 'Cold start', fmt: fmtMs },
  pod_ready_ms: { label: 'Pod ready (k8s)', fmt: fmtMs },
  dep_count: { label: 'Dependencies', fmt: (v) => fmtNum(v) },
  build_time_s: { label: 'Build time', fmt: (v) => `${fmtNum(v)} s` },
  loc: { label: 'Lines of code', fmt: (v) => fmtNum(v) },
};

function StaticPanel() {
  const { platform } = useApp();
  const st = useAsync(() => api.staticMeasurements(), []);
  const [measuring, setMeasuring] = useState(false);
  const [err, setErr] = useState<unknown>();
  const measure = async () => {
    setMeasuring(true);
    setErr(undefined);
    try {
      await api.measureStatic();
      // Measurement is async server-side (202): poll a few times.
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        st.reload();
      }
    } catch (e) {
      setErr(e);
    } finally {
      setMeasuring(false);
    }
  };
  const byKey = new Map<string, Partial<Record<Target, StaticMeasurement>>>();
  for (const m of st.data ?? []) {
    const k = `${m.metric}|${m.platform}`;
    byKey.set(k, { ...byKey.get(k), [m.target]: m });
  }
  const entries = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <Card
      title="Static characteristics"
      actions={
        <button type="button" className="btn" onClick={() => void measure()} disabled={measuring}>
          <Gauge className="h-4 w-4" aria-hidden="true" /> {measuring ? 'Measuring…' : 'Measure'}
        </button>
      }
      bodyClass="p-0 overflow-x-auto"
    >
      {err !== undefined && <div className="p-3"><ErrorCard compact error={err} /></div>}
      {st.error ? (
        <div className="p-3"><ErrorCard compact error={st.error} onRetry={st.reload} /></div>
      ) : st.loading && !st.data ? (
        <div className="p-4"><Skeleton lines={4} /></div>
      ) : !entries.length ? (
        <div className="p-4"><EmptyState title="No measurements yet">Press <strong>Measure</strong> for image size and idle memory; cold start is the <code className="font-mono">cold-start</code> scenario.</EmptyState></div>
      ) : (
        <table className="table-dense w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Platform</th>
              <th scope="col" className="text-right"><span className="text-gofg">Go</span></th>
              <th scope="col" className="text-right"><span className="text-pyfg">Python</span></th>
              <th scope="col" className="text-right">Δ</th>
              <th scope="col">Measured</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => {
              const metric = k.split('|')[0];
              const meta = STATIC_LABELS[metric] ?? { label: metric, fmt: (x: number) => fmtNum(x, 1) };
              const plat = v.go?.platform ?? v.python?.platform;
              return (
                <tr key={k} className={cx(platform && plat !== platform.mode && 'opacity-70')}>
                  <th scope="row" className="px-2 py-1.5 text-left font-normal">{meta.label}</th>
                  <td><PlatformBadge mode={plat} /></td>
                  <td className="num text-right">{v.go ? meta.fmt(v.go.value) : '—'}</td>
                  <td className="num text-right">{v.python ? meta.fmt(v.python.value) : '—'}</td>
                  <td className="text-right"><DeltaBadge go={v.go?.value} py={v.python?.value} betterWhen="lower" metric={meta.label} /></td>
                  <td className="text-xs text-muted">{fmtDate(v.go?.measured_at ?? v.python?.measured_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Very small markdown → JSX renderer for previews (headings, lists, code, bold). */
export function MiniMarkdown({ text }: { text: string }) {
  const blocks: JSX.Element[] = [];
  const lines = text.split('\n');
  let list: string[] = [];
  let table: string[] = [];
  let code: string[] | null = null;
  const flushList = () => {
    if (list.length) blocks.push(<ul key={blocks.length} className="my-1 list-disc pl-5">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  const flushTable = () => {
    if (table.length) {
      const rows = table.filter((r) => !/^\|\s*-/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      blocks.push(
        <div key={blocks.length} className="my-2 overflow-x-auto">
          <table className="table-dense text-xs">
            <thead><tr>{rows[0]?.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="num">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    }
    table = [];
  };
  for (const line of lines) {
    if (code) {
      if (line.startsWith('```')) {
        blocks.push(<pre key={blocks.length} className="my-2 overflow-x-auto rounded bg-surface2 p-2 font-mono text-xs">{code.join('\n')}</pre>);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) { flushList(); flushTable(); code = []; continue; }
    if (/^\s*[-*] /.test(line)) { flushTable(); list.push(line.replace(/^\s*[-*] /, '')); continue; }
    if (line.startsWith('|')) { flushList(); table.push(line); continue; }
    flushList();
    flushTable();
    const h = /^(#{1,4}) (.*)/.exec(line);
    if (h) {
      const cls = ['text-lg font-semibold mt-3', 'text-base font-semibold mt-3', 'text-sm font-semibold mt-2', 'text-sm font-medium mt-2'][h[1].length - 1];
      blocks.push(<p key={blocks.length} className={cls} role="heading" aria-level={h[1].length + 2}>{inline(h[2])}</p>);
    } else if (line.trim()) blocks.push(<p key={blocks.length} className="my-1">{inline(line)}</p>);
  }
  flushList();
  flushTable();
  return <div className="text-sm leading-relaxed">{blocks}</div>;
}

function inline(s: string) {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i} className="rounded bg-surface2 px-1 font-mono text-[0.9em]">{p.slice(1, -1)}</code>
      : p.startsWith('_') && p.endsWith('_') && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em>
      : <span key={i}>{p}</span>,
  );
}

function DxNotesPanel() {
  const notes = useAsync(() => api.dxNotes(), []);
  return (
    <Card title="Developer-experience notes" bodyClass="grid gap-4 p-4 lg:grid-cols-2">
      {notes.error ? (
        <ErrorCard compact error={notes.error} onRetry={notes.reload} />
      ) : !notes.data ? (
        <>
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </>
      ) : (
        TARGET_ORDER.map((t) => <DxEditor key={t} target={t} note={notes.data![t]} onSaved={(md) => notes.setData({ ...(notes.data as DxNotes), [t]: { markdown: md, updated_at: new Date().toISOString() } })} />)
      )}
    </Card>
  );
}

function DxEditor({ target, note, onSaved }: { target: Target; note: DxNotes[Target] | undefined; onSaved: (md: string) => void }) {
  const [text, setText] = useState(note?.markdown ?? '');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [savedAt, setSavedAt] = useState(note?.updated_at);
  useEffect(() => setText(note?.markdown ?? ''), [note?.markdown]);
  const dirty = text !== (note?.markdown ?? '');
  const save = async () => {
    setSaving(true);
    setErr(undefined);
    try {
      await api.saveDxNote(target, text);
      onSaved(text);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <TargetBadge target={target} />
        <Segmented label={`${TARGET_LABEL[target]} notes view`} size="xs" value={view} onChange={setView} options={[{ value: 'edit', label: <span className="inline-flex items-center gap-1"><Pencil className="h-3 w-3" aria-hidden="true" />Edit</span> }, { value: 'preview', label: <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden="true" />Preview</span> }]} />
      </div>
      {view === 'edit' ? (
        <textarea
          className="input h-56 w-full font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={`${TARGET_LABEL[target]} DX notes (Markdown)`}
          placeholder="LOC, build time, pain points, surprises…"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <div className="h-56 overflow-y-auto rounded-md border border-border p-3">{text.trim() ? <MiniMarkdown text={text} /> : <p className="text-sm text-muted">Nothing yet.</p>}</div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
          <Save className="h-4 w-4" aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
        </button>
        <span className="text-xs text-muted">{dirty ? 'Unsaved changes (Ctrl/⌘+S)' : savedAt ? `Saved ${fmtDate(savedAt)}` : ''}</span>
      </div>
      {err !== undefined && <ErrorCard compact error={err} />}
    </div>
  );
}

function ReportPanel() {
  const [md, setMd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [view, setView] = useState<'preview' | 'raw'>('preview');
  const gen = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      setMd(await api.report());
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Decision report"
      actions={
        <>
          {md && (
            <button type="button" className="btn" onClick={() => downloadBlob(new Blob([md], { type: 'text/markdown' }), `decision-report-${new Date().toISOString().slice(0, 10)}.md`)}>
              <Download className="h-4 w-4" aria-hidden="true" /> Download .md
            </button>
          )}
          <button type="button" className="btn-primary" onClick={() => void gen()} disabled={busy}>
            <FileText className="h-4 w-4" aria-hidden="true" /> {busy ? 'Generating…' : 'Generate Decision Report'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">Collects the latest non-suspect run per scenario, static characteristics and DX notes into Markdown (also saved to <code className="font-mono">./reports/</code> by the server).</p>
      {err !== undefined && <ErrorCard compact error={err} onRetry={() => void gen()} />}
      {busy && <Skeleton className="h-40" />}
      {md && !busy && (
        <div className="space-y-2">
          <Segmented label="Report view" size="xs" value={view} onChange={setView} options={[{ value: 'preview', label: 'Preview' }, { value: 'raw', label: 'Markdown' }]} />
          <div className="max-h-[600px] overflow-y-auto rounded-md border border-border p-4">
            {view === 'preview' ? <MiniMarkdown text={md} /> : <pre className="whitespace-pre-wrap font-mono text-xs">{md}</pre>}
          </div>
        </div>
      )}
    </Card>
  );
}
