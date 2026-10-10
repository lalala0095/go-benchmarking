// Contract-faithful fake upstream (contracts/openapi.yaml + contracts/sse-events.md) for dashboard UI development.
// No dependencies beyond Node built-ins.   IMPL=go|python PORT=8081 npm run stub   (from dashboard/server)
// Knobs: MOCK_TOKENS, MOCK_TOKEN_DELAY_MS, MOCK_FIRST_TOKEN_DELAY_MS. A chat message containing "[error]" ends in an
// UPSTREAM_ERROR event; "[429]" in UPSTREAM_429; mentioning inventory/stock or docs/knowledge triggers a tool_call.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const IMPL = (process.env.IMPL === 'python' ? 'python' : 'go') as 'go' | 'python';
const PORT = Number(process.env.PORT ?? (IMPL === 'go' ? 8081 : 8082));
const TOKENS = Number(process.env.MOCK_TOKENS ?? 60);
const TOKEN_DELAY = Number(process.env.MOCK_TOKEN_DELAY_MS ?? 15);
const FIRST_DELAY = Number(process.env.MOCK_FIRST_TOKEN_DELAY_MS ?? 250);
const OVERHEAD = IMPL === 'go' ? 0.4 : 2.5; // ms of fake framework overhead
const startedAt = new Date().toISOString();
const t0 = process.hrtime.bigint();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;

// ── metrics state ───────────────────────────────────────────────────────
const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const reqCount = new Map<string, number>(); // `${route}|${status}`
const hist = new Map<string, { counts: number[]; sum: number; n: number }>();
let inFlight = 0;
const memBase = (IMPL === 'go' ? 38 : 160) * 1048576;

function observe(route: string, status: number, seconds: number): void {
  const k = `${route}|${status}`;
  reqCount.set(k, (reqCount.get(k) ?? 0) + 1);
  let h = hist.get(route);
  if (!h) hist.set(route, (h = { counts: BUCKETS.map(() => 0), sum: 0, n: 0 }));
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) h!.counts[i]++;
  });
  h.sum += seconds;
  h.n++;
}

function metricsText(): string {
  const cpu = process.cpuUsage();
  const cpuS = (cpu.user + cpu.system) / 1e6;
  const L: string[] = [];
  L.push('# TYPE bench_http_requests_total counter');
  for (const [k, v] of reqCount) {
    const [route, status] = k.split('|');
    L.push(`bench_http_requests_total{route="${route}",status="${status}"} ${v}`);
  }
  L.push('# TYPE bench_http_request_duration_seconds histogram');
  for (const [route, h] of hist) {
    BUCKETS.forEach((b, i) => L.push(`bench_http_request_duration_seconds_bucket{route="${route}",le="${b}"} ${h.counts[i]}`));
    L.push(`bench_http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${h.n}`);
    L.push(`bench_http_request_duration_seconds_sum{route="${route}"} ${h.sum}`);
    L.push(`bench_http_request_duration_seconds_count{route="${route}"} ${h.n}`);
  }
  L.push('# TYPE bench_db_pool_in_use gauge', `bench_db_pool_in_use ${Math.min(10, inFlight)}`);
  L.push('# TYPE bench_db_pool_max gauge', 'bench_db_pool_max 10');
  L.push('# TYPE bench_runtime_threads gauge', `bench_runtime_threads ${(IMPL === 'go' ? 12 : 6) + inFlight}`);
  L.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${process.memoryUsage().rss}`);
  L.push('# TYPE process_cpu_seconds_total counter', `process_cpu_seconds_total ${cpuS}`);
  L.push('# TYPE bench_cgroup_cpu_usage_seconds_total counter', `bench_cgroup_cpu_usage_seconds_total ${cpuS}`);
  L.push('# TYPE bench_cgroup_cpu_throttled_seconds_total counter', `bench_cgroup_cpu_throttled_seconds_total ${cpuS * 0.01}`);
  L.push('# TYPE bench_cgroup_memory_bytes gauge', `bench_cgroup_memory_bytes ${memBase + inFlight * 2_000_000 + Math.round(Math.random() * 1e6)}`);
  return L.join('\n') + '\n';
}

// ── fake state ─────────────────────────────────────────────────────────
interface Ev { role: 'user' | 'model' | 'tool'; text?: string; tool?: string; ts: string }
const sessions = new Map<string, { user_id: string; created_at: string; events: Ev[] }>();
const kb = new Map<string, { title: string; content: string; chunks: number; ingested_at: string }>();

const DEFAULT_CORPUS = [
  { source: 'docs/01-PRD.md', title: 'PRD', content: '# PRD\n\nGo vs FastAPI comparison of ADK servers.\n\n## Goals\nMeasure overhead, latency, memory.' },
  { source: 'docs/09-RAG.md', title: 'RAG', content: '# RAG\n\nHybrid search with pgvector and full-text search.\n\n## Chunking\nHeading-aware chunks.' },
  { source: 'docs/07-KUBERNETES.md', title: 'Kubernetes', content: '# Kubernetes\n\nk3s single node, HPA, rollouts.' },
];

function chunkCount(content: string): number {
  return Math.max(1, Math.ceil(content.length / 1200));
}

// ── http helpers ───────────────────────────────────────────────────────
function send(res: http.ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, extra);
    res.end();
    return;
  }
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...extra });
  res.end(s);
}
const err = (res: http.ServerResponse, status: number, code: string, message: string) => send(res, status, { code, message });

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const WORDS = 'The inventory service reports steady stock levels across electronics, books and garden categories while the benchmark harness records latency and overhead for both implementations'.split(' ');

interface ChatPlan {
  tokens: string[];
  tool: { name: string; args: Record<string, unknown>; duration_ms: number; result_summary: Record<string, unknown>; embed_ms?: number; db_ms?: number } | null;
  error: { code: string; message: string } | null;
}

function plan(message: string): ChatPlan {
  const m = message.toLowerCase();
  let tool: ChatPlan['tool'] = null;
  if (/inventory|stock/.test(m)) {
    tool = { name: 'get_inventory_stats', args: { category: 'electronics' }, duration_ms: IMPL === 'go' ? 3.1 : 4.4, result_summary: { category: 'electronics', items: 12500, avg_price: 249.5 }, db_ms: 2.2 };
  } else if (/doc|knowledge|rag/.test(m)) {
    tool = { name: 'search_knowledge_base', args: { query: message.slice(0, 80) }, duration_ms: IMPL === 'go' ? 45.2 : 47.9, result_summary: { sources: ['docs/09-RAG.md', 'docs/01-PRD.md'] }, embed_ms: 40.3, db_ms: 3.1 };
  }
  const error = m.includes('[error]') ? { code: 'UPSTREAM_ERROR', message: 'stub: simulated model failure' } : m.includes('[429]') ? { code: 'UPSTREAM_429', message: 'stub: rate limited' } : null;
  const tokens = Array.from({ length: TOKENS }, (_, i) => (i === 0 ? '' : ' ') + WORDS[i % WORDS.length] + (i === TOKENS - 1 ? '.' : ''));
  return { tokens, tool, error };
}

async function runChat(
  body: Record<string, unknown>,
  write: (event: string, data: unknown) => void,
): Promise<{ reply: string; tool_calls: unknown[]; timings: Record<string, number>; usage: Record<string, number>; error: { code: string; message: string } | null; request_id: string }> {
  const start = now();
  const request_id = typeof body.request_id === 'string' ? body.request_id : randomUUID();
  const s = sessions.get(String(body.session_id))!;
  const message = String(body.message);
  const p = plan(message);
  const sessionMs = IMPL === 'go' ? 1.8 : 3.6;
  await sleep(sessionMs);
  s.events.push({ role: 'user', text: message, ts: new Date().toISOString() });
  write('meta', { request_id, impl: IMPL, session_id: body.session_id, mode: body.mode ?? 'mock', model: body.mode === 'gemini' ? 'gemini-3.5-flash-lite' : 'mock-llm' });
  const tool_calls: unknown[] = [];
  let toolMs = 0;
  if (p.tool) {
    await sleep(p.tool.duration_ms);
    toolMs += p.tool.duration_ms;
    tool_calls.push(p.tool);
    write('tool_call', p.tool);
    s.events.push({ role: 'tool', tool: p.tool.name, ts: new Date().toISOString() });
  }
  const modelStart = now();
  await sleep(FIRST_DELAY);
  let firstToken = 0;
  let reply = '';
  if (p.error) {
    await sleep(OVERHEAD);
    return { reply: '', tool_calls, timings: {}, usage: {}, error: p.error, request_id };
  }
  for (let i = 0; i < p.tokens.length; i++) {
    if (i > 0) await sleep(TOKEN_DELAY);
    if (!firstToken) firstToken = now() - start;
    reply += p.tokens[i];
    write('token', { text: p.tokens[i], seq: i + 1 });
  }
  const modelMs = now() - modelStart;
  await sleep(OVERHEAD);
  s.events.push({ role: 'model', text: reply, ts: new Date().toISOString() });
  const total = now() - start;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const timings = {
    server_total_ms: r(total),
    first_token_ms: r(firstToken),
    model_ms: r(modelMs),
    tool_ms: r(toolMs),
    session_ms: r(sessionMs),
    overhead_ms: r(Math.max(0, total - modelMs - toolMs - sessionMs)),
  };
  return { reply, tool_calls, timings, usage: { input_tokens: 40 + message.length, output_tokens: p.tokens.length }, error: null, request_id };
}

// ── router ─────────────────────────────────────────────────────────────
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<string> {
  const url = new URL(req.url ?? '/', 'http://stub');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok', db: 'ok' }), path;
  if (method === 'GET' && path === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(metricsText());
    return path;
  }
  if (method === 'GET' && path === '/v1/info') {
    send(res, 200, {
      impl: IMPL,
      runtime: IMPL === 'go' ? 'go1.26.6' : 'cpython3.12.12',
      adk_version: IMPL === 'go' ? 'v2.5.0' : '2.11.0',
      framework: IMPL === 'go' ? 'net/http' : 'fastapi 0.x / uvicorn 0.x',
      workers: IMPL === 'go' ? 1 : 2,
      gomaxprocs: IMPL === 'go' ? 2 : null,
      model: 'gemini-3.5-flash-lite',
      embed_model: 'gemini-embedding-2',
      gemini_configured: false,
      db_pool_max: 10,
      cgroup_cpu_limit: 2,
      cgroup_memory_limit_bytes: 1073741824,
      started_at: startedAt,
    });
    return path;
  }
  if (method === 'GET' && path === '/bench/ping') return send(res, 200, { ok: true }), path;

  if (method === 'POST' && path === '/v1/sessions') {
    const b = await readJson(req);
    if (!b || typeof b.user_id !== 'string') return err(res, 400, 'BAD_REQUEST', 'user_id required'), path;
    const id = randomUUID();
    const created_at = new Date().toISOString();
    sessions.set(id, { user_id: b.user_id, created_at, events: [] });
    return send(res, 201, { session_id: id, user_id: b.user_id, created_at }), path;
  }
  const sm = /^\/v1\/sessions\/([^/]+)$/.exec(path);
  if (sm) {
    const route = '/v1/sessions/{session_id}';
    const s = sessions.get(decodeURIComponent(sm[1]));
    if (!s) return err(res, 404, 'SESSION_NOT_FOUND', 'session not found'), route;
    if (method === 'GET') return send(res, 200, { session_id: sm[1], events: s.events }), route;
    if (method === 'DELETE') return sessions.delete(sm[1]), send(res, 204), route;
  }

  if (method === 'POST' && (path === '/v1/chat' || path === '/v1/chat/stream')) {
    const b = await readJson(req);
    if (!b || typeof b.user_id !== 'string' || typeof b.session_id !== 'string' || typeof b.message !== 'string' || !b.message) {
      return err(res, 400, 'BAD_REQUEST', 'user_id, session_id, message required'), path;
    }
    if (!sessions.has(b.session_id)) return err(res, 404, 'SESSION_NOT_FOUND', 'session not found'), path;
    if (path === '/v1/chat') {
      const out = await runChat(b, () => undefined);
      if (out.error) return send(res, 502, { ...out.error, request_id: out.request_id }), path;
      const t = out.timings;
      send(res, 200, { request_id: out.request_id, session_id: b.session_id, reply: out.reply, tool_calls: out.tool_calls, timings: t, usage: out.usage }, {
        'server-timing': `total;dur=${t.server_total_ms}, model;dur=${t.model_ms}, tool;dur=${t.tool_ms}, session;dur=${t.session_ms}`,
      });
      return path;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    let closed = false;
    res.on('close', () => (closed = true));
    const write = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const out = await runChat(b, write);
    if (out.error) write('error', { request_id: out.request_id, ...out.error });
    else write('done', { request_id: out.request_id, reply: out.reply, timings: out.timings, usage: out.usage });
    res.end();
    return path;
  }

  if (path === '/v1/rag/stats' && method === 'GET') {
    let chunks = 0;
    let chars = 0;
    let last: string | null = null;
    for (const d of kb.values()) {
      chunks += d.chunks;
      chars += d.content.length;
      if (!last || d.ingested_at > last) last = d.ingested_at;
    }
    return send(res, 200, { documents: kb.size, chunks, chars, gemini_embedded_chunks: 0, last_ingested_at: last }), path;
  }
  if (path === '/v1/rag/ingest' && method === 'POST') {
    const b = await readJson(req);
    if (!b) return err(res, 400, 'BAD_REQUEST', 'invalid JSON'), path;
    const docs = Array.isArray(b.documents)
      ? (b.documents as { source: string; title?: string; content: string }[])
      : b.corpus === 'default'
        ? DEFAULT_CORPUS
        : null;
    if (!docs) return err(res, 400, 'BAD_REQUEST', 'corpus or documents required'), path;
    const st = now();
    let documents = 0;
    let skipped = 0;
    let chunks = 0;
    let chars = 0;
    for (const d of docs) {
      if (typeof d.source !== 'string' || typeof d.content !== 'string') return err(res, 400, 'BAD_REQUEST', 'document needs source+content'), path;
      const prev = kb.get(d.source);
      if (prev && prev.content === d.content && !b.force) {
        skipped++;
        continue;
      }
      const n = chunkCount(d.content);
      kb.set(d.source, { title: d.title ?? d.source.split('/').pop()!.replace(/\.\w+$/, ''), content: d.content, chunks: n, ingested_at: new Date().toISOString() });
      documents++;
      chunks += n;
      chars += d.content.length;
    }
    const embedMs = 40 * Math.ceil(chunks / 100);
    await sleep(embedMs);
    const total = now() - st;
    return send(res, 200, { documents, skipped, chunks, chars, embedders: ['mock'], timings: { read_ms: 0.4, chunk_ms: 0.8, embed_ms: embedMs, embed_mock_ms: embedMs, db_ms: 3.2, total_ms: Math.round(total * 100) / 100 } }), path;
  }
  if (path === '/v1/rag/search' && method === 'GET') {
    const q = url.searchParams.get('q') ?? (url.searchParams.get('preset') === 'random' ? 'how does hybrid search work' : '');
    if (!q) return err(res, 400, 'BAD_REQUEST', 'q required'), path;
    const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k') ?? 5) || 5));
    const words = q.toLowerCase().split(/\W+/).filter(Boolean);
    const results = [...kb.entries()]
      .map(([source, d]) => ({ source, title: d.title, heading: d.content.match(/^#+\s*(.+)$/m)?.[1] ?? '', content: d.content.slice(0, 400), score: words.filter((w) => d.content.toLowerCase().includes(w)).length / Math.max(1, words.length) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    await sleep(IMPL === 'go' ? 42 : 44);
    return send(res, 200, { query: q, mode: url.searchParams.get('mode') ?? 'hybrid', embedder: url.searchParams.get('embedder') ?? 'mock', results, timings: { embed_ms: 40.1, db_ms: 2.4, total_ms: IMPL === 'go' ? 42.9 : 45.3 } }), path;
  }
  if (path === '/v1/rag/documents' && method === 'DELETE') return kb.clear(), send(res, 204), path;
  if (path === '/v1/rag/chunk' && method === 'POST') {
    const b = await readJson(req);
    if (!b || typeof b.content !== 'string') return err(res, 400, 'BAD_REQUEST', 'content required'), path;
    const parts = b.content.split(/\n(?=#)/);
    return send(res, 200, { chunks: parts.map((c, i) => ({ chunk_index: i, heading: c.match(/^#+\s*(.+)$/m)?.[1] ?? '', content: c })) }), path;
  }
  if (path === '/v1/rag/embed' && method === 'POST') {
    const b = await readJson(req);
    if (!b || !Array.isArray(b.texts)) return err(res, 400, 'BAD_REQUEST', 'texts required'), path;
    const vectors = (b.texts as string[]).map((t) => Array.from({ length: 768 }, (_, i) => Math.sin(i + t.length) / 27.7));
    return send(res, 200, { dim: 768, vectors, timings: { embed_ms: 40, total_ms: 40.5 } }), path;
  }

  err(res, 404, 'NOT_FOUND', `no route ${method} ${path}`);
  return 'unmatched';
}

const server = http.createServer((req, res) => {
  const st = now();
  inFlight++;
  handle(req, res)
    .then((route) => {
      const done = () => {
        inFlight--;
        observe(route, res.statusCode, (now() - st) / 1000);
      };
      if (res.writableFinished) done();
      else res.once('close', done);
    })
    .catch((e) => {
      inFlight--;
      if (!res.headersSent) err(res, 500, 'INTERNAL', String(e));
      else res.end();
    });
});
server.listen(PORT, '0.0.0.0', () => console.log(`stub ${IMPL} target listening on :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => process.exit(0));
