// Fixture-backed implementation of the dashboard API for standalone UI development (VITE_MOCK=1).
import type {
  ChatStreamEvent, ChatTurn, Conversation, ConversationDetail, IngestResponse, LiveSample, LiveTarget, PlatformInfo,
  PlatformMode, RagStats, RunDetail, RunPhase, RunStreamEvent, RunSummary, SearchResponse, StaticMeasurement, Target,
  TargetsResponse, ToolCall,
} from '../../types';
import { TARGET_ORDER } from '../../types';
import type { Api, DxNotes } from '../types';
import { ApiError } from '../types';
import { SCENARIOS } from './scenarios';
import { generateDetail, headlineOf, seedRuns } from './runs';
import { jitter, rng, sleep, uuid } from './rng';

const r = rng(42);
const MB = 1024 * 1024;

function mockPlatformMode(): PlatformMode {
  try {
    const q = new URLSearchParams(window.location.search).get('mockPlatform');
    if (q === 'k8s' || q === 'compose') localStorage.setItem('bench.mockPlatform', q);
    const v = localStorage.getItem('bench.mockPlatform');
    if (v === 'k8s' || v === 'compose') return v;
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_MOCK_PLATFORM === 'k8s' ? 'k8s' : 'compose';
}
const PLATFORM = mockPlatformMode();
const delay = (ms = 150) => sleep(ms + r() * 120);

const startedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
const TARGETS: TargetsResponse = {
  go: {
    healthy: true,
    url: PLATFORM === 'k8s' ? 'http://go-server.bench.svc:8080' : 'http://go-server:8080',
    info: { impl: 'go', runtime: 'go1.25.1', adk_version: 'adk-go v2.5.0', framework: 'net/http', workers: 1, gomaxprocs: 4, model: 'gemini-2.5-flash', embed_model: 'gemini-embedding-2', gemini_configured: true, db_pool_max: 20, cgroup_cpu_limit: 4, cgroup_memory_limit_bytes: 1024 * MB, started_at: startedAt },
    rag: { documents: 24, chunks: 412, chars: 811_204, gemini_embedded_chunks: 412, last_ingested_at: startedAt },
  },
  python: {
    healthy: true,
    url: PLATFORM === 'k8s' ? 'http://fastapi-server.bench.svc:8080' : 'http://fastapi-server:8080',
    info: { impl: 'python', runtime: 'CPython 3.13.2', adk_version: 'google-adk 2.1.0', framework: 'FastAPI 0.118 / uvicorn', workers: 4, gomaxprocs: null, model: 'gemini-2.5-flash', embed_model: 'gemini-embedding-2', gemini_configured: true, db_pool_max: 20, cgroup_cpu_limit: 4, cgroup_memory_limit_bytes: 1024 * MB, started_at: startedAt },
    rag: { documents: 24, chunks: 412, chars: 811_204, gemini_embedded_chunks: 398, last_ingested_at: startedAt },
  },
};

const limits = { cpus: 4, memory_bytes: 1024 * MB, cpuset: '0-3' };
const PLATFORM_INFO: PlatformInfo = {
  mode: PLATFORM,
  host: { arch: 'x86_64', kernel: '6.8.0-45-generic', os: 'Ubuntu 24.04.1 LTS', ncpu: 8, mem_bytes: 32 * 1024 * MB },
  limits: { go: limits, python: limits, postgres: { cpus: 2, memory_bytes: 2048 * MB }, dashboard: { cpus: 2, memory_bytes: 1024 * MB, cpuset: '6-7' } },
  images: {
    go: { ref: 'localhost:5000/go-server:3f9c2ab', digest: 'sha256:1b9e…', size_bytes: 24.6 * MB },
    python: { ref: 'localhost:5000/fastapi-server:3f9c2ab', digest: 'sha256:8c41…', size_bytes: 412 * MB },
  },
  k8s:
    PLATFORM === 'k8s'
      ? {
          node: 'bench-node-1', k3s_version: 'v1.31.4+k3s1', overlay: 'bench',
          pods: [
            { name: 'go-server-6f9c7d8b5-x2kqp', target: 'go', phase: 'Running', ready: true, restarts: 0, qos_class: 'Guaranteed', node: 'bench-node-1' },
            { name: 'fastapi-server-7b5d9c6f4-m8zrt', target: 'python', phase: 'Running', ready: true, restarts: 1, qos_class: 'Guaranteed', node: 'bench-node-1' },
            { name: 'fastapi-server-7b5d9c6f4-q4lnv', target: 'python', phase: 'Running', ready: false, restarts: 5, qos_class: 'Guaranteed', node: 'bench-node-1', reason: 'CrashLoopBackOff' },
            { name: 'postgres-0', target: 'postgres', phase: 'Running', ready: true, restarts: 0, qos_class: 'Burstable', node: 'bench-node-1' },
            { name: 'dashboard-5c8d7f9b6-h7wxs', target: 'dashboard', phase: 'Running', ready: true, restarts: 0, qos_class: 'Burstable', node: 'bench-node-1' },
          ],
          hpa: { go: { min: 1, max: 4, current: 1, desired: 1 }, python: { min: 1, max: 4, current: 2, desired: 2 } },
        }
      : undefined,
};

// ── Conversations ────────────────────────────────────────────────────────
const conversations: Conversation[] = [];
const turnsByConv = new Map<string, ChatTurn[]>();

function seedConversation() {
  const id = '5e1d9a3c-0b7f-4c6e-8a21-9f3b2d1c0e11';
  const conv: Conversation = { id, title: "What's our electronics stock?", mode: 'mock', go_session_id: 'go-s-1', py_session_id: 'py-s-1', created_at: new Date(Date.now() - 3600_000).toISOString() };
  conversations.push(conv);
  const mkTurn = (target: Target, f: number): ChatTurn => ({
    turn_index: 0, target, request_id: uuid(r), user_message: "What's our electronics stock?",
    reply_text: 'Electronics has **12,412 items** in stock across 3 warehouses (avg price $214.30). Lowest stock: USB-C hubs (41 units).',
    tool_calls: [{ name: 'get_inventory_stats', args: { category: 'electronics' }, duration_ms: 3.1 * f, result_summary: { count: 12412 } }],
    status: 'ok', timings: { server_total_ms: 214 * f, first_token_ms: 41 * f, model_ms: 180, tool_ms: 3.1 * f, session_ms: 6 * f, overhead_ms: 4.2 * f * f },
    client_ttft_ms: 44 * f, client_total_ms: 219 * f, usage: { input_tokens: 412, output_tokens: 38 }, created_at: conv.created_at,
  });
  turnsByConv.set(id, [mkTurn('go', 1), mkTurn('python', 1.9)]);
}
seedConversation();

const KB_DOCS = [
  { source: 'docs/07-KUBERNETES.md', title: 'Kubernetes', heading: 'Probes', content: 'startupProbe gates liveness until the server has opened its DB pool; readinessProbe hits /readyz every 5 s…' },
  { source: 'docs/09-RAG.md', title: 'RAG', heading: 'Hybrid search (RRF)', content: 'Vector and full-text candidates are fused with reciprocal rank fusion, k=60, both computed in one SQL statement…' },
  { source: 'docs/02-TECHNICAL-REQUIREMENTS.md', title: 'Technical requirements', heading: 'Run protocol', content: 'Targets run sequentially, never at the same time. Order alternates between reps (Go→Py, then Py→Go)…' },
  { source: 'docs/05-DATABASE-SCHEMA.md', title: 'Database schema', heading: 'bench_items', content: '100k seeded rows with category, price, stock and a GIN index on tags…' },
  { source: 'docs/01-PRD.md', title: 'PRD', heading: 'Non-functional requirements', content: 'The load generator must not exceed 85% CPU; otherwise the run is flagged suspect…' },
];

function pickReply(msg: string): { text: string; tools: ToolCall[]; fail?: Target } {
  const m = msg.toLowerCase();
  if (m.includes('error') || m.includes('429')) {
    return { text: 'Here is a partial answer before the upstream failed.', tools: [], fail: 'python' };
  }
  if (/(doc|kubernetes|k8s|probe|rag|how)/.test(m)) {
    return {
      text: 'Kubernetes uses a **startupProbe** so slow-starting pods are not killed early, then a readinessProbe on `/readyz` decides when the Service routes traffic [docs/07-KUBERNETES.md › Probes]. Retrieval itself fuses vector and FTS results with RRF [docs/09-RAG.md › Hybrid search (RRF)].',
      tools: [{ name: 'search_knowledge_base', args: { query: msg, k: 5 }, duration_ms: 14.2, embed_ms: 0.6, db_ms: 11.8, result_summary: { count: 3, sources: KB_DOCS.slice(0, 3).map((d) => ({ source: d.source, heading: d.heading })) } }],
    };
  }
  if (/(stock|inventory|item|electronics)/.test(m)) {
    return {
      text: 'Electronics has **12,412 items** in stock across 3 warehouses. The lowest-stock SKU is the USB-C hub (41 units); average price is $214.30.',
      tools: [{ name: 'get_inventory_stats', args: { category: 'electronics' }, duration_ms: 3.1, db_ms: 2.7, result_summary: { count: 12412, avg_price: 214.3 } }],
    };
  }
  return { text: `You said: "${msg}". I'm the benchmark agent — ask me about inventory (tool: get_inventory_stats) or the project docs (tool: search_knowledge_base).`, tools: [] };
}

// ── Runs ─────────────────────────────────────────────────────────────────
const runs: RunSummary[] = seedRuns();
const details = new Map<string, RunDetail>();
const runListeners = new Map<string, Set<(e: RunStreamEvent) => void>>();
let activeRunId: string | null = null;
const detailOf = (id: string): RunDetail => {
  let d = details.get(id);
  if (!d) {
    const s = runs.find((x) => x.id === id);
    if (!s) throw new ApiError(404, `run ${id} not found`);
    d = generateDetail(s);
    details.set(id, d);
  }
  return d;
};
function emitRun(id: string, e: RunStreamEvent) {
  runListeners.get(id)?.forEach((fn) => fn(e));
}
const runLog: Map<string, RunStreamEvent[]> = new Map();

async function simulateRun(id: string) {
  const s = runs.find((x) => x.id === id)!;
  const log: RunStreamEvent[] = [];
  runLog.set(id, log);
  const push = (e: RunStreamEvent) => {
    if (e.type !== 'progress') log.push(e);
    emitRun(id, e);
  };
  const phase = (status: RunSummary['status'], ph: RunPhase, rep: number, target: Target | null) => {
    s.status = status;
    push({ type: 'phase', status, phase: ph, rep, reps: s.config.reps, target, started_at: s.started_at! });
  };
  const isCancelled = (): boolean => (s.status as string) === 'cancelled';
  s.started_at = new Date().toISOString();
  phase('preflight', 'preflight', 0, null);
  push({ type: 'log', level: 'info', message: 'preflight: go healthy (adk-go v2.5.0), python healthy (google-adk 2.1.0)' });
  push({ type: 'log', level: 'info', message: `platform=${s.platform}; quiet-mode acknowledged` });
  await sleep(1200);
  const prof = generateDetail(s);
  const runSecs = Math.min(6, s.config.duration_s ?? 6);
  for (let rep = 1; rep <= s.config.reps; rep++) {
    const order = rep % 2 === 1 ? TARGET_ORDER : [...TARGET_ORDER].reverse();
    for (const t of order) {
      if (!s.config.targets.includes(t)) continue;
      if (isCancelled()) return;
      phase('running', 'warmup', rep, t);
      push({ type: 'log', level: 'info', message: `rep ${rep}/${s.config.reps}: warm-up ${t} (${s.config.warmup_s}s, c=${s.config.concurrency})` });
      await sleep(800);
      phase('running', 'run', rep, t);
      push({ type: 'log', level: 'info', message: `rep ${rep}: measuring ${t}` });
      const res = prof.results.find((x) => x.target === t && x.rep === rep)!;
      for (let i = 0; i < runSecs * 2; i++) {
        if (isCancelled()) return;
        await sleep(500);
        push({
          type: 'progress', target: t, rep, t_offset_s: i / 2, rps: jitter(r, res.rps, 0.06), p50_ms: jitter(r, res.lat_p50_ms ?? 1, 0.08),
          p99_ms: jitter(r, res.lat_p99_ms ?? 1, 0.15), errors: 0, cpu_pct: jitter(r, res.cpu_avg_pct ?? 50, 0.05), mem_mb: jitter(r, res.mem_avg_mb ?? 50, 0.02),
          replicas: s.layer === 'k8s' ? 1 + Math.floor((i / (runSecs * 2)) * 3) : undefined,
        });
      }
      phase('running', 'cooldown', rep, t);
      await sleep(500);
    }
  }
  phase('analyzing', 'analyze', s.config.reps, null);
  push({ type: 'log', level: 'info', message: 'analyze: computing medians across reps, checking suspect flags' });
  await sleep(1000);
  s.status = 'complete';
  s.finished_at = new Date().toISOString();
  const detail = generateDetail(s);
  detail.run.status = 'complete';
  details.set(id, detail);
  s.headline = headlineOf(detail);
  activeRunId = null;
  push({ type: 'complete', run: detail });
}

// ── KB ───────────────────────────────────────────────────────────────────
const kbStats: Record<Target, RagStats> = { go: TARGETS.go.rag!, python: TARGETS.python.rag! };
function ingestResponse(t: Target, docs: number): IngestResponse {
  const f = t === 'go' ? 1 : 2.6;
  const embed = jitter(r, 84 * f, 0.1);
  const db = jitter(r, 41 * f, 0.1);
  return {
    documents: docs, skipped: 0, chunks: docs * 17, chars: docs * 33_800, embedders: ['mock', 'gemini'],
    timings: { read_ms: jitter(r, 3 * f, 0.2), chunk_ms: jitter(r, 12 * f, 0.1), embed_ms: embed, embed_mock_ms: embed * 0.08, embed_gemini_ms: embed * 0.92, db_ms: db, total_ms: embed + db + 20 * f },
  };
}

// ── Static / DX ──────────────────────────────────────────────────────────
const measuredAt = new Date(Date.now() - 86400_000).toISOString();
let staticMeasurements: StaticMeasurement[] = [
  ['image_size_mb', 24.6, 412], ['idle_mem_mb', 11.8, 142], ['cold_start_ms', 310, 2480], ['dep_count', 38, 96],
].flatMap(([metric, go, py]) => [
  { target: 'go' as const, metric: metric as string, platform: PLATFORM, value: go as number, measured_at: measuredAt },
  { target: 'python' as const, metric: metric as string, platform: PLATFORM, value: py as number, measured_at: measuredAt },
]);
const dx: DxNotes = {
  go: { markdown: '## Go (adk-go)\n\n- LOC: ~1,450\n- Build: 14 s (cached), single static binary\n- Pain: verbose SSE plumbing; fewer ADK examples\n', updated_at: measuredAt },
  python: { markdown: '## Python (google-adk + FastAPI)\n\n- LOC: ~980\n- Build: 48 s (uv sync)\n- Pain: tuning uvicorn workers vs pods; asyncpg pool per worker\n', updated_at: measuredAt },
};

// ── Live ─────────────────────────────────────────────────────────────────
function liveTarget(t: Target, busy: boolean, ts: number): LiveTarget {
  const go = t === 'go';
  const wave = 0.5 + 0.5 * Math.sin(ts / 9000 + (go ? 0 : 1));
  const load = busy ? 1 : 0.04 + 0.05 * wave;
  return {
    healthy: true,
    cpu_pct: jitter(r, (go ? 360 : 395) * load + (go ? 0.4 : 1.6), 0.08),
    mem_mb: jitter(r, go ? 18 + 40 * load : 150 + 110 * load, 0.02),
    mem_limit_mb: 1024,
    net_rx_bytes: Math.round(jitter(r, 2e6 * load, 0.1)),
    net_tx_bytes: Math.round(jitter(r, 3e6 * load, 0.1)),
    threads: go ? Math.round(jitter(r, 14 + 70 * load, 0.05)) : Math.round(jitter(r, 22 + 8 * load, 0.05)),
    rps: busy || load > 0.05 ? jitter(r, (go ? 6200 : 1080) * load, 0.06) : 0,
    err_rate: busy && !go ? 0.002 : 0,
    p50_ms: jitter(r, go ? 7.9 : 45, 0.1),
    p95_ms: jitter(r, go ? 15 : 110, 0.1),
    p99_ms: jitter(r, go ? 21 : 152, 0.12),
    throttled_pct: busy ? jitter(r, go ? 2 : 8, 0.3) : 0,
    db_pool_in_use: Math.round(r() * (busy ? 12 : 1)),
    replicas: PLATFORM === 'k8s' ? (go ? 1 : 2) : null,
  };
}
function liveSample(ts: number): LiveSample {
  const busy = !!activeRunId;
  return {
    ts: new Date(ts).toISOString(),
    platform: PLATFORM,
    targets: { go: liveTarget('go', busy, ts), python: liveTarget('python', busy, ts) },
    postgres: { cpu_pct: jitter(r, busy ? 85 : 3, 0.1), mem_mb: jitter(r, 310, 0.02), mem_limit_mb: 2048 },
    dashboard: { cpu_pct: jitter(r, busy ? 62 : 2, 0.15), mem_mb: jitter(r, 120, 0.02), mem_limit_mb: 1024 },
    active_run_id: activeRunId,
  };
}

export const mockApi: Api = {
  async health() {
    await delay(20);
    return { ok: true };
  },
  async targets() {
    await delay(60);
    return structuredClone(TARGETS);
  },
  async platform() {
    await delay(60);
    return structuredClone(PLATFORM_INFO);
  },

  async conversations() {
    await delay();
    return [...conversations].sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async createConversation(req) {
    await delay(60);
    const c: Conversation = { id: uuid(r), title: req.title ?? null, mode: req.mode, go_session_id: null, py_session_id: null, created_at: new Date().toISOString() };
    conversations.push(c);
    turnsByConv.set(c.id, []);
    return c;
  },
  async conversation(id): Promise<ConversationDetail> {
    await delay();
    const c = conversations.find((x) => x.id === id);
    if (!c) throw new ApiError(404, 'conversation not found');
    return { conversation: c, turns: turnsByConv.get(id) ?? [] };
  },
  async chat(req, onEvent, signal) {
    const conv = conversations.find((c) => c.id === req.conversation_id);
    if (!conv) throw new ApiError(404, 'conversation not found');
    if (!conv.title) conv.title = req.message.slice(0, 60);
    const turns = turnsByConv.get(conv.id) ?? [];
    const turnIndex = turns.length ? Math.max(...turns.map((t) => t.turn_index)) + 1 : 0;
    const t0 = performance.now();
    const cms = () => Math.round((performance.now() - t0) * 10) / 10;
    const plan = pickReply(req.message);
    const gemini = req.mode === 'gemini';
    const results: ChatTurn[] = [];

    const runTarget = async (t: Target) => {
      const f = t === 'go' ? 1 : 1.7;
      const requestId = uuid(r);
      await sleep((gemini ? 60 : 8) * f, signal);
      onEvent({ type: 'meta', target: t, request_id: requestId, session_id: `${t}-session`, model: gemini ? 'gemini-2.5-flash' : 'mock-llm', client_ms: cms() });
      const tools: ToolCall[] = [];
      for (const tool of plan.tools) {
        await sleep((gemini ? 300 : 20) * f, signal);
        const tc = { ...tool, duration_ms: tool.duration_ms * f, db_ms: tool.db_ms ? tool.db_ms * f : undefined };
        tools.push(tc);
        onEvent({ type: 'tool_call', target: t, tool: tc, client_ms: cms() });
      }
      if (plan.fail === t) {
        await sleep(400, signal);
        onEvent({ type: 'error', target: t, code: 'UPSTREAM_429', message: 'Gemini returned 429 RESOURCE_EXHAUSTED', client_ms: cms() });
        results.push({ turn_index: turnIndex, target: t, request_id: requestId, user_message: req.message, reply_text: null, tool_calls: tools, status: 'error', error_code: 'UPSTREAM_429', created_at: new Date().toISOString() });
        return;
      }
      const words = plan.text.split(/(?<= )/);
      let ttft: number | null = null;
      for (let i = 0; i < words.length; i++) {
        await sleep((gemini ? 45 : 18) * (0.6 + r() * 0.8), signal);
        const c = cms();
        ttft ??= c;
        onEvent({ type: 'token', target: t, text: words[i], seq: i, client_ms: c });
      }
      const total = cms();
      const toolMs = tools.reduce((a, x) => a + x.duration_ms, 0);
      const overhead = (t === 'go' ? 0.9 : 6.4) * (gemini ? 4 : 1) * jitter(r, 1, 0.2);
      const session = (t === 'go' ? 2.1 : 5.2) * jitter(r, 1, 0.2);
      const model = Math.max(1, total - toolMs - overhead - session);
      const timings = { server_total_ms: total - 2, first_token_ms: (ttft ?? total) - 1, model_ms: model, tool_ms: toolMs, session_ms: session, overhead_ms: overhead };
      const usage = { input_tokens: 380 + Math.round(r() * 60), output_tokens: words.length * 1.3 | 0 };
      onEvent({ type: 'done', target: t, reply: plan.text, timings, usage, client_ttft_ms: ttft, client_total_ms: total });
      results.push({ turn_index: turnIndex, target: t, request_id: requestId, user_message: req.message, reply_text: plan.text, tool_calls: tools, status: 'ok', timings, client_ttft_ms: ttft, client_total_ms: total, usage, created_at: new Date().toISOString() });
    };

    await Promise.all(TARGET_ORDER.filter((t) => req.targets.includes(t)).map(runTarget)).catch((e: Error) => {
      if (e.name !== 'AbortError') throw e;
    });
    if (signal?.aborted) return;
    const ordered = TARGET_ORDER.flatMap((t) => results.filter((x) => x.target === t));
    turnsByConv.set(conv.id, [...turns, ...ordered]);
    const ev: ChatStreamEvent = { type: 'turn_complete', turn_index: turnIndex, turns: ordered };
    onEvent(ev);
  },

  async kbStats() {
    await delay();
    return structuredClone(kbStats);
  },
  async kbIngest() {
    await sleep(900);
    return { go: ingestResponse('go', 24), python: ingestResponse('python', 24) };
  },
  async kbUpload(files) {
    await sleep(700);
    for (const t of TARGET_ORDER) {
      kbStats[t].documents += files.length;
      kbStats[t].chunks += files.length * 6;
    }
    return { go: ingestResponse('go', files.length), python: ingestResponse('python', files.length) };
  },
  async kbSearch(p) {
    await delay(200);
    const mk = (t: Target): SearchResponse => {
      const f = t === 'go' ? 1 : 2.3;
      const rr = rng(p.q.length * 31 + (p.mode === 'fts' ? 3 : p.mode === 'vector' ? 7 : 1));
      const results = [...KB_DOCS]
        .sort(() => rr() - 0.5)
        .slice(0, Math.min(p.k ?? 5, 5))
        .map((d, i) => ({ ...d, score: p.mode === 'hybrid' ? 0.0328 - i * 0.0021 : p.mode === 'fts' ? 0.42 - i * 0.07 : 0.86 - i * 0.04 }));
      const embed = p.mode === 'fts' ? undefined : (p.embedder === 'gemini' ? 182 : 0.4) * (t === 'go' ? 1 : 1.4);
      const db = jitter(r, 6.5 * f, 0.1);
      return { query: p.q, mode: p.mode, embedder: p.embedder, results, timings: { embed_ms: embed, db_ms: db, total_ms: (embed ?? 0) + db + 0.8 * f } };
    };
    if (p.embedder === 'gemini' && p.q.toLowerCase().includes('fail')) return { go: mk('go'), python: { error: 'UPSTREAM_429: embedding quota exhausted' } };
    return { go: mk('go'), python: mk('python') };
  },

  live(h) {
    const now = Date.now();
    // Backfill 90 s so charts aren't empty on first paint.
    for (let i = 90; i > 0; i--) h.onEvent(liveSample(now - i * 1000));
    h.onOpen?.();
    const iv = setInterval(() => h.onEvent(liveSample(Date.now())), 1000);
    return () => clearInterval(iv);
  },

  async scenarios() {
    await delay();
    return structuredClone(SCENARIOS);
  },
  async startRun(req) {
    await delay(150);
    const sc = SCENARIOS.find((s) => s.id === req.scenario);
    if (!sc) return { ok: false, status: 400, error: `unknown scenario ${req.scenario}` };
    if (activeRunId) return { ok: false, status: 409, error: 'another run is in progress', active_run_id: activeRunId };
    if (sc.requires_gemini && !req.confirm_gemini) return { ok: false, status: 400, error: 'confirm_gemini required for Gemini scenarios' };
    if (!sc.platforms.includes(PLATFORM)) return { ok: false, status: 400, error: `${sc.id} requires platform ${sc.platforms.join('/')}` };
    const id = uuid(r);
    runs.unshift({
      id, scenario: sc.id, layer: sc.layer, platform: PLATFORM, status: 'queued', suspect: false, suspect_reasons: [],
      config: { ...sc.defaults, ...req.config }, created_at: new Date().toISOString(), started_at: null, finished_at: null,
    });
    activeRunId = id;
    void simulateRun(id);
    return { ok: true, run_id: id };
  },
  async runs(f = {}) {
    await delay();
    return runs.filter((x) => (!f.scenario || x.scenario === f.scenario) && (!f.platform || x.platform === f.platform) && (!f.status || x.status === f.status)).slice(0, f.limit ?? 100);
  },
  async run(id) {
    await delay();
    const s = runs.find((x) => x.id === id);
    if (!s) throw new ApiError(404, `run ${id} not found`);
    if (s.status !== 'complete' && s.status !== 'failed' && s.status !== 'cancelled') {
      return { run: { ...s }, results: [], samples: [], summary: {}, deltas: [] };
    }
    return detailOf(id);
  },
  runStream(id, h) {
    const s = runs.find((x) => x.id === id);
    const listener = (e: RunStreamEvent) => h.onEvent(e);
    setTimeout(() => {
      h.onOpen?.();
      if (!s) return h.onError?.(new Error('not found'));
      if (s.status === 'complete') return h.onEvent({ type: 'complete', run: detailOf(id) });
      if (s.status === 'failed') return h.onEvent({ type: 'failed', error: detailOf(id).run.error ?? 'failed' });
      if (s.status === 'cancelled') return h.onEvent({ type: 'cancelled' });
      for (const e of runLog.get(id) ?? []) h.onEvent(e);
    }, 50);
    if (!runListeners.has(id)) runListeners.set(id, new Set());
    runListeners.get(id)!.add(listener);
    return () => runListeners.get(id)?.delete(listener);
  },
  async cancelRun(id) {
    const s = runs.find((x) => x.id === id);
    if (s && activeRunId === id) {
      s.status = 'cancelled';
      s.finished_at = new Date().toISOString();
      activeRunId = null;
      emitRun(id, { type: 'cancelled' });
    }
  },
  async deleteRun(id) {
    const i = runs.findIndex((x) => x.id === id);
    if (i >= 0) runs.splice(i, 1);
  },
  async compare(a, b) {
    await delay();
    return { a: detailOf(a), b: detailOf(b) };
  },
  async exportRun(id, format) {
    const d = detailOf(id);
    let text: string;
    if (format === 'json') text = JSON.stringify(d, null, 2);
    else if (format === 'csv') {
      const cols = ['target', 'rep', 'rps', 'lat_p50_ms', 'lat_p99_ms', 'cpu_avg_pct', 'mem_max_mb', 'errors_total'] as const;
      text = [cols.join(','), ...d.results.map((x) => cols.map((c) => x[c]).join(','))].join('\n');
    } else text = `# Run ${id}\n\nScenario: ${d.run.scenario}\n\n| metric | go | python |\n|---|---|---|\n${d.deltas.map((x) => `| ${x.metric} | ${x.go?.toFixed(2) ?? '—'} | ${x.python?.toFixed(2) ?? '—'} |`).join('\n')}\n`;
    return { blob: new Blob([text], { type: 'text/plain' }), filename: `run-${id.slice(0, 8)}.${format}` };
  },

  async staticMeasurements() {
    await delay();
    return structuredClone(staticMeasurements);
  },
  async measureStatic() {
    await delay();
    const at = new Date().toISOString();
    staticMeasurements = staticMeasurements.map((m) => ({ ...m, value: m.metric === 'idle_mem_mb' ? jitter(r, m.value, 0.05) : m.value, measured_at: at }));
  },
  async dxNotes() {
    await delay();
    return structuredClone(dx);
  },
  async saveDxNote(t, markdown) {
    await delay();
    dx[t] = { markdown, updated_at: new Date().toISOString() };
  },
  async report() {
    await sleep(600);
    const latest = runs.filter((x) => x.status === 'complete' && !x.suspect);
    return [
      '# Decision Report — Go (adk-go) vs Python (google-adk + FastAPI)',
      '',
      `Generated ${new Date().toISOString()} · platform ${PLATFORM} · mock data`,
      '',
      '## Headline',
      '',
      '| scenario | Go RPS | Py RPS | Go p99 | Py p99 |',
      '|---|---|---|---|---|',
      ...latest.map((x) => `| ${x.scenario} | ${x.headline?.go?.rps?.toFixed(0) ?? '—'} | ${x.headline?.python?.rps?.toFixed(0) ?? '—'} | ${x.headline?.go?.p99_ms?.toFixed(1) ?? '—'} | ${x.headline?.python?.p99_ms?.toFixed(1) ?? '—'} |`),
      '',
      '## DX notes',
      '',
      dx.go.markdown,
      dx.python.markdown,
    ].join('\n');
  },
};
