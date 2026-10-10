// Side-by-side chat fan-out: one upstream SSE stream per target, relayed as tagged ChatStreamEvents.
import { randomUUID } from 'node:crypto';
import type { ChatMode, ChatStreamEvent, ChatTurn, Conversation, Target, Timings, ToolCall, Usage } from '../../shared/api.js';
import { SseParser, type SseMessage } from './sse.js';
import { upstream, upstreamJson, UpstreamError } from './targets.js';
import { errMsg, log } from './log.js';

export const CHAT_USER_ID = 'dashboard-user';

/** Per-target state of one turn; becomes a chat_turns row. */
export interface TurnState {
  target: Target;
  request_id: string;
  session_id: string | null;
  reply: string;
  tool_calls: ToolCall[];
  status: 'ok' | 'error' | 'pending';
  error_code: string | null;
  error_message: string | null;
  timings: Timings | null;
  usage: Usage | null;
  client_ttft_ms: number | null;
  client_total_ms: number | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Maps upstream SSE messages (contracts/sse-events.md) to dashboard ChatStreamEvents for one target. Pure apart from `now`. */
export class TargetRelay {
  readonly state: TurnState;
  private seq = 0;

  constructor(
    target: Target,
    requestId: string,
    private readonly now: () => number, // ms since the dashboard received /api/chat
  ) {
    this.state = {
      target,
      request_id: requestId,
      session_id: null,
      reply: '',
      tool_calls: [],
      status: 'pending',
      error_code: null,
      error_message: null,
      timings: null,
      usage: null,
      client_ttft_ms: null,
      client_total_ms: null,
    };
  }

  get finished(): boolean {
    return this.state.status !== 'pending';
  }

  handle(msg: SseMessage): ChatStreamEvent | null {
    if (this.finished) return null;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(msg.data) as Record<string, unknown>;
    } catch {
      return this.fail('BAD_UPSTREAM_EVENT', `unparseable ${msg.event} event`);
    }
    const t = this.state.target;
    const client_ms = r2(this.now());
    switch (msg.event) {
      case 'meta': {
        if (typeof d.request_id === 'string') this.state.request_id = d.request_id;
        if (typeof d.session_id === 'string') this.state.session_id = d.session_id;
        return {
          type: 'meta',
          target: t,
          request_id: this.state.request_id,
          session_id: this.state.session_id ?? '',
          model: typeof d.model === 'string' ? d.model : '',
          client_ms,
        };
      }
      case 'token': {
        const text = typeof d.text === 'string' ? d.text : '';
        if (this.state.client_ttft_ms === null) this.state.client_ttft_ms = client_ms;
        this.state.reply += text;
        this.seq = typeof d.seq === 'number' ? d.seq : this.seq + 1;
        return { type: 'token', target: t, text, seq: this.seq, client_ms };
      }
      case 'tool_call': {
        const tool: ToolCall = {
          name: String(d.name ?? ''),
          args: (d.args as Record<string, unknown>) ?? {},
          duration_ms: Number(d.duration_ms ?? 0),
        };
        if (d.result_summary && typeof d.result_summary === 'object') tool.result_summary = d.result_summary as Record<string, unknown>;
        if (typeof d.embed_ms === 'number') tool.embed_ms = d.embed_ms;
        if (typeof d.db_ms === 'number') tool.db_ms = d.db_ms;
        this.state.tool_calls.push(tool);
        return { type: 'tool_call', target: t, tool, client_ms };
      }
      case 'done': {
        const s = this.state;
        s.status = 'ok';
        if (typeof d.reply === 'string') s.reply = d.reply;
        s.timings = (d.timings as Timings) ?? null;
        s.usage = (d.usage as Usage) ?? null;
        s.client_total_ms = client_ms;
        return {
          type: 'done',
          target: t,
          reply: s.reply,
          timings: s.timings ?? ({} as Timings),
          usage: s.usage ?? { input_tokens: 0, output_tokens: 0 },
          client_ttft_ms: s.client_ttft_ms,
          client_total_ms: client_ms,
        };
      }
      case 'error':
        return this.fail(String(d.code ?? 'UPSTREAM_ERROR'), String(d.message ?? 'upstream error'));
      default:
        return null; // unknown events are ignored (forward compatible)
    }
  }

  /** Terminal error (upstream error event, transport failure, stream ended early). */
  fail(code: string, message: string): ChatStreamEvent {
    const client_ms = r2(this.now());
    this.state.status = 'error';
    this.state.error_code = code;
    this.state.error_message = message;
    this.state.client_total_ms = client_ms;
    return { type: 'error', target: this.state.target, code, message, client_ms };
  }
}

export function turnStateToChatTurn(s: TurnState, turnIndex: number, userMessage: string, createdAt: string): ChatTurn {
  return {
    turn_index: turnIndex,
    target: s.target,
    request_id: s.request_id,
    user_message: userMessage,
    reply_text: s.reply || null,
    tool_calls: s.tool_calls,
    status: s.status === 'ok' ? 'ok' : 'error',
    error_code: s.error_code,
    timings: s.timings,
    client_ttft_ms: s.client_ttft_ms,
    client_total_ms: s.client_total_ms,
    usage: s.usage,
    created_at: createdAt,
  };
}

/** Persistence used by the relay (DB-backed in production, in-memory in tests). */
export interface ChatStore {
  nextTurnIndex(conversationId: string): Promise<number>;
  setSession(conversationId: string, target: Target, sessionId: string): Promise<void>;
  insertTurns(conversationId: string, turnIndex: number, userMessage: string, states: TurnState[]): Promise<ChatTurn[]>;
}

export interface RunChatOpts {
  conversation: Conversation;
  message: string;
  mode: ChatMode;
  targets: Target[];
  urls: Record<Target, string>;
  store: ChatStore;
  emit: (ev: ChatStreamEvent) => Promise<void> | void;
  signal?: AbortSignal;
  now: () => number;
  streamTimeoutMs?: number;
}

function classify(e: unknown, signal?: AbortSignal): { code: string; message: string } {
  if (signal?.aborted) return { code: 'CLIENT_ABORTED', message: 'client disconnected' };
  if (e instanceof UpstreamError) return { code: e.code, message: e.message };
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'HeadersTimeoutError' || name === 'BodyTimeoutError') return { code: 'TIMEOUT', message: errMsg(e) };
  return { code: 'UNREACHABLE', message: errMsg(e) };
}

async function createSession(url: string): Promise<string> {
  const s = await upstreamJson<{ session_id: string }>(url, '/v1/sessions', {
    method: 'POST',
    body: { user_id: CHAT_USER_ID },
    timeoutMs: 15_000,
  });
  if (!s || typeof s.session_id !== 'string') throw new Error('POST /v1/sessions returned no session_id');
  return s.session_id;
}

async function relayOne(t: Target, relay: TargetRelay, o: RunChatOpts, emit: (ev: ChatStreamEvent) => Promise<void>): Promise<void> {
  const url = o.urls[t];
  const col = t === 'go' ? 'go_session_id' : 'py_session_id';
  let sessionId = o.conversation[col];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!sessionId) {
        sessionId = await createSession(url);
        o.conversation[col] = sessionId;
        await o.store.setSession(o.conversation.id, t, sessionId);
      }
      relay.state.session_id = sessionId;
      const sigs = [AbortSignal.timeout(o.streamTimeoutMs ?? 300_000)];
      if (o.signal) sigs.push(o.signal);
      const res = await upstream(url, '/v1/chat/stream', {
        method: 'POST',
        body: { user_id: CHAT_USER_ID, session_id: sessionId, message: o.message, mode: o.mode, request_id: relay.state.request_id },
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.any(sigs),
      });
      if (res.statusCode !== 200) {
        const text = await res.body.text().catch(() => '');
        let body: { code?: string; message?: string } = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* non-JSON error */
        }
        // Session vanished upstream (e.g. app DB reset): create a fresh one once.
        if (attempt === 0 && res.statusCode === 404 && (body.code === 'SESSION_NOT_FOUND' || body.code === 'NOT_FOUND')) {
          sessionId = null;
          continue;
        }
        await emit(relay.fail(body.code ?? `HTTP_${res.statusCode}`, body.message ?? (text.slice(0, 300) || `HTTP ${res.statusCode}`)));
        return;
      }
      const parser = new SseParser();
      for await (const chunk of res.body) {
        for (const m of parser.push(chunk as Buffer)) {
          const ev = relay.handle(m);
          if (ev) await emit(ev);
        }
        if (relay.finished) break;
      }
      if (!relay.finished) for (const m of parser.end()) {
        const ev = relay.handle(m);
        if (ev) await emit(ev);
      }
      if (!relay.finished) await emit(relay.fail('UPSTREAM_DISCONNECTED', 'stream ended before done/error'));
      else res.body.destroy();
      return;
    }
  } catch (e) {
    if (!relay.finished) {
      const { code, message } = classify(e, o.signal);
      await emit(relay.fail(code, message));
    }
  }
}

/**
 * Runs one chat turn against the selected targets simultaneously. One target failing never affects the other.
 * Persists chat_turns rows once every target reached done/error, then emits `turn_complete`.
 */
export async function runChat(o: RunChatOpts): Promise<ChatTurn[]> {
  // Serialize writes to the client stream (both relays emit concurrently).
  let chain: Promise<void> = Promise.resolve();
  const emit = (ev: ChatStreamEvent): Promise<void> => {
    chain = chain.then(() => o.emit(ev)).catch(() => undefined);
    return chain;
  };
  const turnIndex = await o.store.nextTurnIndex(o.conversation.id);
  const relays = o.targets.map((t) => new TargetRelay(t, randomUUID(), o.now));
  await Promise.all(relays.map((r) => relayOne(r.state.target, r, o, emit)));
  await chain;
  let turns: ChatTurn[];
  try {
    turns = await o.store.insertTurns(o.conversation.id, turnIndex, o.message, relays.map((r) => r.state));
  } catch (e) {
    // Persistence failure must not hide the replies the user already saw.
    log.warn(`chat: persisting turn ${turnIndex} of ${o.conversation.id} failed`, errMsg(e));
    turns = relays.map((r) => turnStateToChatTurn(r.state, turnIndex, o.message, new Date().toISOString()));
  }
  await emit({ type: 'turn_complete', turn_index: turnIndex, turns });
  return turns;
}
