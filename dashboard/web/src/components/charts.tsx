import { useMemo } from 'react';
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { Target } from '../types';
import { TARGET_LABEL } from '../types';
import { fmtCompact, isNum } from '../lib/format';
import { cx } from './ui';

export const COLOR = {
  go: 'rgb(var(--go))',
  python: 'rgb(var(--py))',
  grid: 'rgb(var(--border))',
  muted: 'rgb(var(--muted))',
  text: 'rgb(var(--text))',
  surface: 'rgb(var(--surface))',
};

export interface SeriesDef { key: string; label: string; color: string; dashed?: boolean }
export type Row = Record<string, number | null | undefined> & { x: number };

const axisProps = {
  stroke: COLOR.grid,
  tick: { fill: COLOR.muted, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
  tickLine: false,
};

function TooltipBox({ active, payload, label, xFormat, yFormat, unit }: {
  active?: boolean; payload?: { name: string; value: number; color: string; dataKey: string }[]; label?: number;
  xFormat: (x: number) => string; yFormat: (v: number) => string; unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg">
      <div className="num mb-1 text-muted">{label !== undefined ? xFormat(label) : ''}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} aria-hidden="true" />
          <span className="text-muted">{p.name}</span>
          <span className="num ml-auto font-medium text-text">{isNum(p.value) ? `${yFormat(p.value)}${unit ? ` ${unit}` : ''}` : '—'}</span>
        </div>
      ))}
    </div>
  );
}

export interface LineChartProps {
  data: Row[];
  series: SeriesDef[];
  height?: number;
  unit?: string;
  xFormat?: (x: number) => string;
  yFormat?: (v: number) => string;
  yDomain?: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax'];
  xDomain?: [number | 'dataMin', number | 'dataMax'];
  legend?: boolean;
  area?: boolean;
  step?: boolean;
  xScale?: 'linear' | 'log';
  ariaLabel: string;
}

export function SeriesChart({ data, series, height = 160, unit, xFormat = (x) => `${x}s`, yFormat = fmtCompact, yDomain = [0, 'auto'], xDomain = ['dataMin', 'dataMax'], legend, area, step, xScale = 'linear', ariaLabel }: LineChartProps) {
  const curve = step ? 'stepAfter' : 'monotone';
  const common = (
    <>
      <CartesianGrid stroke={COLOR.grid} strokeDasharray="2 4" vertical={false} />
      <XAxis dataKey="x" type="number" scale={xScale} domain={xDomain} allowDataOverflow={xScale === 'log'} tickFormatter={xFormat} {...axisProps} minTickGap={24} />
      <YAxis {...axisProps} domain={yDomain} tickFormatter={yFormat} width={48} axisLine={false} />
      <Tooltip content={<TooltipBox xFormat={xFormat} yFormat={yFormat} unit={unit} />} cursor={{ stroke: COLOR.muted, strokeDasharray: '3 3' }} isAnimationActive={false} />
      {legend && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, color: COLOR.muted }} />}
    </>
  );
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {area ? (
          <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {common}
            {series.map((s) => (
              <Area key={s.key} dataKey={s.key} name={s.label} type={curve} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.18}
                strokeDasharray={s.dashed ? '5 4' : undefined} isAnimationActive={false} connectNulls dot={false} />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            {common}
            {series.map((s) => (
              <Line key={s.key} dataKey={s.key} name={s.label} type={curve} stroke={s.color} strokeWidth={2} dot={false}
                strokeDasharray={s.dashed ? '5 4' : undefined} isAnimationActive={false} connectNulls activeDot={{ r: 4, stroke: COLOR.surface, strokeWidth: 2 }} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export const GO_PY_SERIES: SeriesDef[] = [
  { key: 'go', label: 'Go', color: COLOR.go },
  { key: 'python', label: 'Python', color: COLOR.python },
];

/**
 * Paired chart: Go | Python. "split" renders two panels with a shared y-domain (Go left),
 * "overlay" renders both series on one axis with a legend.
 */
export function PairedChart({ title, data, unit, mode = 'split', height = 140, xFormat, yFormat = fmtCompact, latestFormat, extra, className }: {
  title: string; data: Row[]; unit?: string; mode?: 'split' | 'overlay'; height?: number;
  xFormat?: (x: number) => string; yFormat?: (v: number) => string; latestFormat?: (v: number) => string; extra?: React.ReactNode; className?: string;
}) {
  const max = useMemo(() => {
    let m = 0;
    for (const r of data) for (const k of ['go', 'python']) {
      const v = r[k];
      if (isNum(v) && v > m) m = v;
    }
    return m > 0 ? niceCeil(m) : 1;
  }, [data]);
  const latest = (t: Target) => {
    for (let i = data.length - 1; i >= 0; i--) {
      const v = data[i][t];
      if (isNum(v)) return v;
    }
    return null;
  };
  const fmtLatest = latestFormat ?? yFormat;
  return (
    <div className={cx('card p-3', className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}{unit ? <span className="normal-case"> ({unit})</span> : null}</h3>
        {extra}
      </div>
      {mode === 'overlay' ? (
        <>
          <div className="mb-1 flex gap-3 text-xs">
            {(['go', 'python'] as Target[]).map((t) => (
              <span key={t} className="inline-flex items-center gap-1">
                <span className={cx('inline-block h-0.5 w-3', t === 'go' ? 'bg-go' : 'bg-py')} aria-hidden="true" />
                <span className="text-muted">{TARGET_LABEL[t]}</span>
                <span className="num">{isNum(latest(t)) ? fmtLatest(latest(t)!) : '—'}</span>
              </span>
            ))}
          </div>
          <SeriesChart data={data} series={GO_PY_SERIES} height={height} unit={unit} xFormat={xFormat} yFormat={yFormat} yDomain={[0, max]} ariaLabel={`${title}: Go and Python over time`} />
        </>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['go', 'python'] as Target[]).map((t) => (
            <div key={t} className="min-w-0">
              <div className="flex items-baseline justify-between text-xs">
                <span className={cx('font-semibold', t === 'go' ? 'text-gofg' : 'text-pyfg')}>{TARGET_LABEL[t]}</span>
                <span className="num text-sm font-semibold">{isNum(latest(t)) ? fmtLatest(latest(t)!) : '—'}</span>
              </div>
              <SeriesChart
                data={data}
                series={[GO_PY_SERIES[t === 'go' ? 0 : 1]]}
                height={height}
                unit={unit}
                xFormat={xFormat}
                yFormat={yFormat}
                yDomain={[0, max]}
                area
                ariaLabel={`${title}: ${TARGET_LABEL[t]}, latest ${latest(t) ?? 'n/a'}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}
