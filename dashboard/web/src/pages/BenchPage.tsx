import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';
import type { ChatMode, Layer, RunConfig, Scenario, Target } from '../types';
import { TARGET_ORDER, TARGET_LABEL } from '../types';
import { api } from '../api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { ScenarioCard } from '../components/ScenarioCard';
import { useRunLauncher } from '../components/RunLauncher';
import { Drawer, EmptyState, ErrorCard, Skeleton } from '../components/ui';
import { PlatformBadge } from '../components/PlatformBadge';

export const LAYERS: { layer: Layer; title: string; blurb: string }[] = [
  { layer: 'L1', title: 'L1 · Runtime', blurb: 'HTTP stack, JSON, CPU, concurrency: no database.' },
  { layer: 'L2', title: 'L2 · Database', blurb: 'Driver, pool and query path against Postgres.' },
  { layer: 'L3', title: 'L3 · Agent (mock LLM)', blurb: 'Full ADK loop with a deterministic mock model.' },
  { layer: 'L4', title: 'L4 · Gemini', blurb: 'Real model calls: capped, confirm required.' },
  { layer: 'static', title: 'Static', blurb: 'Startup and footprint characteristics.' },
  { layer: 'k8s', title: 'Kubernetes', blurb: 'Platform behaviour: autoscaling and rollouts.' },
];

export default function BenchPage() {
  const { platform } = useApp();
  const sc = useAsync(() => api.scenarios(), []);
  const [selected, setSelected] = useState<Scenario | null>(null);
  const { launch, ui } = useRunLauncher();

  const grouped = useMemo(() => {
    const m = new Map<Layer, Scenario[]>();
    for (const s of sc.data ?? []) m.set(s.layer, [...(m.get(s.layer) ?? []), s]);
    return m;
  }, [sc.data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Benchmarks</h1>
        <PlatformBadge mode={platform?.mode} />
        <p className="text-sm text-muted">Pick a scenario. Targets always run sequentially (alternating order per rep), never at the same time.</p>
      </div>
      {ui}
      {sc.error && <ErrorCard title="Could not load scenarios" error={sc.error} onRetry={sc.reload} />}
      {sc.loading && !sc.data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-36" />)}</div>
      )}
      {sc.data && !sc.data.length && <EmptyState title="No scenarios">The dashboard server returned an empty scenario list.</EmptyState>}
      {LAYERS.filter((l) => grouped.has(l.layer)).map((l) => (
        <section key={l.layer} aria-labelledby={`layer-${l.layer}`}>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 id={`layer-${l.layer}`} className="font-semibold">{l.title}</h2>
            <span className="text-xs text-muted">{l.blurb}</span>
            {l.layer === 'k8s' && platform?.mode === 'compose' && <span className="text-xs text-warn">Greyed out in Compose mode: deploy to k3s with <code className="font-mono">make mode-k8s</code>.</span>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {grouped.get(l.layer)!.map((s) => (
              <ScenarioCard key={s.id} scenario={s} platform={platform?.mode} selected={selected?.id === s.id} onSelect={setSelected} />
            ))}
          </div>
        </section>
      ))}
      <ConfigDrawer
        scenario={selected}
        onClose={() => setSelected(null)}
        onRun={(config, notes) => {
          if (selected) launch({ scenario: selected, config, notes });
        }}
      />
    </div>
  );
}

function NumField({ label, value, onChange, min = 0, max, hint, id }: { label: string; value: number | undefined; onChange: (v: number) => void; min?: number; max?: number; hint?: string; id: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="label block">{label}</label>
      <input id={id} type="number" className="input num w-full" value={value ?? ''} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <p id={`${id}-hint`} className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

function ConfigDrawer({ scenario, onClose, onRun }: { scenario: Scenario | null; onClose: () => void; onRun: (c: Partial<RunConfig>, notes: string) => void }) {
  const [cfg, setCfg] = useState<RunConfig | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (scenario) {
      setCfg(structuredClone(scenario.defaults));
      setAdvanced(false);
      setNotes('');
    }
  }, [scenario]);
  if (!scenario || !cfg) return null;
  const set = <K extends keyof RunConfig>(k: K, v: RunConfig[K]) => setCfg({ ...cfg, [k]: v });
  const maxC = scenario.limits?.max_concurrency;
  const maxR = scenario.limits?.max_requests;
  const errors: string[] = [];
  if (!cfg.targets.length) errors.push('Select at least one target.');
  if (cfg.concurrency < 1) errors.push('Concurrency must be ≥ 1.');
  if (maxC !== undefined && cfg.concurrency > maxC) errors.push(`Concurrency is capped at ${maxC} for this scenario.`);
  if (maxR !== undefined && (cfg.requests ?? 0) > maxR) errors.push(`Requests are capped at ${maxR} for this scenario.`);
  if (cfg.reps < 1) errors.push('Reps must be ≥ 1.');
  const toggleTarget = (t: Target) =>
    set('targets', cfg.targets.includes(t) ? cfg.targets.filter((x) => x !== t) : TARGET_ORDER.filter((x) => x === t || cfg.targets.includes(x)));

  return (
    <Drawer open onClose={onClose} title={`Configure · ${scenario.title}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!errors.length) onRun(cfg, notes);
        }}
      >
        <p className="text-sm text-muted">{scenario.description}</p>
        <fieldset className="space-y-1">
          <legend className="label">Targets</legend>
          <div className="flex gap-4">
            {TARGET_ORDER.map((t) => (
              <label key={t} className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={cfg.targets.includes(t)} onChange={() => toggleTarget(t)} /> {TARGET_LABEL[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <NumField id="cfg-c" label="Concurrency" value={cfg.concurrency} onChange={(v) => set('concurrency', v)} min={1} max={maxC} hint={maxC !== undefined ? `max ${maxC}` : undefined} />
          {scenario.defaults.duration_s !== undefined && <NumField id="cfg-d" label="Duration (s)" value={cfg.duration_s} onChange={(v) => set('duration_s', v)} min={1} />}
          {scenario.defaults.requests !== undefined && <NumField id="cfg-r" label="Requests" value={cfg.requests} onChange={(v) => set('requests', v)} min={1} max={maxR} hint={maxR !== undefined ? `max ${maxR}` : undefined} />}
          {scenario.defaults.mode !== undefined && (
            <div className="space-y-1">
              <label htmlFor="cfg-mode" className="label block">LLM mode</label>
              <select id="cfg-mode" className="input w-full" value={cfg.mode} onChange={(e) => set('mode', e.target.value as ChatMode)} disabled={scenario.requires_gemini || scenario.layer === 'L3'}>
                <option value="mock">mock</option>
                <option value="gemini">gemini</option>
              </select>
            </div>
          )}
        </div>
        <div>
          <button type="button" className="btn-ghost -ml-2" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} aria-controls="cfg-adv">
            {advanced ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />} Advanced
          </button>
          {advanced && (
            <div id="cfg-adv" className="mt-2 grid grid-cols-2 gap-3">
              <NumField id="cfg-w" label="Warm-up (s)" value={cfg.warmup_s} onChange={(v) => set('warmup_s', v)} />
              <NumField id="cfg-cd" label="Cool-down (s)" value={cfg.cooldown_s} onChange={(v) => set('cooldown_s', v)} />
              <NumField id="cfg-reps" label="Repetitions" value={cfg.reps} onChange={(v) => set('reps', v)} min={1} hint="Median across reps is reported" />
              <div className="space-y-1">
                <label htmlFor="cfg-prof" className="label block">Python profile</label>
                <select id="cfg-prof" className="input w-full" value={cfg.py_profile ?? ''} onChange={(e) => set('py_profile', (e.target.value || undefined) as RunConfig['py_profile'])}>
                  <option value="">(unspecified)</option>
                  <option value="py-1w">py-1w (1 worker)</option>
                  <option value="py-Nw">py-Nw (N workers)</option>
                </select>
                <p className="text-[11px] text-muted">Informational: recorded with the run.</p>
              </div>
              {cfg.params && (
                <div className="col-span-2 space-y-1">
                  <span className="label block">Scenario params</span>
                  <pre className="rounded-md bg-surface2 p-2 font-mono text-xs">{JSON.stringify(cfg.params, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <label htmlFor="cfg-notes" className="label block">Notes (optional)</label>
          <textarea id="cfg-notes" className="input w-full" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. after pool size change" />
        </div>
        {errors.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-worse" role="alert">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button type="button" className="btn" onClick={() => setCfg(structuredClone(scenario.defaults))}>Reset to defaults</button>
          <button type="submit" className="btn-primary" disabled={errors.length > 0}>
            <Play className="h-4 w-4" aria-hidden="true" /> Run
          </button>
        </div>
      </form>
    </Drawer>
  );
}
