// Chat load generator (undici). A pool of virtual users; each VU creates its own session per
// target, then loops POST /v1/chat/stream, parsing the SSE stream (contracts/sse-events.md).
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Agent, request } from 'undici';
import type { ChatMode, Target } from '../../../shared/api.js';
import { histogram, latencyStats, percentile, round } from './analyze.js';

// ── SSE parser ───────────────────────────────────────────────────────────
export interface SseEvent { event: string; data: string }

/** Incremental text/event-stream parser (handles \n, \r\n, \r; multi-line data; comments). */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private hasData = false;

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (ch !== '\n' && ch !== '\r') continue;
      if (ch === '\r' && i === this.buf.length - 1) break; // wait: may be \r\n split across chunks
      const line = this.buf.slice(start, i);
      if (ch === '\r' && this.buf[i + 1] === '\n') i++;
      start = i + 1;
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Flush a trailing event that was not terminated by a blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf.length) { const ev = this.line(this.buf); this.buf = ''; if (ev) out.push(ev); }
    const ev = this.line('');
    if (ev) out.push(ev);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (!this.hasData) { this.event = ''; return null; }
      const ev = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = ''; this.data = []; this.hasData = false;
      return ev;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') { this.data.push(value); this.hasData = true; }
    return null;
  }
}

// ── Per-request outcome ──────────────────────────────────────────────────
export interface ChatRecord {
  target: Target;
  start_ms: number;               // relative to load start
  end_ms: number;
  latency_ms: number;             // client: send → done/stream end
  ttft_ms: number | null;         // client: send → first token event
  overhead_ms: number | null;     // server-reported (done.timings)
  model_ms: number | null;
  server_total_ms: number | null;
  ok: boolean;
  code: string;                   // '200' on success, else error code / HTTP status
}

/** Consume a chat SSE body (as text chunks) and classify the outcome. Exposed for tests. */
export async function consumeChatStream(
  chunks: AsyncIterable<string | Uint8Array>,
  t0: number,
  now: () => number = () => performance.now(),
): Promise<Pick<ChatRecord, 'ttft_ms' | 'overhead_ms' | 'model_ms' | 'server_total_ms' | 'ok' | 'code'>> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let ttft: number | null = null;
  const handle = (evs: SseEvent[]) => {
    for (const ev of evs) {
      if (ev.event === 'token' && ttft === null) ttft = now() - t0;
      else if (ev.event === 'done') {
        let timings: Record<string, unknown> = {};
        try { timings = (JSON.parse(ev.data) as { timings?: Record<string, unknown> }).timings ?? {}; } catch { /* keep empty */ }
        const num = (k: string) => (typeof timings[k] === 'number' ? (timings[k] as number) : null);
        return { ttft_ms: ttft, overhead_ms: num('overhead_ms'), model_ms: num('model_ms'), server_total_ms: num('server_total_ms'), ok: true, code: '200' };
      } else if (ev.event === 'error') {
        let code = 'STREAM_ERROR';
        try { code = (JSON.parse(ev.data) as { code?: string }).code ?? code; } catch { /* keep default */ }
        return { ttft_ms: ttft, overhead_ms: null, model_ms: null, server_total_ms: null, ok: false, code };
      }
    }
    return null;
  };
  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const r = handle(parser.push(text));
    if (r) return r;
  }
  const r = handle(parser.end());
  if (r) return r;
  return { ttft_ms: ttft, overhead_ms: null, model_ms: null, server_total_ms: null, ok: false, code: 'INCOMPLETE' };
}

// ── Load runner ──────────────────────────────────────────────────────────
export interface ChatLoadOptions {
  baseUrls: Record<Target, string>;
  /** One target = sequential A/B protocol. Several = interleaved A/B per VU (chat-gemini). */
  targets: Target[];
  mode: ChatMode;
  message: string;
  concurrency: number;
  ramp?: { from: number; to: number; over_s: number };
  durationS?: number;
  /** Cap per target. With no duration, the run ends when every target reached it. */
  requests?: number;
  userId: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface SecondStats { rps: number; p50_ms: number | null; p99_ms: number | null; errors: number }

export interface ChatTargetSummary {
  requests_total: number; errors_total: number; status_counts: Record<string, number>;
  duration_s: number; rps: number;
  lat_p50_ms: number | null; lat_p90_ms: number | null; lat_p95_ms: number | null; lat_p99_ms: number | null;
  lat_max_ms: number | null; lat_mean_ms: number | null;
  ttft_p50_ms: number | null; ttft_p99_ms: number | null;
  overhead_p50_ms: number | null; overhead_p99_ms: number | null;
  latency_histogram: { le_ms: number; count: number }[] | null;
  raw: Record<string, unknown>;
}

export function summarizeChat(records: readonly ChatRecord[], durationS: number, extra: Record<string, unknown> = {}): ChatTargetSummary {
  const status_counts: Record<string, number> = {};
  for (const r of records) status_counts[r.code] = (status_counts[r.code] ?? 0) + 1;
  const okLat = records.filter((r) => r.ok).map((r) => r.latency_ms);
  const lat = latencyStats(okLat.length ? okLat : records.map((r) => r.latency_ms));
  const ttft = records.map((r) => r.ttft_ms).filter((v): v is number => v !== null);
  const ovh = records.map((r) => r.overhead_ms).filter((v): v is number => v !== null);
  const model = records.map((r) => r.model_ms).filter((v): v is number => v !== null);
  const errors = records.filter((r) => !r.ok).length;
  return {
    requests_total: records.length,
    errors_total: errors,
    status_counts,
    duration_s: round(durationS, 3) ?? 0,
    rps: durationS > 0 ? round(records.length / durationS, 3)! : 0,
    lat_p50_ms: round(lat.p50), lat_p90_ms: round(lat.p90), lat_p95_ms: round(lat.p95), lat_p99_ms: round(lat.p99),
    lat_max_ms: round(lat.max), lat_mean_ms: round(lat.mean),
    ttft_p50_ms: round(percentile(ttft, 50)), ttft_p99_ms: round(percentile(ttft, 99)),
    overhead_p50_ms: round(percentile(ovh, 50)), overhead_p99_ms: round(percentile(ovh, 99)),
    latency_histogram: okLat.length ? histogram(okLat) : null,
    raw: {
      generator: 'chat-runner',
      model_p50_ms: round(percentile(model, 50)),
      overhead_p95_ms: round(percentile(ovh, 95)),
      ...extra,
    },
  };
}

export class ChatLoad {
  readonly records: ChatRecord[] = [];
  private readonly sessions: { target: Target; id: string }[] = [];
  private readonly agent: Agent;
  private readonly abort = new AbortController();
  private readonly issued: Record<Target, number> = { go: 0, python: 0 };
  private readonly perSecond = new Map<string, { n: number; err: number; lat: number[] }>();
  private stopped = false;
  private t0 = 0;
  private vus: Promise<void>[] = [];
  private endedAt: number | null = null;
  aborted = 0;
  activeVus = 0;

  constructor(private readonly o: ChatLoadOptions) {
    this.agent = new Agent({
      keepAliveTimeout: 30_000,
      headersTimeout: o.requestTimeoutMs ?? 120_000,
      bodyTimeout: o.requestTimeoutMs ?? 120_000,
    });
    o.signal?.addEventListener('abort', () => this.stop(true), { once: true });
  }

  get startedAt(): number { return this.t0; }
  elapsedS(): number { return ((this.endedAt ?? performance.now()) - this.t0) / 1000; }

  /** Run until duration / request caps are reached (or stop()). Resolves with the measured duration in seconds. */
  async run(): Promise<number> {
    this.t0 = performance.now();
    const target = this.o.ramp ? this.o.ramp.from : this.o.concurrency;
    for (let i = 0; i < target; i++) this.spawnVu();
    let rampTimer: NodeJS.Timeout | null = null;
    if (this.o.ramp) {
      const { from, to, over_s } = this.o.ramp;
      rampTimer = setInterval(() => {
        if (this.stopped) return;
        const t = (performance.now() - this.t0) / 1000;
        const want = Math.round(from + (to - from) * Math.min(1, t / over_s));
        while (this.vus.length < want) this.spawnVu();
      }, 250);
    }
    let durTimer: NodeJS.Timeout | null = null;
    if (this.o.durationS) durTimer = setTimeout(() => this.stop(true), this.o.durationS * 1000);
    try {
      // VUs may be added while waiting (ramp) — loop until all settled.
      let settled = 0;
      while (settled < this.vus.length) {
        const batch = this.vus.slice(settled);
        await Promise.all(batch);
        settled += batch.length;
      }
    } finally {
      if (rampTimer) clearInterval(rampTimer);
      if (durTimer) clearTimeout(durTimer);
    }
    if (this.endedAt === null) this.endedAt = performance.now();
    return (this.endedAt - this.t0) / 1000;
  }

  /** Stop issuing requests. With abortInFlight, in-flight requests are cancelled and not counted (oha -z semantics). */
  stop(abortInFlight = true): void {
    if (this.stopped) return;
    this.stopped = true;
    this.endedAt = performance.now();
    if (abortInFlight) this.abort.abort();
  }

  /** Client-side stats for completions within [sec, sec+1) since start. */
  second(target: Target, sec: number): SecondStats | null {
    const b = this.perSecond.get(`${target}:${sec}`);
    if (!b) return { rps: 0, p50_ms: null, p99_ms: null, errors: 0 };
    return { rps: b.n, p50_ms: round(percentile(b.lat, 50)), p99_ms: round(percentile(b.lat, 99)), errors: b.err };
  }

  recordsFor(target: Target): ChatRecord[] { return this.records.filter((r) => r.target === target); }

  /** Delete every session this load created (best effort, 16 at a time). */
  async cleanup(): Promise<number> {
    const list = this.sessions.splice(0);
    let deleted = 0;
    const work = async () => {
      for (let s = list.shift(); s; s = list.shift()) {
        try {
          const url = `${this.o.baseUrls[s.target]}/v1/sessions/${encodeURIComponent(s.id)}?user_id=${encodeURIComponent(this.o.userId)}`;
          const res = await request(url, { method: 'DELETE', dispatcher: this.agent, headersTimeout: 10_000, bodyTimeout: 10_000 });
          await res.body.dump();
          if (res.statusCode < 300) deleted++;
        } catch { /* ignore */ }
      }
    };
    await Promise.all(Array.from({ length: 16 }, work));
    await this.agent.close().catch(() => {});
    return deleted;
  }

  private spawnVu(): void {
    const idx = this.vus.length;
    this.vus.push(this.vu(idx));
  }

  private pickTarget(k: number): Target | null {
    const ts = this.o.targets;
    for (let j = 0; j < ts.length; j++) {
      const t = ts[(k + j) % ts.length]!;
      if (this.o.requests === undefined || this.issued[t] < this.o.requests) return t;
    }
    return null;
  }

  private async vu(idx: number): Promise<void> {
    this.activeVus++;
    const sessions: Partial<Record<Target, string>> = {};
    let k = idx; // interleave: VU i starts on target i % n, then alternates
    try {
      while (!this.stopped) {
        const t = this.pickTarget(k++);
        if (!t) break;
        this.issued[t]++;
        if (!sessions[t]) {
          const sid = await this.createSession(t);
          if (!sid) {
            if (this.stopped) break;
            this.push(t, performance.now(), false, 'SESSION_CREATE', null, null, null, null);
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          sessions[t] = sid;
        }
        await this.oneRequest(t, sessions[t]!);
      }
    } finally {
      this.activeVus--;
    }
  }

  private async createSession(t: Target): Promise<string | null> {
    try {
      const res = await request(`${this.o.baseUrls[t]}/v1/sessions`, {
        method: 'POST', dispatcher: this.agent, signal: this.abort.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: this.o.userId }),
      });
      const body = (await res.body.json().catch(() => null)) as { session_id?: string } | null;
      if (res.statusCode >= 300 || !body?.session_id) return null;
      this.sessions.push({ target: t, id: body.session_id });
      return body.session_id;
    } catch {
      return null;
    }
  }

  private async oneRequest(t: Target, sessionId: string): Promise<void> {
    const start = performance.now();
    try {
      const res = await request(`${this.o.baseUrls[t]}/v1/chat/stream`, {
        method: 'POST', dispatcher: this.agent, signal: this.abort.signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ user_id: this.o.userId, session_id: sessionId, message: this.o.message, mode: this.o.mode, request_id: randomUUID() }),
      });
      if (res.statusCode !== 200) {
        await res.body.dump().catch(() => {});
        if (this.stopped && this.abort.signal.aborted) { this.aborted++; return; }
        this.push(t, start, false, String(res.statusCode), null, null, null, null);
        return;
      }
      const out = await consumeChatStream(res.body as AsyncIterable<Uint8Array>, start);
      this.push(t, start, out.ok, out.code, out.ttft_ms, out.overhead_ms, out.model_ms, out.server_total_ms);
    } catch (e) {
      if (this.abort.signal.aborted) { this.aborted++; return; } // cut off by the deadline: not counted
      const code = (e as { code?: string }).code === 'UND_ERR_BODY_TIMEOUT' || (e as { code?: string }).code === 'UND_ERR_HEADERS_TIMEOUT' ? 'TIMEOUT' : 'NETWORK';
      this.push(t, start, false, code, null, null, null, null);
    }
  }

  private push(
    target: Target, start: number, ok: boolean, code: string,
    ttft: number | null, overhead: number | null, model: number | null, serverTotal: number | null,
  ): void {
    const end = performance.now();
    const rec: ChatRecord = {
      target, start_ms: start - this.t0, end_ms: end - this.t0, latency_ms: end - start,
      ttft_ms: ttft, overhead_ms: overhead, model_ms: model, server_total_ms: serverTotal, ok, code,
    };
    this.records.push(rec);
    const key = `${target}:${Math.floor(rec.end_ms / 1000)}`;
    const b = this.perSecond.get(key) ?? { n: 0, err: 0, lat: [] };
    b.n++;
    if (!ok) b.err++;
    else b.lat.push(rec.latency_ms);
    this.perSecond.set(key, b);
  }
}
