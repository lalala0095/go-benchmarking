import type { Timings } from '../types';
import { fmtMs, isNum } from '../lib/format';
import { cx } from './ui';

export const SEGMENTS = [
  { key: 'model_ms', label: 'model', cls: 'bg-model' },
  { key: 'tool_ms', label: 'tool', cls: 'bg-tool' },
  { key: 'session_ms', label: 'session/db', cls: 'bg-session' },
  { key: 'overhead_ms', label: 'overhead', cls: 'bg-overhead' },
] as const;

export interface Segment { key: (typeof SEGMENTS)[number]['key']; label: string; cls: string; ms: number; pct: number }

export function timingSegments(t: Timings | null | undefined): { segments: Segment[]; total: number } {
  if (!t) return { segments: [], total: 0 };
  const values = SEGMENTS.map((s) => ({ ...s, ms: isNum(t[s.key]) && t[s.key] > 0 ? t[s.key] : 0 }));
  const total = values.reduce((a, s) => a + s.ms, 0);
  return { segments: values.map((s) => ({ ...s, pct: total > 0 ? (s.ms / total) * 100 : 0 })), total };
}

/** Stacked horizontal bar: model | tool | session/db | overhead. Model time is visually separated from server time. */
export function TimingBar({ timings, scaleMs, showLegend = true, className }: { timings: Timings | null | undefined; scaleMs?: number; showLegend?: boolean; className?: string }) {
  const { segments, total } = timingSegments(timings);
  if (!timings || total <= 0) return <div className={cx('h-2.5 rounded bg-surface2', className)} aria-label="No timing data" role="img" />;
  // Optional shared scale (e.g. the slower side) so Go and Py bars are comparable in length.
  const widthPct = scaleMs && scaleMs > total ? (total / scaleMs) * 100 : 100;
  const summary = segments.map((s) => `${s.label} ${fmtMs(s.ms)}`).join(', ');
  return (
    <div className={className}>
      <div className="h-2.5 w-full overflow-hidden rounded bg-surface2" role="img" aria-label={`Timing breakdown: ${summary}`}>
        <div className="flex h-full" style={{ width: `${widthPct}%` }}>
          {segments.map((s) =>
            s.pct > 0 ? (
              <div
                key={s.key}
                data-segment={s.key}
                className={cx('h-full', s.cls)}
                style={{ width: `${s.pct}%`, minWidth: s.ms > 0 ? 2 : 0 }}
                title={`${s.label}: ${fmtMs(s.ms)} (${s.pct.toFixed(1)}%)`}
              />
            ) : null,
          )}
        </div>
      </div>
      {showLegend && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {segments.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span className={cx('inline-block h-2 w-2 rounded-sm', s.cls)} aria-hidden="true" />
              {s.label} <span className="num text-text">{fmtMs(s.ms)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
