import { useRef, useState } from 'react';
import { Database, FileUp, Search, UploadCloud } from 'lucide-react';
import type { Fallible, IngestResponse, PerTarget, RagStats, SearchResponse, Target } from '../types';
import { TARGET_ORDER } from '../types';
import { api, type KbSearchParams } from '../api';
import { useAsync } from '../hooks/useAsync';
import { fmtDate, fmtMs, fmtNum } from '../lib/format';
import { DeltaBadge } from './DeltaBadge';
import { TargetBadge } from './TargetBadge';
import { Drawer, ErrorCard, Segmented, Skeleton } from './ui';

function isErr<T>(v: Fallible<T> | undefined): v is { error: string } {
  return !!v && typeof v === 'object' && 'error' in v && typeof (v as { error: unknown }).error === 'string';
}

function Side<T>({ data, target, children }: { data: PerTarget<Fallible<T>> | undefined; target: Target; children: (v: T) => React.ReactNode }) {
  const v = data?.[target];
  if (!v) return <p className="text-xs text-muted">No response.</p>;
  if (isErr(v)) return <ErrorCard compact title="Failed" error={v.error} target={target} />;
  return <>{children(v)}</>;
}

function StatsGrid({ s }: { s: RagStats }) {
  const rows: [string, string][] = [
    ['Documents', fmtNum(s.documents)],
    ['Chunks', fmtNum(s.chunks)],
    ['Gemini-embedded', `${fmtNum(s.gemini_embedded_chunks)} / ${fmtNum(s.chunks)}`],
    ['Characters', fmtNum(s.chars)],
    ['Last ingest', fmtDate(s.last_ingested_at)],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="num text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const INGEST_KEYS = [
  ['read_ms', 'read'],
  ['chunk_ms', 'chunk'],
  ['embed_ms', 'embed'],
  ['db_ms', 'db (COPY)'],
  ['total_ms', 'total'],
] as const;

function IngestTable({ res }: { res: PerTarget<Fallible<IngestResponse>> }) {
  const go = isErr(res.go) ? undefined : res.go;
  const py = isErr(res.python) ? undefined : res.python;
  return (
    <div className="space-y-2">
      <table className="table-dense w-full text-xs">
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col" className="text-right text-gofg">Go</th>
            <th scope="col" className="text-right text-pyfg">Python</th>
            <th scope="col" className="text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {INGEST_KEYS.map(([k, label]) => (
            <tr key={k}>
              <th scope="row" className="px-2 py-1 text-left font-normal text-muted">{label}</th>
              <td className="num text-right">{fmtMs(go?.timings[k])}</td>
              <td className="num text-right">{fmtMs(py?.timings[k])}</td>
              <td className="text-right"><DeltaBadge go={go?.timings[k]} py={py?.timings[k]} betterWhen="lower" metric={`ingest ${label}`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        {go && <>Go: {go.documents} docs ({go.skipped} skipped), {go.chunks} chunks, embedders {go.embedders.join(', ')}. </>}
        {py && <>Python: {py.documents} docs, {py.chunks} chunks.</>}
      </p>
      {TARGET_ORDER.map((t) => (isErr(res[t]) ? <ErrorCard key={t} compact title="Ingest failed" error={(res[t] as { error: string }).error} target={t} /> : null))}
    </div>
  );
}

export function KnowledgeBaseDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const stats = useAsync(() => api.kbStats(), [open], { enabled: open });
  const [ingest, setIngest] = useState<PerTarget<Fallible<IngestResponse>>>();
  const [busy, setBusy] = useState<'ingest' | 'upload' | 'search' | null>(null);
  const [err, setErr] = useState<unknown>();
  const [force, setForce] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('How do readiness probes work?');
  const [mode, setMode] = useState<KbSearchParams['mode']>('hybrid');
  const [embedder, setEmbedder] = useState<KbSearchParams['embedder']>('mock');
  const [search, setSearch] = useState<PerTarget<Fallible<SearchResponse>>>();

  const run = async (kind: 'ingest' | 'upload' | 'search', fn: () => Promise<void>) => {
    setBusy(kind);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const onIngest = () => run('ingest', async () => {
    setIngest(await api.kbIngest({ force }));
    stats.reload();
  });
  const onUpload = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    const bad = list.find((f) => !/\.(md|txt)$/i.test(f.name) || f.size > 2 * 1024 * 1024);
    if (bad) {
      setErr(new Error(`${bad.name}: only .md/.txt files up to 2 MB are accepted`));
      return;
    }
    void run('upload', async () => {
      setIngest(await api.kbUpload(list));
      stats.reload();
      if (fileRef.current) fileRef.current.value = '';
    });
  };
  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    void run('search', async () => setSearch(await api.kbSearch({ q: q.trim(), k: 5, mode, embedder })));
  };

  return (
    <Drawer open={open} onClose={onClose} title="Knowledge base" width="w-[min(720px,100vw)]">
      <div className="space-y-5">
        <section aria-labelledby="kb-stats">
          <h3 id="kb-stats" className="label mb-2 flex items-center gap-1.5"><Database className="h-3.5 w-3.5" aria-hidden="true" /> Stats per server</h3>
          {stats.error && <ErrorCard compact error={stats.error} onRetry={stats.reload} />}
          <div className="grid gap-3 sm:grid-cols-2">
            {TARGET_ORDER.map((t) => (
              <div key={t} className="rounded-md border border-border p-3">
                <TargetBadge target={t} size="xs" className="mb-2" />
                {stats.loading && !stats.data ? <Skeleton lines={4} /> : <Side data={stats.data} target={t}>{(s) => <StatsGrid s={s} />}</Side>}
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="kb-ingest" className="space-y-2">
          <h3 id="kb-ingest" className="label flex items-center gap-1.5"><UploadCloud className="h-3.5 w-3.5" aria-hidden="true" /> Ingest</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" onClick={onIngest} disabled={!!busy}>
              {busy === 'ingest' ? 'Ingesting…' : 'Ingest default corpus'}
            </button>
            <label className="inline-flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> force re-ingest
            </label>
            <label className="btn cursor-pointer">
              <FileUp className="h-4 w-4" aria-hidden="true" />
              {busy === 'upload' ? 'Uploading…' : 'Upload .md/.txt'}
              <input ref={fileRef} type="file" accept=".md,.txt,text/markdown,text/plain" multiple className="sr-only" onChange={(e) => onUpload(e.target.files)} disabled={!!busy} />
            </label>
          </div>
          <p className="text-xs text-muted">Both servers ingest the same input; timings compare their chunk / embed / COPY pipelines.</p>
          {busy === 'ingest' || busy === 'upload' ? <Skeleton className="h-32" /> : ingest && <IngestTable res={ingest} />}
        </section>

        <section aria-labelledby="kb-search" className="space-y-2">
          <h3 id="kb-search" className="label flex items-center gap-1.5"><Search className="h-3.5 w-3.5" aria-hidden="true" /> Test search</h3>
          <form onSubmit={onSearch} className="flex flex-wrap items-center gap-2">
            <input className="input min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search query" placeholder="Ask the knowledge base…" />
            <Segmented label="Search mode" size="xs" value={mode} onChange={setMode} options={[{ value: 'hybrid', label: 'hybrid' }, { value: 'vector', label: 'vector' }, { value: 'fts', label: 'fts' }]} />
            <Segmented label="Embedder" size="xs" value={embedder} onChange={setEmbedder} options={[{ value: 'mock', label: 'mock' }, { value: 'gemini', label: 'gemini' }]} />
            <button type="submit" className="btn-primary" disabled={!!busy}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
          </form>
          {search && (
            <div className="grid gap-3 sm:grid-cols-2">
              {TARGET_ORDER.map((t) => (
                <div key={t} className="min-w-0 rounded-md border border-border p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <TargetBadge target={t} size="xs" />
                    <Side data={search} target={t}>
                      {(s) => (
                        <span className="num text-[11px] text-muted">
                          embed {fmtMs(s.timings.embed_ms)} · db {fmtMs(s.timings.db_ms)} · total {fmtMs(s.timings.total_ms)}
                        </span>
                      )}
                    </Side>
                  </div>
                  <Side data={search} target={t}>
                    {(s) =>
                      s.results.length ? (
                        <ol className="space-y-1.5">
                          {s.results.map((r, i) => (
                            <li key={`${r.source}-${i}`} className="rounded bg-surface2 p-1.5 text-xs">
                              <div className="flex justify-between gap-2">
                                <span className="truncate font-medium">{r.source} › {r.heading}</span>
                                <span className="num shrink-0 text-muted">{r.score.toFixed(4)}</span>
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-muted">{r.content}</p>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="text-xs text-muted">No results.</p>
                      )
                    }
                  </Side>
                </div>
              ))}
            </div>
          )}
        </section>
        {err !== undefined && <ErrorCard error={err} />}
      </div>
    </Drawer>
  );
}
