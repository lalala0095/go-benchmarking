import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookOpen, MessageSquarePlus, PanelLeft, Send, Square } from 'lucide-react';
import type { Target } from '../types';
import { TARGET_ORDER, TARGET_LABEL } from '../types';
import { api, ApiError } from '../api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { chatReducer, conversationAverages, initialChatState } from '../lib/chatReducer';
import { fmtDate, fmtMs } from '../lib/format';
import { StreamPane, podHint } from '../components/StreamPane';
import { KnowledgeBaseDrawer } from '../components/KnowledgeBase';
import { DeltaBadge } from '../components/DeltaBadge';
import { ErrorCard, Skeleton, cx } from '../components/ui';

const SUGGESTIONS = ["What's our electronics stock?", 'How do readiness probes work in our k8s setup?', 'Hello!'];

export default function ChatPage() {
  const { mode, targets, refreshTargets, platform } = useApp();
  const [params, setParams] = useSearchParams();
  const [lastConv, setLastConv] = useLocalStorage<string | null>('bench.lastConversation', null);
  const convId = params.get('c') ?? lastConv;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [selected, setSelected] = useLocalStorage<Target[]>('bench.chatTargets', ['go', 'python']);
  const [input, setInput] = useState('');
  const [loadError, setLoadError] = useState<unknown>();
  const [loadingConv, setLoadingConv] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const skipLoad = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const convs = useAsync(() => api.conversations(), []);

  // Restore a conversation from the dashboard DB on load / selection.
  useEffect(() => {
    if (!convId) {
      dispatch({ type: 'reset' });
      return;
    }
    if (skipLoad.current === convId) return;
    let alive = true;
    setLoadingConv(true);
    setLoadError(undefined);
    api
      .conversation(convId)
      .then((d) => alive && dispatch({ type: 'load', detail: d }))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          setLastConv(null);
          setParams({}, { replace: true });
        } else setLoadError(e);
      })
      .finally(() => alive && setLoadingConv(false));
    return () => {
      alive = false;
    };
  }, [convId, setLastConv, setParams]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const selectConversation = (id: string | null) => {
    abortRef.current?.abort();
    skipLoad.current = null;
    setLastConv(id);
    setParams(id ? { c: id } : {});
  };

  const toggleTarget = (t: Target) => {
    const next = selected.includes(t) ? selected.filter((x) => x !== t) : TARGET_ORDER.filter((x) => x === t || selected.includes(x));
    if (next.length) setSelected(next);
  };

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || state.streaming) return;
      setLoadError(undefined);
      let id = convId;
      try {
        if (!id) {
          const c = await api.createConversation({ mode, title: message.slice(0, 60) });
          id = c.id;
          skipLoad.current = id;
          setLastConv(id);
          setParams({ c: id });
        } else {
          skipLoad.current = id;
        }
      } catch (e) {
        setLoadError(e);
        return;
      }
      setInput('');
      const targetsToUse = TARGET_ORDER.filter((t) => selected.includes(t));
      dispatch({ type: 'send', message, targets: targetsToUse });
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await api.chat({ conversation_id: id, message, mode, targets: targetsToUse }, (ev) => dispatch({ type: 'event', event: ev }), ac.signal);
        dispatch({ type: 'end' });
      } catch (e) {
        if ((e as Error).name === 'AbortError') dispatch({ type: 'fail', message: 'Stopped by user', code: 'ABORTED' });
        else dispatch({ type: 'fail', message: (e as Error).message, code: e instanceof ApiError ? `HTTP_${e.status}` : 'NETWORK' });
      } finally {
        abortRef.current = null;
        convs.reload();
        inputRef.current?.focus();
      }
    },
    [convId, mode, selected, state.streaming, setLastConv, setParams, convs],
  );

  const stop = () => abortRef.current?.abort();
  const avg = { go: conversationAverages(state.turns, 'go'), python: conversationAverages(state.turns, 'python') };
  const pods = platform?.k8s?.pods;

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {sidebar && (
        <aside className="hidden w-60 shrink-0 flex-col gap-2 lg:flex" aria-label="Conversations">
          <button type="button" className="btn-primary w-full justify-center" onClick={() => selectConversation(null)}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" /> New chat
          </button>
          <div className="card min-h-0 flex-1 overflow-y-auto p-1">
            {convs.loading && !convs.data ? (
              <div className="p-2"><Skeleton lines={5} /></div>
            ) : convs.error ? (
              <ErrorCard compact error={convs.error} onRetry={convs.reload} />
            ) : !convs.data?.length ? (
              <p className="p-3 text-xs text-muted">No conversations yet.</p>
            ) : (
              <ul>
                {convs.data.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => selectConversation(c.id)}
                      aria-current={c.id === convId ? 'true' : undefined}
                      className={cx('w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface2', c.id === convId && 'bg-surface2')}
                    >
                      <div className="truncate">{c.title ?? 'Untitled'}</div>
                      <div className="flex justify-between text-[11px] text-muted">
                        <span>{fmtDate(c.created_at)}</span>
                        <span className={c.mode === 'gemini' ? 'text-model' : ''}>{c.mode}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost hidden lg:inline-flex" onClick={() => setSidebar((s) => !s)} aria-label="Toggle conversation list" aria-expanded={sidebar}>
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <fieldset className="flex items-center gap-3 text-sm">
            <legend className="sr-only">Targets</legend>
            <span className="label">Targets</span>
            {TARGET_ORDER.map((t) => (
              <label key={t} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={selected.includes(t)} onChange={() => toggleTarget(t)} disabled={state.streaming} className={t === 'go' ? 'accent-[rgb(var(--go))]' : 'accent-[rgb(var(--py))]'} />
                {TARGET_LABEL[t]}
              </label>
            ))}
          </fieldset>
          <span className="chip">
            mode <strong className={mode === 'gemini' ? 'text-model' : ''}>{mode}</strong>
          </span>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn lg:hidden" onClick={() => selectConversation(null)}>
              <MessageSquarePlus className="h-4 w-4" aria-hidden="true" /> New chat
            </button>
            <button type="button" className="btn" onClick={() => setKbOpen(true)}>
              <BookOpen className="h-4 w-4" aria-hidden="true" /> Knowledge base
            </button>
          </div>
        </div>

        {loadError !== undefined && <ErrorCard title="Could not load conversation" error={loadError} onRetry={() => selectConversation(convId)} />}

        <div className="grid min-h-[420px] flex-1 grid-cols-1 gap-3 pane:h-[calc(100vh-280px)] pane:grid-cols-2">
          {TARGET_ORDER.map((t) =>
            loadingConv ? (
              <div key={t} className="card space-y-3 p-4"><Skeleton lines={6} /></div>
            ) : (
              <StreamPane
                key={t}
                target={t}
                turns={state.turns}
                info={targets?.[t]?.info}
                healthy={targets ? targets[t]?.healthy : undefined}
                healthError={targets?.[t]?.error}
                pod={podHint(pods, t)}
                onRetry={refreshTargets}
                empty={
                  <div className="py-10 text-center text-sm text-muted">
                    <p>Send a message to both servers at once.</p>
                    {t === 'go' && (
                      <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                        {SUGGESTIONS.map((s) => (
                          <button key={s} type="button" className="chip hover:border-muted" onClick={() => void send(s)}>
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                }
              />
            ),
          )}
        </div>

        {state.turns.length > 0 && (
          <div className="card flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-xs" aria-label="Conversation averages">
            <span className="label">Conversation avg</span>
            {TARGET_ORDER.map((t) => (
              <span key={t} className="inline-flex items-center gap-2">
                <span className={t === 'go' ? 'font-semibold text-gofg' : 'font-semibold text-pyfg'}>{TARGET_LABEL[t]}</span>
                <span>overhead <span className="num">{fmtMs(avg[t].overheadMs)}</span></span>
                <span>TTFT <span className="num">{fmtMs(avg[t].ttftMs)}</span></span>
                <span className="text-muted">({avg[t].turns} turns, {avg[t].wins} wins)</span>
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              overhead Δ <DeltaBadge go={avg.go.overheadMs} py={avg.python.overheadMs} betterWhen="lower" metric="average overhead" />
            </span>
          </div>
        )}

        <form
          className="card flex items-end gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <label htmlFor="chat-input" className="sr-only">Message</label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            className="input max-h-40 min-h-[38px] flex-1 resize-y"
            placeholder={selected.length === 2 ? 'Message both servers… (Enter to send, Shift+Enter for newline)' : `Message ${TARGET_LABEL[selected[0]]} only…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {state.streaming ? (
            <button type="button" className="btn-danger" onClick={stop}>
              <Square className="h-4 w-4" aria-hidden="true" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn-primary" disabled={!input.trim()}>
              <Send className="h-4 w-4" aria-hidden="true" /> Send
            </button>
          )}
        </form>
      </div>
      <KnowledgeBaseDrawer open={kbOpen} onClose={() => setKbOpen(false)} />
    </div>
  );
}
