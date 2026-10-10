import { describe, expect, it } from 'vitest';
import { chatReducer, conversationAverages, groupTurns, initialChatState, toolSources, turnWinner, type ChatState } from '../lib/chatReducer';
import type { ChatStreamEvent, ChatTurn, Timings } from '../types';

const timings = (overhead: number): Timings => ({ server_total_ms: 100, first_token_ms: 10, model_ms: 80, tool_ms: 5, session_ms: 5, overhead_ms: overhead });
const apply = (s: ChatState, events: ChatStreamEvent[]) => events.reduce((acc, e) => chatReducer(acc, { type: 'event', event: e }), s);

describe('chatReducer', () => {
  it('streams tokens into each pane independently and completes the turn', () => {
    let s = chatReducer(initialChatState, { type: 'send', message: 'hi', targets: ['python', 'go'] });
    expect(Object.keys(s.turns[0].panes)).toEqual(['go', 'python']); // Go first regardless of input order
    expect(s.streaming).toBe(true);
    s = apply(s, [
      { type: 'meta', target: 'go', request_id: 'r1', session_id: 's', model: 'mock', client_ms: 1 },
      { type: 'token', target: 'go', text: 'Hel', seq: 0, client_ms: 5 },
      { type: 'token', target: 'python', text: 'Hey', seq: 0, client_ms: 9 },
      { type: 'token', target: 'go', text: 'lo', seq: 1, client_ms: 6 },
      { type: 'tool_call', target: 'python', tool: { name: 'get_inventory_stats', args: {}, duration_ms: 3 }, client_ms: 7 },
    ]);
    const t = s.turns[0];
    expect(t.panes.go!.text).toBe('Hello');
    expect(t.panes.go!.ttftMs).toBe(5);
    expect(t.panes.go!.model).toBe('mock');
    expect(t.panes.python!.tools).toHaveLength(1);
    expect(t.complete).toBe(false);
    s = apply(s, [
      { type: 'done', target: 'go', reply: 'Hello', timings: timings(1), usage: { input_tokens: 1, output_tokens: 2 }, client_ttft_ms: 5, client_total_ms: 50 },
      { type: 'error', target: 'python', code: 'UPSTREAM_429', message: 'rate limited', client_ms: 60 },
    ]);
    expect(s.turns[0].panes.go!.status).toBe('ok');
    expect(s.turns[0].panes.python!.status).toBe('error');
    expect(s.turns[0].panes.python!.error!.code).toBe('UPSTREAM_429');
    expect(s.turns[0].complete).toBe(true);
  });

  it('turn_complete replaces panes with persisted turns and stops streaming', () => {
    let s = chatReducer(initialChatState, { type: 'send', message: 'q', targets: ['go'] });
    s = apply(s, [{ type: 'meta', target: 'go', request_id: 'r', session_id: 's', model: 'gemini', client_ms: 1 }]);
    const persisted: ChatTurn = {
      turn_index: 4, target: 'go', request_id: 'r', user_message: 'q', reply_text: 'answer', tool_calls: [], status: 'ok',
      timings: timings(2), client_ttft_ms: 11, client_total_ms: 22, usage: null, created_at: '',
    };
    s = apply(s, [{ type: 'turn_complete', turn_index: 4, turns: [persisted] }]);
    expect(s.streaming).toBe(false);
    expect(s.turns[0].index).toBe(4);
    expect(s.turns[0].panes.go).toMatchObject({ text: 'answer', status: 'ok', ttftMs: 11, model: 'gemini' });
  });

  it('end / fail mark still-streaming panes as errors without touching finished ones', () => {
    let s = chatReducer(initialChatState, { type: 'send', message: 'q', targets: ['go', 'python'] });
    s = apply(s, [{ type: 'done', target: 'go', reply: 'ok', timings: timings(1), usage: { input_tokens: 0, output_tokens: 0 }, client_ttft_ms: 1, client_total_ms: 2 }]);
    s = chatReducer(s, { type: 'end' });
    expect(s.streaming).toBe(false);
    expect(s.turns[0].panes.go!.status).toBe('ok');
    expect(s.turns[0].panes.python!.error!.code).toBe('STREAM_CLOSED');
  });

  it('load groups persisted turns by index (restore on reload)', () => {
    const mk = (i: number, target: 'go' | 'python'): ChatTurn => ({ turn_index: i, target, request_id: `${i}${target}`, user_message: `m${i}`, reply_text: 'r', tool_calls: [], status: 'ok', timings: timings(target === 'go' ? 1 : 5), client_ttft_ms: 10, created_at: '' });
    const s = chatReducer(initialChatState, { type: 'load', detail: { conversation: { id: 'c', title: null, mode: 'mock', go_session_id: null, py_session_id: null, created_at: '' }, turns: [mk(1, 'python'), mk(0, 'go'), mk(1, 'go'), mk(0, 'python')] } });
    expect(s.turns.map((t) => t.index)).toEqual([0, 1]);
    expect(s.turns[1].message).toBe('m1');
    expect(turnWinner(s.turns[0])).toBe('go');
    const avg = conversationAverages(s.turns, 'python');
    expect(avg).toMatchObject({ turns: 2, overheadMs: 5, wins: 0 });
    expect(groupTurns([])).toEqual([]);
  });

  it('extracts knowledge-base sources from tool result_summary', () => {
    expect(toolSources({ name: 'search_knowledge_base', args: {}, duration_ms: 1, result_summary: { sources: [{ source: 'docs/07-KUBERNETES.md', heading: 'Probes' }, 'docs/09-RAG.md'] } })).toEqual([
      'docs/07-KUBERNETES.md › Probes',
      'docs/09-RAG.md',
    ]);
    expect(toolSources({ name: 'x', args: {}, duration_ms: 1 })).toEqual([]);
  });
});
