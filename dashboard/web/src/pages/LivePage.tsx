import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Pause, Play, Radio } from 'lucide-react';
import type { LiveSample, LiveTarget, Target } from '../types';
import { TARGET_ORDER, TARGET_LABEL } from '../types';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { fmtCompact, fmtMB, fmtMs, fmtPct, fmtTime, isNum } from '../lib/format';
import { PairedChart, SeriesChart, COLOR, type Row } from '../components/charts';
import { HealthDot } from '../components/HealthDot';
import { PlatformBadge } from '../components/PlatformBadge';
import { TargetBadge } from '../components/TargetBadge';
import { DeltaBadge } from '../components/DeltaBadge';
import { EmptyState, Skeleton, cx } from '../components/ui';

const WINDOW_MS = 5 * 60_000;

type Metric = { key: keyof LiveTarget; title: string; unit?: string; format: (v: number) => string; betterWhen: 'lower' | 'higher' };
const METRICS: Metric[] = [
  { key: 'cpu_pct', title: 'CPU', unit: '%', format: (v) => fmtPct(v, 0), betterWhen: 'lower' },
  { key: 'mem_mb', title: 'Memory', unit: 'MB', format: fmtMB, betterWhen: 'lower' },
  { key: 'rps', title: 'Requests / s', format: fmtCompact, betterWhen: 'higher' },
  { key: 'p99_ms', title: 'p99 latency', unit: 'ms', format: fmtMs, betterWhen: 'lower' },
  { key: 'threads', title: 'Threads / goroutines', format: (v) => v.toFixed(0), betterWhen: 'lower' },
  { key: 'throttled_pct', title: 'CPU throttled', unit: '%', format: (v) => fmtPct(v, 1), betterWhen: 'lower' },
];

export default function LivePage() {
  const { platform } = useApp();
  const [samples, setSamples] = useState<LiveSample[]>([]);
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const buf: LiveSample[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (pausedRef.current) return;
      const cutoff = Date.now() - WINDOW_MS;
      setSamples((prev) => {
        const next = prev.concat(buf.splice(0));
        let i = 0;
        while (i < next.length && new Date(next[i].ts).getTime() < cutoff) i++;
        return i ? next.slice(i) : next;
      });
    };
    const unsub = api.live({
      onEvent: (s) => {
        buf.push(s);
        setConn('open');
        // Batch bursts (e.g. backfill) into one render; setTimeout (not rAF) so hidden tabs still drain.
        timer ??= setTimeout(flush, 50);
      },
      onOpen: () => setConn('open'),
      onError: () => setConn('error'),
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const latest = samples[samples.length - 1];
  const rows = useMemo(() => {
    const out: Record<string, Row[]> = {};
    for (const m of METRICS) {
      out[m.key] = samples.map((s) => ({ x: new Date(s.ts).getTime(), go: num(s.targets.go?.[m.key]), python: num(s.targets.python?.[m.key]) }));
    }
    out.pg = samples.map((s) => ({ x: new Date(s.ts).getTime(), cpu: s.postgres?.cpu_pct ?? null, mem: s.postgres?.mem_mb ?? null, dash: s.dashboard?.cpu_pct ?? null }));
    return out;
  }, [samples]);

  const dashCpu = latest?.dashboard?.cpu_pct;
  const mode = latest?.platform ?? platform?.mode;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Live monitor</h1>
        <PlatformBadge mode={mode} />
        <span className={cx('chip', conn === 'open' ? 'text-better' : conn === 'error' ? 'text-worse' : 'text-muted')} role="status">
          <Radio className="h-3 w-3" aria-hidden="true" />
          {conn === 'open' ? 'streaming 1 Hz' : conn === 'error' ? 'disconnected — retrying' : 'connecting…'}
        </span>
        <span className="text-xs text-muted">rolling 5-minute window · {samples.length} samples</span>
        {isNum(dashCpu) && dashCpu > 85 && (
          <span className="chip border-warn/60 bg-warn/10 font-medium text-warn" role="alert">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Dashboard CPU {dashCpu.toFixed(0)}% (&gt; 85%): load generator may be the bottleneck
          </span>
        )}
        <button type="button" className="btn ml-auto" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {latest?.active_run_id && (
        <div className="flex items-center gap-2 rounded-card border border-go/50 bg-go/10 px-3 py-2 text-sm">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-go" aria-hidden="true" />
          A benchmark is running.
          <Link className="font-medium underline" to={`/bench/${latest.active_run_id}`}>View run {latest.active_run_id.slice(0, 8)}</Link>
        </div>
      )}

      {!latest ? (
        conn === 'error' ? (
          <EmptyState title="No live data">The dashboard API is not streaming /api/live. Check that the dashboard server is running.</EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-44" />)}</div>
        )
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {TARGET_ORDER.map((t) => (
              <TargetSummary key={t} target={t} lt={latest.targets[t]} k8s={latest.platform === 'k8s'} />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {METRICS.map((m) => (
              <PairedChart
                key={m.key}
                title={m.title}
                unit={m.unit}
                data={rows[m.key]}
                xFormat={(x) => fmtTime(x)}
                yFormat={(v) => fmtCompact(v)}
                latestFormat={m.format}
                height={110}
                extra={<DeltaBadge go={num(latest.targets.go?.[m.key])} py={num(latest.targets.python?.[m.key])} betterWhen={m.betterWhen} metric={m.title} />}
              />
            ))}
          </div>
          <section className="card p-3" aria-label="Postgres and dashboard">
            <div className="mb-2 flex flex-wrap items-center gap-4 text-xs">
              <h3 className="font-semibold uppercase tracking-wide text-muted">Postgres</h3>
              <span>CPU <span className="num">{fmtPct(latest.postgres?.cpu_pct, 0)}</span></span>
              <span>Memory <span className="num">{fmtMB(latest.postgres?.mem_mb)}</span>{isNum(latest.postgres?.mem_limit_mb) && <span className="text-muted"> / {fmtMB(latest.postgres?.mem_limit_mb)}</span>}</span>
              <span className="text-muted">|</span>
              <h3 className="font-semibold uppercase tracking-wide text-muted">Dashboard (load gen)</h3>
              <span>CPU <span className={cx('num', isNum(dashCpu) && dashCpu > 85 && 'font-semibold text-warn')}>{fmtPct(dashCpu, 0)}</span></span>
              <span>Memory <span className="num">{fmtMB(latest.dashboard?.mem_mb)}</span></span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-muted">CPU %: Postgres vs dashboard</div>
                <SeriesChart
                  data={rows.pg}
                  series={[
                    { key: 'cpu', label: 'Postgres', color: COLOR.text },
                    { key: 'dash', label: 'Dashboard', color: COLOR.muted, dashed: true },
                  ]}
                  height={110}
                  unit="%"
                  legend
                  xFormat={(x) => fmtTime(x)}
                  ariaLabel="Postgres and dashboard CPU over time"
                />
              </div>
              <div>
                <div className="mb-1 text-xs text-muted">Postgres memory (MB)</div>
                <SeriesChart data={rows.pg} series={[{ key: 'mem', label: 'Postgres', color: COLOR.text }]} height={110} unit="MB" xFormat={(x) => fmtTime(x)} ariaLabel="Postgres memory over time" />
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function num(v: unknown): number | null {
  return isNum(v) ? v : null;
}

function TargetSummary({ target, lt, k8s }: { target: Target; lt: LiveTarget | undefined; k8s: boolean }) {
  if (!lt) return null;
  const items: [string, string][] = [
    ['RPS', fmtCompact(lt.rps)],
    ['p50 / p95 / p99', `${fmtMs(lt.p50_ms)} / ${fmtMs(lt.p95_ms)} / ${fmtMs(lt.p99_ms)}`],
    ['errors', isNum(lt.err_rate) ? fmtPct(lt.err_rate * 100, 2) : '—'],
    ['DB pool in use', lt.db_pool_in_use?.toString() ?? '—'],
  ];
  if (k8s) items.push(['replicas', lt.replicas?.toString() ?? '—']);
  return (
    <div className={cx('card flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 text-xs', !lt.healthy && 'opacity-60')}>
      <TargetBadge target={target} />
      <HealthDot status={lt.healthy ? 'ok' : 'down'} label={lt.healthy ? 'healthy' : `${TARGET_LABEL[target]} down`} />
      {items.map(([k, v]) => (
        <span key={k}>
          <span className="text-muted">{k}</span> <span className="num font-medium">{v}</span>
        </span>
      ))}
    </div>
  );
}
