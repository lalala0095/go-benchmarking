import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { BookOpen, PowerOff, RotateCw, User, Wrench, Bot } from 'lucide-react';
import type { PodInfo, ServerInfo, Target, ToolCall } from '../types';
import { TARGET_LABEL } from '../types';
import type { ChatTurnView } from '../lib/chatReducer';
import { toolSources, turnWinner } from '../lib/chatReducer';
import { fmtMs } from '../lib/format';
import { TargetBadge } from './TargetBadge';
import { TimingBar, timingSegments } from './TimingBar';
import { MetricStrip } from './MetricStrip';
import { ErrorCard, cx } from './ui';
import { HealthDot } from './HealthDot';

/** Tiny inline markdown: **bold**, `code`. */
export function InlineMd({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
          <code key={i} className="rounded bg-surface2 px-1 font-mono text-[0.9em]">{p.slice(1, -1)}</code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function ToolChip({ tool }: { tool: ToolCall }) {
  const sources = tool.name === 'search_knowledge_base' ? toolSources(tool) : [];
  const extra = [tool.embed_ms !== undefined ? `embed ${fmtMs(tool.embed_ms)}` : null, tool.db_ms !== undefined ? `db ${fmtMs(tool.db_ms)}` : null].filter(Boolean).join(' · ');
  return (
    <details className="group rounded-md border border-border bg-surface2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 [&::-webkit-details-marker]:hidden">
        <Wrench className="h-3 w-3 text-tool" aria-hidden="true" />
        <code className="font-mono font-medium">{tool.name}</code>
        <span className="num text-muted">{fmtMs(tool.duration_ms)}</span>
        {extra && <span className="num text-muted">({extra})</span>}
      </summary>
      <div className="space-y-1.5 border-t border-border px-2 py-1.5">
        {sources.length > 0 && (
          <div className="flex flex-wrap gap-1" aria-label="Retrieved sources">
            {sources.map((s) => (
              <span key={s} className="chip">
                <BookOpen className="h-3 w-3" aria-hidden="true" />
                {s}
              </span>
            ))}
          </div>
        )}
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{JSON.stringify({ args: tool.args, result: tool.result_summary }, null, 1)}</pre>
      </div>
    </details>
  );
}

export function SourceChips({ tools }: { tools: ToolCall[] }) {
  const sources = tools.filter((t) => t.name === 'search_knowledge_base').flatMap(toolSources);
  if (!sources.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {sources.map((s) => (
        <span key={s} className="chip" title="Retrieved by search_knowledge_base">
          <BookOpen className="h-3 w-3" aria-hidden="true" /> {s}
        </span>
      ))}
    </div>
  );
}

function errorHint(code: string): ReactNode {
  if (code === 'UPSTREAM_429') return 'Gemini rate limited: try Mock mode.';
  if (code === 'NETWORK' || code === 'STREAM_CLOSED') return 'Connection to the dashboard API was interrupted.';
  return undefined;
}

export function podHint(pods: PodInfo[] | undefined, target: Target): PodInfo | undefined {
  return pods?.find((p) => p.target === target && (!p.ready || (p.reason && p.reason !== 'Running')));
}

export function StreamPane({ target, turns, info, healthy, healthError, pod, onRetry, empty }: {
  target: Target;
  turns: ChatTurnView[];
  info?: ServerInfo;
  healthy: boolean | undefined;
  healthError?: string;
  pod?: PodInfo;
  onRetry?: () => void;
  empty?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = turns[turns.length - 1];
  const lastText = last?.panes[target]?.text.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, lastText]);

  const offline = healthy === false;
  return (
    <section
      className={cx('card flex min-h-0 flex-col', offline && 'opacity-70 grayscale-[0.5]')}
      aria-label={`${TARGET_LABEL[target]} responses`}
    >
      <header className={cx('flex items-center justify-between gap-2 border-b px-3 py-2', target === 'go' ? 'border-go/40' : 'border-py/40')}>
        <div className="flex min-w-0 items-center gap-2">
          <TargetBadge target={target} />
          <span className="truncate text-xs text-muted">{info ? `${info.adk_version} · ${info.framework}` : '…'}</span>
        </div>
        <HealthDot status={healthy === undefined ? 'unknown' : healthy ? 'ok' : 'down'} label={healthy === false ? 'offline' : 'online'} />
      </header>
      {offline && (
        <div className="border-b border-border p-3">
          <ErrorCard
            compact
            title={`${TARGET_LABEL[target]} server unreachable`}
            error={healthError}
            target={target}
            onRetry={onRetry}
            hint={
              pod ? (
                <>
                  Pod <code className="font-mono">{pod.name}</code> is <strong>{pod.reason ?? pod.phase}</strong> ({pod.restarts} restarts). Try{' '}
                  <code className="font-mono">kubectl describe pod {pod.name} -n bench</code>
                </>
              ) : undefined
            }
          />
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3" aria-live="polite" aria-relevant="additions text" aria-busy={last?.panes[target]?.status === 'streaming'}>
        {turns.length === 0 && (empty ?? <p className="py-8 text-center text-sm text-muted">{offline ? <PowerOff className="mx-auto mb-2 h-6 w-6" /> : null}No messages yet.</p>)}
        {turns.map((turn) => {
          const pane = turn.panes[target];
          const winner = turnWinner(turn) === target;
          const other = turn.panes[target === 'go' ? 'python' : 'go'];
          const scale = Math.max(timingSegments(pane?.timings).total, timingSegments(other?.timings).total);
          return (
            <article key={turn.index} className="space-y-2">
              <div className="flex gap-2 text-sm">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="You" />
                <p className="whitespace-pre-wrap font-medium">{turn.message}</p>
              </div>
              {!pane ? (
                <p className="pl-6 text-xs italic text-muted">Not sent to {TARGET_LABEL[target]}.</p>
              ) : (
                <div className="space-y-2 pl-6">
                  {pane.tools.length > 0 && (
                    <div className="space-y-1">
                      {pane.tools.map((t, i) => (
                        <ToolChip key={i} tool={t} />
                      ))}
                    </div>
                  )}
                  {(pane.text || pane.status === 'streaming') && (
                    <div className="flex gap-2 text-sm leading-relaxed">
                      <Bot className={cx('mt-0.5 h-4 w-4 shrink-0', target === 'go' ? 'text-gofg' : 'text-pyfg')} aria-label={`${TARGET_LABEL[target]} agent`} />
                      <p className="min-w-0 whitespace-pre-wrap break-words">
                        <InlineMd text={pane.text} />
                        {pane.status === 'streaming' && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-muted align-text-bottom" aria-hidden="true" />}
                      </p>
                    </div>
                  )}
                  {pane.status === 'error' && pane.error && (
                    <ErrorCard compact title="Request failed" code={pane.error.code} error={pane.error.message} target={target} hint={errorHint(pane.error.code)} />
                  )}
                  {pane.status === 'ok' && (
                    <>
                      <TimingBar timings={pane.timings} scaleMs={scale} />
                      <MetricStrip ttftMs={pane.ttftMs} totalMs={pane.totalMs} timings={pane.timings} usage={pane.usage} winner={winner} />
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {offline && onRetry && (
        <div className="border-t border-border p-2 text-right">
          <button type="button" className="btn-ghost" onClick={onRetry}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry health check
          </button>
        </div>
      )}
    </section>
  );
}
