import type { ChatStreamEvent, LiveSample, RunStreamEvent } from '../types';
import { readSSE } from '../lib/sse';
import { ApiError, type Api, type StreamHandlers } from './types';

const BASE = '/api';

async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown;
  let msg = `${res.status} ${res.statusText}`;
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
      const e = (body as { error?: unknown; message?: unknown }) ?? {};
      if (typeof e.error === 'string') msg = e.error;
      else if (typeof e.message === 'string') msg = e.message;
    } catch {
      if (text) msg = text.slice(0, 300);
    }
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, msg, body);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (err) {
    throw new ApiError(0, `Network error: ${(err as Error).message ?? 'dashboard API unreachable'}`);
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 202 || res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

function eventSource<T>(path: string, events: string[], h: StreamHandlers<T>, closeOn: (e: T) => boolean = () => false) {
  const es = new EventSource(BASE + path);
  let closed = false;
  const handler = (ev: MessageEvent) => {
    try {
      const parsed = JSON.parse(ev.data) as T;
      h.onEvent(parsed);
      if (closeOn(parsed)) {
        closed = true;
        es.close();
      }
    } catch (err) {
      h.onError?.(err);
    }
  };
  for (const name of events) es.addEventListener(name, handler as EventListener);
  es.onopen = () => h.onOpen?.();
  es.onerror = (err) => {
    if (!closed) h.onError?.(err);
  };
  return () => {
    closed = true;
    es.close();
  };
}

export const realApi: Api = {
  health: () => req('/health'),
  targets: () => req('/targets'),
  platform: () => req('/platform'),

  conversations: () => req('/conversations'),
  createConversation: (body) => req('/conversations', json('POST', body)),
  conversation: (id) => req(`/conversations/${encodeURIComponent(id)}`),
  async chat(body, onEvent, signal) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat`, { ...json('POST', body), headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new ApiError(0, `Network error: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) throw await errorFrom(res);
    await readSSE(
      res.body,
      (m) => {
        if (!m.data) return;
        try {
          const ev = JSON.parse(m.data) as ChatStreamEvent;
          // `event:` equals ev.type; trust the JSON payload's type.
          onEvent(ev.type ? ev : ({ ...(ev as object), type: m.event } as ChatStreamEvent));
        } catch {
          /* ignore malformed frame */
        }
      },
      signal,
    );
  },

  kbStats: () => req('/kb/stats'),
  kbIngest: (body) => req('/kb/ingest', json('POST', body)),
  kbUpload(files) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return req('/kb/upload', { method: 'POST', body: fd });
  },
  kbSearch: (p) => req(`/kb/search${qs({ q: p.q, k: p.k ?? 5, mode: p.mode, embedder: p.embedder })}`),

  live: (h) => eventSource<LiveSample>('/live', ['sample', 'message'], h),

  scenarios: () => req('/scenarios'),
  async startRun(body) {
    const res = await fetch(`${BASE}/runs`, json('POST', body)).catch((err: Error) => {
      throw new ApiError(0, `Network error: ${err.message}`);
    });
    let data: { run_id?: string; error?: string; active_run_id?: string } = {};
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (res.ok && data.run_id) return { ok: true, run_id: data.run_id };
    return { ok: false, status: res.status, error: data.error ?? `${res.status} ${res.statusText}`, active_run_id: data.active_run_id };
  },
  runs: (f = {}) => req(`/runs${qs({ scenario: f.scenario, platform: f.platform, status: f.status, limit: f.limit ?? 100 })}`),
  run: (id) => req(`/runs/${encodeURIComponent(id)}`),
  runStream: (id, h) =>
    eventSource<RunStreamEvent>(
      `/runs/${encodeURIComponent(id)}/stream`,
      ['phase', 'progress', 'log', 'complete', 'failed', 'cancelled'],
      h,
      (e) => e.type === 'complete' || e.type === 'failed' || e.type === 'cancelled',
    ),
  cancelRun: (id) => req(`/runs/${encodeURIComponent(id)}/cancel`, json('POST')),
  deleteRun: (id) => req(`/runs/${encodeURIComponent(id)}`, json('DELETE')),
  compare: (a, b) => req(`/compare${qs({ a, b })}`),
  async exportRun(id, format) {
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(id)}/export?format=${format}`);
    if (!res.ok) throw await errorFrom(res);
    const cd = res.headers.get('content-disposition') ?? '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? `run-${id}.${format}` };
  },

  staticMeasurements: () => req('/static'),
  measureStatic: () => req('/static/measure', json('POST')),
  dxNotes: () => req('/dx-notes'),
  saveDxNote: (target, markdown) => req(`/dx-notes/${target}`, json('PUT', { markdown })),
  report: () => req<string>('/report', { method: 'POST', headers: { accept: 'text/markdown' } }),
};
