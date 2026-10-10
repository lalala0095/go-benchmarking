import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '../src/platform/types.js';
import { createApp } from '../src/app.js';
import { LiveSampler } from '../src/live.js';
import { createScraper } from '../src/metrics.js';
import { chatRequestSchema, kbSearchSchema, uploadSource } from '../src/validation.js';
import { fakeServer, json } from './helpers.js';

const platform: Platform = {
  mode: 'compose',
  info: async () => ({ mode: 'compose', host: {}, limits: {} }),
  containerStats: async () => ({ cpu_pct: 1, mem_mb: 10, mem_limit_mb: 100 }),
  restart: async () => ({ readyMs: 1 }),
  replicas: async () => 1,
  isOtherStackActive: async () => false,
};

describe('validation schemas', () => {
  it('chat request', () => {
    const ok = chatRequestSchema.safeParse({ conversation_id: '7f0c7a3e-1c1b-4c1e-9a55-2b8f1b7b3c11', message: 'hi', mode: 'mock', targets: ['go', 'go', 'python'] });
    expect(ok.success && ok.data.targets).toEqual(['go', 'python']);
    expect(chatRequestSchema.safeParse({ conversation_id: 'x', message: 'hi', mode: 'mock', targets: ['go'] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ conversation_id: '7f0c7a3e-1c1b-4c1e-9a55-2b8f1b7b3c11', message: '  ', mode: 'mock', targets: ['go'] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ conversation_id: '7f0c7a3e-1c1b-4c1e-9a55-2b8f1b7b3c11', message: 'x', mode: 'gpt', targets: ['go'] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ conversation_id: '7f0c7a3e-1c1b-4c1e-9a55-2b8f1b7b3c11', message: 'x', mode: 'mock', targets: [] }).success).toBe(false);
  });
  it('search query defaults and bounds', () => {
    expect(kbSearchSchema.parse({ q: 'x' })).toEqual({ q: 'x', k: 5, mode: 'hybrid', embedder: 'mock' });
    expect(kbSearchSchema.safeParse({ q: 'x', k: '21' }).success).toBe(false);
    expect(kbSearchSchema.safeParse({ q: '' }).success).toBe(false);
  });
  it('upload source names', () => {
    expect(uploadSource('notes.md')).toBe('uploads/notes.md');
    expect(uploadSource('../../etc/passwd.txt')).toBe('uploads/passwd.txt');
    expect(uploadSource('C:\\x\\a b$.MD')).toBe('uploads/a b_.MD');
    expect(uploadSource('evil.sh')).toBeNull();
    expect(uploadSource('..md')).toBeNull();
  });
});

describe('routes', () => {
  let up: Awaited<ReturnType<typeof fakeServer>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    up = await fakeServer((req, body, res) => {
      const u = req.url ?? '';
      if (u === '/healthz') return json(res, 200, { status: 'ok', db: 'ok' });
      if (u === '/v1/info') return json(res, 200, { impl: 'go', runtime: 'go1', adk_version: 'v2', framework: 'net/http', workers: 1, model: 'm', embed_model: 'e', started_at: 'x' });
      if (u === '/v1/rag/stats') return json(res, 200, { documents: 1, chunks: 2, chars: 3, gemini_embedded_chunks: 0 });
      if (u === '/v1/rag/ingest') return json(res, 200, { echo: JSON.parse(body) });
      if (u.startsWith('/v1/rag/search')) return json(res, 200, { url: u });
      if (u === '/v1/rag/documents') {
        res.writeHead(204);
        return res.end();
      }
      json(res, 404, { code: 'NOT_FOUND', message: u });
    });
    const targets = { go: up.url, python: 'http://127.0.0.1:1' };
    app = createApp({
      platform,
      targets,
      store: null,
      live: new LiveSampler({ platform, targets, scrapeMetrics: createScraper(targets), activeRunId: () => 'run-1' }),
    });
  });
  afterAll(() => up.close());

  it('GET /api/health', async () => {
    const r = await app.request('/api/health');
    expect(await r.json()).toEqual({ ok: true });
  });

  it('POST /api/chat rejects invalid bodies with 400 before touching the DB', async () => {
    let r = await app.request('/api/chat', { method: 'POST', body: '{bad json' });
    expect(r.status).toBe(400);
    r = await app.request('/api/chat', { method: 'POST', body: JSON.stringify({ conversation_id: 'nope', message: '', mode: 'x', targets: ['rust'] }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/conversation_id/);
  });

  it('POST /api/conversations validates mode', async () => {
    const r = await app.request('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'openai' }) });
    expect(r.status).toBe(400);
  });

  it('GET /api/targets reports healthy + unreachable targets', async () => {
    const r = await app.request('/api/targets');
    const body: any = await r.json();
    expect(body.go).toMatchObject({ healthy: true, url: up.url, info: { impl: 'go' }, rag: { documents: 1 } });
    expect(body.go.error).toBeUndefined();
    expect(body.python.healthy).toBe(false);
    expect(typeof body.python.error).toBe('string');
  });

  it('kb fan-out: stats/ingest/search/delete with per-target errors', async () => {
    let body: any = await (await app.request('/api/kb/stats')).json();
    expect(body.go).toEqual({ documents: 1, chunks: 2, chars: 3, gemini_embedded_chunks: 0 });
    expect(body.python.error).toBeTypeOf('string');

    body = await (await app.request('/api/kb/ingest', { method: 'POST', body: JSON.stringify({ force: true, embedders: ['mock'] }) })).json();
    expect(body.go.echo).toEqual({ corpus: 'default', force: true, embedders: ['mock'] });
    expect((await app.request('/api/kb/ingest', { method: 'POST', body: JSON.stringify({ embedders: ['openai'] }) })).status).toBe(400);
    expect((await app.request('/api/kb/ingest', { method: 'POST', body: JSON.stringify({ corpus: 'x' }) })).status).toBe(400);

    body = await (await app.request('/api/kb/search?q=hello%20world&k=3&mode=fts')).json();
    expect(body.go.url).toBe('/v1/rag/search?q=hello+world&k=3&mode=fts&embedder=mock');
    expect((await app.request('/api/kb/search?k=3')).status).toBe(400);

    body = await (await app.request('/api/kb', { method: 'DELETE' })).json();
    expect(body.go).toEqual({ ok: true });
    expect(body.python.error).toBeTypeOf('string');
  });

  it('kb upload builds uploads/<name> documents and validates files', async () => {
    const fd = new FormData();
    fd.append('files', new File(['# A\nhello'], 'a.md'));
    fd.append('files', new File(['plain'], 'b.txt'));
    const body: any = await (await app.request('/api/kb/upload', { method: 'POST', body: fd })).json();
    expect(body.go.echo).toEqual({ documents: [{ source: 'uploads/a.md', content: '# A\nhello' }, { source: 'uploads/b.txt', content: 'plain' }] });

    const bad = new FormData();
    bad.append('files', new File(['x'], 'run.sh'));
    expect((await app.request('/api/kb/upload', { method: 'POST', body: bad })).status).toBe(400);
    const big = new FormData();
    big.append('files', new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'big.md'));
    expect((await app.request('/api/kb/upload', { method: 'POST', body: big })).status).toBe(400);
    expect((await app.request('/api/kb/upload', { method: 'POST', body: new FormData() })).status).toBe(400);
  });

  it('GET /api/live streams LiveSample events', async () => {
    const r = await app.request('/api/live');
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = r.body!.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text.startsWith('event: sample\n')).toBe(true);
    const data = JSON.parse(text.split('\n')[1].slice(6));
    expect(data).toMatchObject({ platform: 'compose', active_run_id: 'run-1', postgres: { cpu_pct: 1 }, targets: { go: { healthy: true }, python: { healthy: false } } });
  });

  it('unknown /api routes are JSON 404s', async () => {
    const r = await app.request('/api/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toHaveProperty('error');
  });
});
