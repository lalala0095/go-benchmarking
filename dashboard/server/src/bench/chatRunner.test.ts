import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatLoad, SseParser, consumeChatStream, summarizeChat, type ChatRecord } from './chatRunner.js';

async function* chunks(...xs: string[]): AsyncIterable<string> { for (const x of xs) yield x; }

describe('SseParser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const p = new SseParser();
    const evs = [
      ...p.push('event: meta\ndata: {"a"'),
      ...p.push(':1}\n\nev'),
      ...p.push('ent: token\r\ndata: {"text":"hi","seq":1}\r'),
      ...p.push('\n\r\n'),
    ];
    expect(evs).toEqual([
      { event: 'meta', data: '{"a":1}' },
      { event: 'token', data: '{"text":"hi","seq":1}' },
    ]);
  });
  it('joins multi-line data, ignores comments, defaults event name', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\n\ndata: line1\ndata:line2\n\n')).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });
  it('flushes an unterminated trailing event on end()', () => {
    const p = new SseParser();
    expect(p.push('event: done\ndata: {}')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'done', data: '{}' }]);
  });
});

describe('consumeChatStream', () => {
  it('extracts TTFT and server timings from done', async () => {
    let t = 0;
    const now = () => (t += 10);
    const r = await consumeChatStream(chunks(
      'event: meta\ndata: {"request_id":"r"}\n\n',
      'event: token\ndata: {"text":"a","seq":1}\n\n',
      'event: token\ndata: {"text":"b","seq":2}\n\n',
      'event: done\ndata: {"request_id":"r","reply":"ab","timings":{"server_total_ms":300,"first_token_ms":250,"model_ms":280,"tool_ms":0,"session_ms":8,"overhead_ms":12},"usage":{"input_tokens":1,"output_tokens":2}}\n\n',
    ), 0, now);
    expect(r).toEqual({ ttft_ms: 10, overhead_ms: 12, model_ms: 280, server_total_ms: 300, ok: true, code: '200' });
  });
  it('maps error events to their code', async () => {
    const r = await consumeChatStream(chunks('event: meta\ndata: {}\n\nevent: error\ndata: {"code":"UPSTREAM_429","message":"x"}\n\n'), 0);
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_429', ttft_ms: null });
  });
  it('flags streams that end without done/error', async () => {
    const r = await consumeChatStream(chunks('event: token\ndata: {"text":"a","seq":1}\n\n'), 0);
    expect(r).toMatchObject({ ok: false, code: 'INCOMPLETE' });
    expect(r.ttft_ms).not.toBeNull();
  });
  it('accepts Uint8Array chunks with split UTF-8 sequences', async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"text":"é"}\n\nevent: done\ndata: {"timings":{"overhead_ms":1}}\n\n');
    const idx = bytes.indexOf(0xc3) + 1; // split inside "é"
    async function* split() { yield bytes.slice(0, idx); yield bytes.slice(idx); }
    expect((await consumeChatStream(split(), 0)).ok).toBe(true);
  });
});

describe('summarizeChat', () => {
  it('aggregates latency, TTFT, overhead and status codes', () => {
    const recs: ChatRecord[] = [1, 2, 3, 4].map((i) => ({
      target: 'go', start_ms: 0, end_ms: i * 100, latency_ms: i * 100, ttft_ms: i * 10, overhead_ms: i,
      model_ms: 90, server_total_ms: 100, ok: i !== 4, code: i !== 4 ? '200' : 'UPSTREAM_429',
    }));
    const s = summarizeChat(recs, 2);
    expect(s.requests_total).toBe(4);
    expect(s.errors_total).toBe(1);
    expect(s.status_counts).toEqual({ '200': 3, UPSTREAM_429: 1 });
    expect(s.rps).toBe(2);
    expect(s.lat_p50_ms).toBe(200);     // successful requests only
    expect(s.ttft_p50_ms).toBe(25);
    expect(s.overhead_p50_ms).toBe(2.5);
  });
});

// ── Integration against a fake target server ─────────────────────────────
describe('ChatLoad against a fake server', () => {
  let server: http.Server;
  let base = '';
  const created = new Set<string>();
  const deleted = new Set<string>();
  let chats = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/v1/sessions') {
          const id = `s${created.size + 1}`;
          created.add(id);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ session_id: id, user_id: JSON.parse(body).user_id, created_at: new Date().toISOString() }));
        } else if (req.method === 'POST' && req.url === '/v1/chat/stream') {
          const n = ++chats;
          const msg = JSON.parse(body);
          if (!created.has(msg.session_id)) { res.writeHead(404); res.end('{}'); return; }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: meta\ndata: {"request_id":"${msg.request_id}"}\n\n`);
          setTimeout(() => {
            res.write('event: token\ndata: {"text":"x","seq":1}\n\n');
            setTimeout(() => {
              if (n % 10 === 0) res.end('event: error\ndata: {"code":"INTERNAL","message":"boom"}\n\n');
              else res.end('event: done\ndata: {"timings":{"overhead_ms":1.5,"model_ms":20,"server_total_ms":25}}\n\n');
            }, 10);
          }, 10);
        } else if (req.method === 'DELETE' && req.url?.startsWith('/v1/sessions/')) {
          deleted.add(decodeURIComponent(req.url.split('/')[3]!.split('?')[0]!));
          res.writeHead(204); res.end();
        } else { res.writeHead(404); res.end(); }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('honours a per-target request cap, one session per VU, and deletes sessions afterwards', async () => {
    created.clear(); deleted.clear(); chats = 0;
    const load = new ChatLoad({ baseUrls: { go: base, python: base }, targets: ['go'], mode: 'mock', message: 'hi', concurrency: 4, requests: 20, userId: 'bench-test' });
    const dur = await load.run();
    expect(load.records).toHaveLength(20);
    expect(load.records.filter((r) => !r.ok).map((r) => r.code)).toEqual(['INTERNAL', 'INTERNAL']);
    expect(created.size).toBe(4);
    const s = summarizeChat(load.recordsFor('go'), dur);
    expect(s.overhead_p50_ms).toBe(1.5);
    expect(s.ttft_p50_ms).toBeGreaterThan(5);
    expect(await load.cleanup()).toBe(4);
    expect([...deleted].sort()).toEqual([...created].sort());
  });

  it('interleaves targets per VU with caps per target', async () => {
    const load = new ChatLoad({ baseUrls: { go: base, python: base }, targets: ['go', 'python'], mode: 'mock', message: 'hi', concurrency: 2, requests: 3, userId: 'u' });
    await load.run();
    expect(load.recordsFor('go')).toHaveLength(3);
    expect(load.recordsFor('python')).toHaveLength(3);
    await load.cleanup();
  });

  it('time-based runs stop at the deadline and report per-second stats; ramp adds VUs', async () => {
    created.clear();
    const load = new ChatLoad({ baseUrls: { go: base, python: base }, targets: ['go'], mode: 'mock', message: 'hi', concurrency: 8, ramp: { from: 1, to: 8, over_s: 1 }, durationS: 1.5, userId: 'u' });
    const dur = await load.run();
    expect(dur).toBeGreaterThanOrEqual(1.4);
    expect(dur).toBeLessThan(2.5);
    expect(created.size).toBeGreaterThan(4);
    expect(load.records.length).toBeGreaterThan(20);
    const s0 = load.second('go', 0)!;
    expect(s0.rps).toBeGreaterThan(0);
    expect(s0.p50_ms).not.toBeNull();
    await load.cleanup();
  });

  it('stops on an external abort signal', async () => {
    const ac = new AbortController();
    const load = new ChatLoad({ baseUrls: { go: base, python: base }, targets: ['go'], mode: 'mock', message: 'hi', concurrency: 2, durationS: 30, userId: 'u', signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const dur = await load.run();
    expect(dur).toBeLessThan(1);
    await load.cleanup();
  });
});
