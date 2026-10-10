import { Lock, Sparkles } from 'lucide-react';
import type { PlatformMode, Scenario } from '../types';
import { cx } from './ui';

export function scenarioLoad(s: Scenario): string {
  const d = s.defaults;
  const parts = [`c=${d.concurrency}`];
  if (d.duration_s) parts.push(`${d.duration_s}s`);
  if (d.requests) parts.push(`${d.requests} req`);
  parts.push(`${d.reps}×`);
  return parts.join(' · ');
}

export function ScenarioCard({ scenario, platform, selected, onSelect }: { scenario: Scenario; platform: PlatformMode | undefined; selected?: boolean; onSelect: (s: Scenario) => void }) {
  const unavailable = !!platform && !scenario.platforms.includes(platform);
  const reason = unavailable ? `Requires ${scenario.platforms.join(' / ')} — switch with \`make mode-k8s\`` : undefined;
  return (
    <button
      type="button"
      onClick={() => onSelect(scenario)}
      disabled={unavailable}
      aria-pressed={selected}
      title={reason}
      className={cx(
        'card flex h-full w-full flex-col gap-1.5 p-3 text-left transition-colors',
        unavailable ? 'cursor-not-allowed opacity-50' : 'hover:border-muted',
        selected && 'border-go ring-1 ring-go',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{scenario.title}</span>
        <span className="flex items-center gap-1">
          {scenario.requires_gemini && (
            <span className="chip border-model/50 text-model" title="Calls real Gemini: costs money, rate-limited, capped">
              <Sparkles className="h-3 w-3" aria-hidden="true" /> Gemini
            </span>
          )}
          {unavailable && <Lock className="h-3.5 w-3.5 text-muted" aria-label="Unavailable on this platform" />}
        </span>
      </div>
      <code className="font-mono text-[11px] text-muted">{scenario.id}</code>
      <p className="flex-1 text-xs leading-snug text-muted">{scenario.description}</p>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span className="num">{scenarioLoad(scenario)}</span>
        <span>{scenario.generator}</span>
      </div>
      {unavailable && <p className="text-[11px] text-warn">k8s-only: run <code className="font-mono">make mode-k8s</code> to enable.</p>}
    </button>
  );
}
