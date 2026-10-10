import { Check, Loader2, X } from 'lucide-react';
import type { RunPhase, RunStatus, Target } from '../types';
import { TARGET_LABEL } from '../types';
import { cx } from './ui';

export const PHASES: { key: RunPhase; label: string }[] = [
  { key: 'preflight', label: 'Preflight' },
  { key: 'warmup', label: 'Warm-up' },
  { key: 'run', label: 'Run' },
  { key: 'cooldown', label: 'Cool-down' },
  { key: 'analyze', label: 'Analyze' },
];

export function RunPhaseStepper({ status, phase, rep, reps, target }: { status: RunStatus; phase: RunPhase | null; rep: number; reps: number; target: Target | null }) {
  const terminal = status === 'complete' || status === 'failed' || status === 'cancelled';
  const idx = status === 'complete' ? PHASES.length : phase ? PHASES.findIndex((p) => p.key === phase) : -1;
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-1" aria-label="Run phases">
        {PHASES.map((p, i) => {
          const done = i < idx;
          const current = i === idx && !terminal;
          const failedHere = i === idx && (status === 'failed' || status === 'cancelled');
          return (
            <li key={p.key} className="flex items-center gap-1" aria-current={current ? 'step' : undefined}>
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                  done && 'border-better/50 bg-better/10 text-better',
                  current && 'border-go bg-go/15 text-text',
                  failedHere && 'border-worse/60 bg-worse/10 text-worse',
                  !done && !current && !failedHere && 'border-border text-muted',
                )}
              >
                {done ? <Check className="h-3 w-3" aria-hidden="true" /> : current ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : failedHere ? <X className="h-3 w-3" aria-hidden="true" /> : null}
                {p.label}
                {(p.key === 'warmup' || p.key === 'run' || p.key === 'cooldown') && current && target && <span className="text-muted">· {TARGET_LABEL[target]}</span>}
              </span>
              {i < PHASES.length - 1 && <span className="h-px w-3 bg-border" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-muted" aria-live="polite">
        Status <span className="font-medium text-text">{status}</span>
        {reps > 0 && rep > 0 && !terminal && (
          <>
            {' '}· rep <span className="num">{rep}/{reps}</span>
          </>
        )}
        {target && !terminal && <> · current target <span className="font-medium text-text">{TARGET_LABEL[target]}</span></>}
      </p>
    </div>
  );
}
