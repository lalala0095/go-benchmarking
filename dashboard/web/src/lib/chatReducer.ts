import type { ChatStreamEvent, ChatTurn, ConversationDetail, PerTarget, Target, Timings, ToolCall, Usage } from '../types';
import { TARGET_ORDER } from '../types';
import { isNum, mean } from './format';

export interface PaneReply {
  target: Target;
  status: 'streaming' | 'ok' | 'error';
  text: string;
  tools: ToolCall[];
  model?: string;
  requestId?: string;
  timings?: Timings | null;
  usage?: Usage | null;
  ttftMs?: number | null;
  totalMs?: number | null;
  error?: { code: string; message: string };
}

export interface ChatTurnView {
  /** Local key; server turn_index once known. */
  index: number;
  message: string;
  complete: boolean;
  panes: PerTarget<PaneReply>;
}

export interface ChatState {
  turns: ChatTurnView[];
  streaming: boolean;
}

export type ChatAction =
  | { type: 'reset' }
  | { type: 'load'; detail: ConversationDetail }
  | { type: 'send'; message: string; targets: Target[] }
  | { type: 'event'; event: ChatStreamEvent }
  | { type: 'fail'; message: string; code?: string }
  | { type: 'end' };

export const initialChatState: ChatState = { turns: [], streaming: false };

export function turnFromPersisted(t: ChatTurn): PaneReply {
  return {
    target: t.target,
    status: t.status === 'ok' ? 'ok' : 'error',
    text: t.reply_text ?? '',
    tools: t.tool_calls ?? [],
    requestId: t.request_id,
    timings: t.timings ?? null,
    usage: t.usage ?? null,
    ttftMs: t.client_ttft_ms ?? null,
    totalMs: t.client_total_ms ?? null,
    error: t.status === 'error' ? { code: t.error_code ?? 'ERROR', message: t.reply_text ?? 'Request failed' } : undefined,
  };
}

export function groupTurns(turns: ChatTurn[]): ChatTurnView[] {
  const byIndex = new Map<number, ChatTurnView>();
  for (const t of turns) {
    let v = byIndex.get(t.turn_index);
    if (!v) {
      v = { index: t.turn_index, message: t.user_message, complete: true, panes: {} };
      byIndex.set(t.turn_index, v);
    }
    v.panes[t.target] = turnFromPersisted(t);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function updatePane(state: ChatState, target: Target, fn: (p: PaneReply) => PaneReply): ChatState {
  if (!state.turns.length) return state;
  const last = state.turns[state.turns.length - 1];
  const pane = last.panes[target] ?? { target, status: 'streaming' as const, text: '', tools: [] };
  const turns = state.turns.slice(0, -1);
  turns.push({ ...last, panes: { ...last.panes, [target]: fn(pane) } });
  return { ...state, turns };
}

function finishTurnIfDone(state: ChatState): ChatState {
  const last = state.turns[state.turns.length - 1];
  if (!last) return state;
  const panes = Object.values(last.panes) as PaneReply[];
  if (panes.length && panes.every((p) => p.status !== 'streaming')) {
    return { ...state, turns: [...state.turns.slice(0, -1), { ...last, complete: true }] };
  }
  return state;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'load':
      return { turns: groupTurns(action.detail.turns), streaming: false };
    case 'send': {
      const nextIndex = state.turns.length ? Math.max(...state.turns.map((t) => t.index)) + 1 : 0;
      const panes: PerTarget<PaneReply> = {};
      for (const t of TARGET_ORDER) if (action.targets.includes(t)) panes[t] = { target: t, status: 'streaming', text: '', tools: [] };
      return { streaming: true, turns: [...state.turns, { index: nextIndex, message: action.message, complete: false, panes }] };
    }
    case 'event': {
      const e = action.event;
      switch (e.type) {
        case 'meta':
          return updatePane(state, e.target, (p) => ({ ...p, model: e.model, requestId: e.request_id }));
        case 'token':
          return updatePane(state, e.target, (p) => ({
            ...p,
            text: p.text + e.text,
            ttftMs: p.ttftMs ?? e.client_ms,
          }));
        case 'tool_call':
          return updatePane(state, e.target, (p) => ({ ...p, tools: [...p.tools, e.tool] }));
        case 'done':
          return finishTurnIfDone(
            updatePane(state, e.target, (p) => ({
              ...p,
              status: 'ok',
              text: e.reply || p.text,
              timings: e.timings,
              usage: e.usage,
              ttftMs: e.client_ttft_ms ?? p.ttftMs ?? null,
              totalMs: e.client_total_ms,
            })),
          );
        case 'error':
          return finishTurnIfDone(
            updatePane(state, e.target, (p) => ({ ...p, status: 'error', error: { code: e.code, message: e.message }, totalMs: e.client_ms })),
          );
        case 'turn_complete': {
          const last = state.turns[state.turns.length - 1];
          if (!last) return state;
          const panes: PerTarget<PaneReply> = { ...last.panes };
          for (const t of e.turns) {
            const persisted = turnFromPersisted(t);
            const live = panes[t.target];
            // Keep the live model name (not persisted per turn).
            panes[t.target] = { ...persisted, model: live?.model };
          }
          return {
            streaming: false,
            turns: [...state.turns.slice(0, -1), { ...last, index: e.turn_index, panes, complete: true }],
          };
        }
        default:
          return state;
      }
    }
    case 'fail': {
      // Transport-level failure: mark any still-streaming pane as errored.
      const last = state.turns[state.turns.length - 1];
      if (!last) return { ...state, streaming: false };
      const panes: PerTarget<PaneReply> = {};
      for (const t of TARGET_ORDER) {
        const p = last.panes[t];
        if (!p) continue;
        panes[t] = p.status === 'streaming' ? { ...p, status: 'error', error: { code: action.code ?? 'NETWORK', message: action.message } } : p;
      }
      return { streaming: false, turns: [...state.turns.slice(0, -1), { ...last, panes, complete: true }] };
    }
    case 'end': {
      // Stream closed. If any pane is still "streaming", the server hung up early.
      const s = { ...state, streaming: false };
      const last = s.turns[s.turns.length - 1];
      if (last && (Object.values(last.panes) as PaneReply[]).some((p) => p.status === 'streaming')) {
        return chatReducer(s, { type: 'fail', message: 'Stream ended before completion', code: 'STREAM_CLOSED' });
      }
      return s;
    }
  }
}

/** Winner of a turn by lower server overhead (falls back to TTFT). */
export function turnWinner(turn: ChatTurnView): Target | null {
  const g = turn.panes.go;
  const p = turn.panes.python;
  if (!g || !p || g.status !== 'ok' || p.status !== 'ok') return null;
  const go = g.timings?.overhead_ms;
  const py = p.timings?.overhead_ms;
  if (isNum(go) && isNum(py) && go !== py) return go < py ? 'go' : 'python';
  if (isNum(g.ttftMs) && isNum(p.ttftMs) && g.ttftMs !== p.ttftMs) return g.ttftMs < p.ttftMs ? 'go' : 'python';
  return null;
}

export interface ConversationAverages {
  turns: number;
  overheadMs: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  wins: number;
}

export function conversationAverages(turns: ChatTurnView[], target: Target): ConversationAverages {
  const ok = turns.map((t) => t.panes[target]).filter((p): p is PaneReply => !!p && p.status === 'ok');
  return {
    turns: ok.length,
    overheadMs: mean(ok.map((p) => p.timings?.overhead_ms)),
    ttftMs: mean(ok.map((p) => p.ttftMs)),
    totalMs: mean(ok.map((p) => p.totalMs)),
    wins: turns.filter((t) => turnWinner(t) === target).length,
  };
}

/** Extract retrieved sources from a search_knowledge_base tool call. */
export function toolSources(tool: ToolCall): string[] {
  const rs = tool.result_summary;
  if (!rs) return [];
  const sources = (rs as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  return sources
    .map((s) => {
      if (typeof s === 'string') return s;
      if (s && typeof s === 'object') {
        const o = s as { source?: unknown; heading?: unknown };
        const src = typeof o.source === 'string' ? o.source : '';
        const h = typeof o.heading === 'string' && o.heading ? ` › ${o.heading}` : '';
        return src ? src + h : '';
      }
      return '';
    })
    .filter(Boolean);
}
