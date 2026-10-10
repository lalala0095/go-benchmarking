import { AlertTriangle } from 'lucide-react';
import { cx } from './ui';

export function SuspectFlag({ reasons, variant = 'icon', className }: { reasons: string[]; variant?: 'icon' | 'banner'; className?: string }) {
  const text = reasons.length ? reasons.join('; ') : 'Flagged as suspect';
  if (variant === 'icon') {
    return (
      <span className={cx('inline-flex text-warn', className)} title={`Suspect: ${text}`}>
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Suspect run: {text}</span>
      </span>
    );
  }
  return (
    <div role="note" className={cx('flex gap-2 rounded-card border border-warn/50 bg-warn/10 p-3 text-sm', className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <div>
        <div className="font-medium">Suspect run: treat these numbers with caution</div>
        <ul className="mt-1 list-disc pl-5 text-muted">
          {(reasons.length ? reasons : ['No reason recorded']).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
