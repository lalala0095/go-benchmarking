import type { PlatformMode } from '../types';
import { cx } from './ui';

export function PlatformBadge({ mode, className }: { mode: PlatformMode | undefined | null; className?: string }) {
  if (!mode) return <span className={cx('chip text-muted', className)}>platform …</span>;
  const k8s = mode === 'k8s';
  return (
    <span className={cx('chip font-medium', className)} title={k8s ? 'Running on Kubernetes (k3s)' : 'Running on Docker Compose'}>
      <span aria-hidden="true">{k8s ? '⎈' : '🐳'}</span>
      {k8s ? 'k8s' : 'compose'}
    </span>
  );
}
