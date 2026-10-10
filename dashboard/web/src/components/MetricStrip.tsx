import { Trophy } from 'lucide-react';
import type { Timings, Usage } from '../types';
import { fmtMs } from '../lib/format';

export function MetricStrip({ ttftMs, totalMs, timings, usage, winner }: { ttftMs?: number | null; totalMs?: number | null; timings?: Timings | null; usage?: Usage | null; winner?: boolean }) {
  const items: [string, string][] = [
    ['TTFT', fmtMs(ttftMs)],
    ['Total', fmtMs(totalMs ?? timings?.server_total_ms)],
    ['Model', fmtMs(timings?.model_ms)],
    ['Overhead', fmtMs(timings?.overhead_ms)],
    ['Tokens', usage ? `${usage.input_tokens}→${usage.output_tokens}` : '—'],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {items.map(([k, v]) => (
        <span key={k} className="whitespace-nowrap">
          <span className="text-muted">{k}</span> <span className={k === 'Overhead' ? 'num font-semibold text-overhead' : 'num'}>{v}</span>
        </span>
      ))}
      {winner && (
        <span className="inline-flex items-center gap-1 rounded bg-better/15 px-1.5 py-0.5 font-medium text-better" title="Lower server overhead this turn">
          <Trophy className="h-3 w-3" aria-hidden="true" /> lower overhead
        </span>
      )}
    </div>
  );
}
