import { cx } from './ui';

export type HealthStatus = 'ok' | 'down' | 'degraded' | 'unknown';
const COLOR: Record<HealthStatus, string> = { ok: 'bg-better', down: 'bg-worse', degraded: 'bg-warn', unknown: 'bg-muted' };
const TEXT: Record<HealthStatus, string> = { ok: 'healthy', down: 'down', degraded: 'degraded', unknown: 'unknown' };

export function HealthDot({ status, label, title, showLabel = true }: { status: HealthStatus; label: string; title?: string; showLabel?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={title ?? `${label}: ${TEXT[status]}`}>
      <span className={cx('relative inline-flex h-2.5 w-2.5 rounded-full', COLOR[status])} aria-hidden="true">
        {status === 'ok' && <span className="absolute inset-0 animate-ping rounded-full bg-better opacity-30 [animation-duration:3s]" />}
      </span>
      {showLabel ? <span className="text-muted">{label}</span> : null}
      <span className="sr-only">{`${label} ${TEXT[status]}`}</span>
    </span>
  );
}
