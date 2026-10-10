import type { Target } from '../types';
import { TARGET_LABEL } from '../types';
import { cx } from './ui';

export function TargetBadge({ target, detail, size = 'sm', className }: { target: Target; detail?: string; size?: 'xs' | 'sm'; className?: string }) {
  const go = target === 'go';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border font-semibold uppercase tracking-wide',
        size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs',
        go ? 'border-go/50 bg-go/10 text-gofg' : 'border-py/50 bg-py/10 text-pyfg',
        className,
      )}
    >
      <span className={cx('inline-block h-2 w-2 rounded-sm', go ? 'bg-go' : 'bg-py')} aria-hidden="true" />
      {TARGET_LABEL[target]}
      {detail && <span className="font-normal normal-case tracking-normal text-muted">· {detail}</span>}
    </span>
  );
}

/** Color-only marker with accessible label, for legends. */
export function TargetSwatch({ target, dashed }: { target: Target; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span
        className={cx('inline-block h-0.5 w-4', target === 'go' ? 'bg-go' : 'bg-py', dashed && 'opacity-60')}
        style={dashed ? { backgroundImage: 'none', borderTop: '2px dashed currentColor', height: 0 } : undefined}
        aria-hidden="true"
      />
      {TARGET_LABEL[target]}
    </span>
  );
}
