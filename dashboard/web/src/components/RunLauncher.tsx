import { useCallback, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import type { RunConfig, Scenario } from '../types';
import { api } from '../api';
import { Dialog, ErrorCard } from './ui';

const QUIET_CHECKS = [
  'Heavy apps closed (browsers with many tabs, IDE indexing, Docker builds, video calls)',
  'Power profile set to "performance" / laptop plugged in',
  'No other benchmark or load test running on this host',
  'Only one stack active (Compose or k8s, not both)',
];

interface Pending { scenario: Scenario; config: Partial<RunConfig>; notes?: string }

/** Encapsulates the start-run flow: Gemini confirm → quiet-mode checklist → POST /api/runs → navigate / 409 handling. */
export function useRunLauncher(): { launch: (p: Pending) => void; ui: ReactNode; starting: boolean } {
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [step, setStep] = useState<'gemini' | 'quiet' | null>(null);
  const [checks, setChecks] = useState<boolean[]>(QUIET_CHECKS.map(() => false));
  const [starting, setStarting] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback((p: Pending) => {
    setPending(p);
    setError(null);
    setConflict(null);
    setChecks(QUIET_CHECKS.map(() => false));
    setStep(p.scenario.requires_gemini ? 'gemini' : 'quiet');
  }, []);

  const close = () => {
    setStep(null);
    setPending(null);
  };

  const start = async (ack: boolean) => {
    if (!pending) return;
    setStarting(true);
    try {
      const res = await api.startRun({
        scenario: pending.scenario.id,
        config: pending.config,
        confirm_gemini: pending.scenario.requires_gemini ? true : undefined,
        quiet_mode_ack: ack,
        notes: pending.notes || undefined,
      });
      if (res.ok) {
        close();
        navigate(`/bench/${res.run_id}`);
      } else if (res.status === 409) {
        setStep(null);
        setConflict(res.active_run_id ?? '');
      } else {
        setStep(null);
        setError(res.error);
      }
    } catch (e) {
      setStep(null);
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const s = pending?.scenario;
  const ui = (
    <>
      {conflict !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-card border border-warn/60 bg-warn/10 px-3 py-2 text-sm">
          Another run is already in progress. Runs are sequential so targets never compete for CPU.
          {conflict && (
            <Link className="font-medium underline" to={`/bench/${conflict}`}>
              View active run {conflict.slice(0, 8)}
            </Link>
          )}
          <button type="button" className="btn-ghost ml-auto" onClick={() => setConflict(null)}>Dismiss</button>
        </div>
      )}
      {error && <ErrorCard title="Run rejected" error={error} onRetry={() => setError(null)} />}
      <Dialog
        open={step === 'gemini'}
        onClose={close}
        title="Confirm Gemini usage"
        footer={
          <>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => setStep('quiet')}>
              <Sparkles className="h-4 w-4" aria-hidden="true" /> I understand, continue
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p>
            <strong>{s?.title}</strong> calls the real Gemini API from both servers. It costs money and is subject to rate limits (429s are recorded as errors).
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted">
            {s?.limits?.max_concurrency !== undefined && <li>Concurrency capped at <span className="num text-text">{s.limits.max_concurrency}</span></li>}
            {s?.limits?.max_requests !== undefined && <li>At most <span className="num text-text">{s.limits.max_requests}</span> requests per target</li>}
            <li>Model latency will dominate totals; compare <em>overhead</em>, not total time.</li>
          </ul>
        </div>
      </Dialog>
      <Dialog
        open={step === 'quiet'}
        onClose={close}
        title="Quiet-mode preflight"
        footer={
          <>
            <button type="button" className="btn-ghost mr-auto" onClick={() => void start(false)} disabled={starting} title="Run is recorded without quiet-mode acknowledgement">
              Start as exploratory
            </button>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => void start(true)} disabled={starting || !checks.every(Boolean)}>
              {starting ? 'Starting…' : 'Start official run'}
            </button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">Background load skews results. Confirm the host is quiet before an official run of <strong className="text-text">{s?.title}</strong>.</p>
        <ul className="space-y-2">
          {QUIET_CHECKS.map((c, i) => (
            <li key={c}>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={checks[i]} onChange={(e) => setChecks((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))} />
                {c}
              </label>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
  return { launch, ui, starting };
}
