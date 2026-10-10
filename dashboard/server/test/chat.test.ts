import { afterEach, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, ChatTurn, Conversation, Target } from '../../shared/api.js';
import { runChat, TargetRelay, turnStateToChatTurn, type ChatStore, type TurnState } from '../src/chat.js';
import { fakeServer, TIMINGS, upstreamHandler } from './helpers.js';

describe('TargetRelay mapping', () => {
  it('maps the upstream event sequence to tagged ChatStreamEvents with client timing', () => {
    let clock = 0;
    const r = new TargetRelay('go', 'req-local', () => clock);
    clock = 5;
    expect(r.handle({ event: 'meta', data: JSON.stringify({ request_id: 'req-up', impl: 'go', session_id: 's1', mode: 'mock', model: 'mock-llm' }) })).toEqual({
      type: 'meta', target: 'go', request_id: 'req-up', session_id: 's1', model: 'mock-llm', client_ms: 5,
    });
    clock = 12.345;
    expect(r.handle({ event: 'tool_call', data: JSON.stringify({ name: 'search_knowledge_base', args: { query: 'q' }, duration_ms: 44, result_summary: { sources: ['a'] }, embed_ms: 40 }) })).toEqual({
      type: 'tool_call', target: 'go', client_ms: 12.35,
      tool: { name: 'search_knowledge_base', args: { query: 'q' }, duration_ms: 44, result_summary: { sources: ['a'] }, embed_ms: 40 },
    });
    clock = 260;
    expect(r.handle({ event: 'token', data: '{"text":"Hel","seq":1}' })).toEqual({ type: 'token', target: 'go', text: 'Hel', seq: 1, client_ms: 260 });
    clock = 275;
    r.handle({ event: 'token', data: '{"text":"lo","seq":2}' });
    expect(r.handle({ event: 'unknown', data: '{}' })).toBeNull();
    clock = 300;
    const done = r.handle({ event: 'done', data: JSON.stringify({ request_id: 'req-up', reply: 'Hello', timings: TIMINGS, usage: { input_tokens: 1, output_tokens: 2 } }) });
    expect(done).toEqual({ type: 'done', target: 'go', reply: 'Hello', timings: TIMINGS, usage: { input_tokens: 1, output_tokens: 2 }, client_ttft_ms: 260, client_total_ms: 300 });
    expect(r.state).toMatchObject({ status: 'ok', request_id: 'req-up', session_id: 's1', client_ttft_ms: 260, client_total_ms: 300 });
    expect(r.state.tool_calls).toHaveLength(1);
    // events after a terminal event are dropped
    expect(r.handle({ event: 'token', data: '{"text":"x","seq":3}' })).toBeNull();
  });

  it('maps upstream error events and keeps partial text', () => {
    const r = new TargetRelay('python', 'id', () => 50);
    r.handle({ event: 'token', data: '{"text":"par","seq":1}' });
    expect(r.handle({ event: 'error', data: '{"request_id":"id","code":"UPSTREAM_429","message":"slow down"}' })).toEqual({
      type: 'error', target: 'python', code: 'UPSTREAM_429', message: 'slow down', client_ms: 50,
    });
    const turn = turnStateToChatTurn(r.state, 2, 'hi', 'now');
    expect(turn).toMatchObject({ status: 'error', error_code: 'UPSTREAM_429', reply_text: 'par', turn_index: 2, target: 'python' });
  });

  it('treats unparseable data as a terminal error', () => {
    const r = new TargetRelay('go', 'id', () => 1);
    expect(r.handle({ event: 'token', data: '{nope' })).toMatchObject({ type: 'error', code: 'BAD_UPSTREAM_EVENT' });
    expect(r.finished).toBe(true);
  });
});

class MemStore implements ChatStore {
  sessions: Record<string, string> = {};
  rows: TurnState[] = [];
  async nextTurnIndex() {
    return 0;
  }
  async setSession(_c: string, t: Target, s: string) {
    this.sessions[t] = s;
  }
  async insertTurns(_c: string, idx: number, msg: string, states: TurnState[]): Promise<ChatTurn[]> {
    this.rows.push(...states.map((s) => ({ ...s })));
    return states.map((s) => turnStateToChatTurn(s, idx, msg, 'ts'));
  }
}

const conv = (): Conversation => ({ id: 'c1', title: null, mode: 'mock', go_session_id: null, py_session_id: null, created_at: 'x' });

describe('runChat fan-out', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function run(goOpts: Parameters<typeof upstreamHandler>[1], pyOpts: Parameters<typeof upstreamHandler>[1] | 'down', conversation = conv()) {
    const go = await fakeServer(upstreamHandler('go', goOpts));
    closers.push(go.close);
    let pyUrl = 'http://127.0.0.1:1';
    if (pyOpts !== 'down') {
      const py = await fakeServer(upstreamHandler('python', pyOpts));
      closers.push(py.close);
      pyUrl = py.url;
    }
    const store = new MemStore();
    const events: ChatStreamEvent[] = [];
    const t0 = performance.now();
    const turns = await runChat({
      conversation,
      message: 'hello',
      mode: 'mock',
      targets: ['go', 'python'],
      urls: { go: go.url, python: pyUrl },
      store,
      emit: (e) => void events.push(e),
      now: () => performance.now() - t0,
    });
    return { events, store, turns, go };
  }

  it('streams both targets, creates sessions lazily, persists, then emits turn_complete last', async () => {
    const { events, store, turns, go } = await run({}, {});
    const byTarget = (t: Target) => events.filter((e) => 'target' in e && e.target === t).map((e) => e.type);
    expect(byTarget('go')).toEqual(['meta', 'tool_call', 'token', 'token', 'token', 'done']);
    expect(byTarget('python')).toEqual(['meta', 'tool_call', 'token', 'token', 'token', 'done']);
    expect(events.at(-1)?.type).toBe('turn_complete');
    expect(store.sessions).toEqual({ go: 'go-s1', python: 'python-s1' });
    expect(turns.map((t) => t.status)).toEqual(['ok', 'ok']);
    const done = events.find((e) => e.type === 'done' && e.target === 'go') as Extract<ChatStreamEvent, { type: 'done' }>;
    expect(done.client_ttft_ms).toBeGreaterThan(0);
    expect(done.client_total_ms).toBeGreaterThanOrEqual(done.client_ttft_ms!);
    const chatCall = go.calls.find((c) => c.path === '/v1/chat/stream')!;
    expect(JSON.parse(chatCall.body)).toMatchObject({ user_id: 'dashboard-user', session_id: 'go-s1', message: 'hello', mode: 'mock' });
  });

  it('one target failing (unreachable) never breaks the other', async () => {
    const { events, store } = await run({}, 'down');
    expect(events.filter((e) => e.type === 'done').map((e) => (e as { target: Target }).target)).toEqual(['go']);
    const err = events.find((e) => e.type === 'error') as Extract<ChatStreamEvent, { type: 'error' }>;
    expect(err.target).toBe('python');
    expect(err.code).toBe('UNREACHABLE');
    expect(store.rows.map((r) => [r.target, r.status])).toEqual([['go', 'ok'], ['python', 'error']]);
    expect(events.at(-1)?.type).toBe('turn_complete');
  });

  it('relays upstream error events, HTTP errors and dropped streams per target', async () => {
    let r = await run({ fail: 'error-event' }, { fail: 'http-500' });
    const errs = r.events.filter((e) => e.type === 'error') as Extract<ChatStreamEvent, { type: 'error' }>[];
    expect(errs.map((e) => [e.target, e.code]).sort()).toEqual([['go', 'UPSTREAM_429'], ['python', 'INTERNAL']]);
    r = await run({ fail: 'drop' }, {});
    const goErr = r.events.find((e) => e.type === 'error') as Extract<ChatStreamEvent, { type: 'error' }>;
    expect(goErr.target).toBe('go');
    expect(['UPSTREAM_DISCONNECTED', 'UNREACHABLE']).toContain(goErr.code);
    expect(r.store.rows.find((x) => x.target === 'python')?.status).toBe('ok');
  });

  it('reuses stored sessions and recreates one after SESSION_NOT_FOUND', async () => {
    const c = conv();
    c.go_session_id = 'stale';
    c.py_session_id = 'kept';
    const { store, go, events } = await run({ fail: 'session-404-once' }, {}, c);
    expect(store.sessions).toEqual({ go: 'go-s1' });
    expect(go.calls.filter((x) => x.path === '/v1/chat/stream')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(2);
  });
});
