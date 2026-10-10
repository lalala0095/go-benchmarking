// Scenario catalogue (docs/02 §6, docs/09 §8, docs/07 §5) + request validation.
import type { PlatformMode, RunConfig, Scenario, StartRunRequest, Target } from '../../../shared/api.js';
import { TARGETS } from '../../../shared/api.js';

/** How the orchestrator drives a scenario (internal; not part of the public Scenario shape). */
export type ScenarioKind =
  | { kind: 'http'; method: 'GET' | 'POST'; path: string; body?: 'json-10kb' | 'rag-chunk' | 'rag-embed' | 'db-write' }
  | { kind: 'chat'; prompt: 'plain' | 'inventory' | 'rag' }
  | { kind: 'ingest'; body: Record<string, unknown> }
  | { kind: 'cold-start' }
  | { kind: 'scale-out' }
  | { kind: 'rollout' };

export interface ScenarioDef extends Scenario { run: ScenarioKind }

/** Gemini cost caps (NFR-4). max_requests counts Gemini-backed calls across the whole run (all reps, all targets). */
export const GEMINI_MAX_REQUESTS = 50;
export const GEMINI_MAX_CONCURRENCY = 5;

const BOTH: PlatformMode[] = ['compose', 'k8s'];
const K8S: PlatformMode[] = ['k8s'];

function cfg(c: Partial<RunConfig>): RunConfig {
  return { targets: [...TARGETS], concurrency: 64, duration_s: 20, warmup_s: 5, cooldown_s: 5, reps: 3, ...c };
}

function http(
  id: string, layer: Scenario['layer'], title: string, description: string,
  run: Extract<ScenarioKind, { kind: 'http' }>, defaults: Partial<RunConfig>,
): ScenarioDef {
  return { id, layer, title, description, generator: 'oha', platforms: BOTH, requires_gemini: false, defaults: cfg(defaults), run };
}

function chat(
  id: string, layer: Scenario['layer'], title: string, description: string,
  run: ScenarioKind, defaults: Partial<RunConfig>, platforms = BOTH,
): ScenarioDef {
  return { id, layer, title, description, generator: 'chat', platforms, requires_gemini: false, defaults: cfg({ concurrency: 50, duration_s: 30, mode: 'mock', ...defaults }), run };
}

export const SCENARIOS: ScenarioDef[] = [
  // ── L1: raw runtime ──
  http('ping', 'L1', 'Ping', 'Minimal GET returning {"ok":true}: isolates HTTP stack + routing overhead with no work.',
    { kind: 'http', method: 'GET', path: '/bench/ping' }, { concurrency: 64 }),
  http('json', 'L1', 'JSON parse/serialise', 'POSTs the 10 KB fixture; server parses it, sums prices and echoes 10 items: isolates JSON (de)serialisation cost.',
    { kind: 'http', method: 'POST', path: '/bench/json', body: 'json-10kb' }, { concurrency: 64 }),
  http('cpu', 'L1', 'CPU-bound hashing', 'Chained SHA-256 (n=25 → 25k rounds) per request: isolates raw CPU throughput and how each runtime schedules CPU-bound work.',
    { kind: 'http', method: 'GET', path: '/bench/cpu?n=25' }, { concurrency: 16 }),
  http('sleep-io', 'L1', 'Async I/O wait', '100 ms non-blocking sleep at c=500: isolates concurrency handling of I/O-bound waits (a proxy for awaiting an LLM).',
    { kind: 'http', method: 'GET', path: '/bench/sleep?ms=100' }, { concurrency: 500 }),
  http('rag-chunk', 'L1', 'RAG chunking', 'POSTs the ~200 KB large.md to /v1/rag/chunk: isolates the deterministic chunker (string handling), no DB or embedding.',
    { kind: 'http', method: 'POST', path: '/v1/rag/chunk', body: 'rag-chunk' }, { concurrency: 16 }),
  http('rag-embed-mock', 'L1', 'Mock embedding', 'POSTs 64 texts to /v1/rag/embed with the mock embedder: isolates hashing + float vector math and large JSON responses.',
    { kind: 'http', method: 'POST', path: '/v1/rag/embed', body: 'rag-embed' }, { concurrency: 16 }),
  // ── L2: DB path ──
  http('db-read', 'L2', 'DB point read', 'Primary-key SELECT of a random bench_items row: isolates driver + pool round-trip latency.',
    { kind: 'http', method: 'GET', path: '/bench/db/read' }, { concurrency: 64 }),
  http('db-query', 'L2', 'DB aggregate', 'GROUP BY aggregate over 100k rows: isolates pool behaviour when Postgres does real work per query.',
    { kind: 'http', method: 'GET', path: '/bench/db/query' }, { concurrency: 32 }),
  http('db-write', 'L2', 'DB insert', 'INSERT … RETURNING id of a small JSON payload (table truncated before each target run): isolates write path + JSONB encoding.',
    { kind: 'http', method: 'POST', path: '/bench/db/write', body: 'db-write' }, { concurrency: 32 }),
  http('rag-search', 'L2', 'RAG hybrid search', 'Random preset query, mock embedder, hybrid pgvector kNN + FTS with RRF: isolates the retrieval path (embed + shared SQL).',
    { kind: 'http', method: 'GET', path: '/v1/rag/search?preset=random&mode=hybrid&embedder=mock&k=5' }, { concurrency: 64 }),
  http('rag-search-vector', 'L2', 'RAG vector search', 'Same as rag-search but only the pgvector HNSW arm.',
    { kind: 'http', method: 'GET', path: '/v1/rag/search?preset=random&mode=vector&embedder=mock&k=5' }, { concurrency: 64 }),
  http('rag-search-fts', 'L2', 'RAG full-text search', 'Same as rag-search but only the tsvector/GIN full-text arm (no vector math).',
    { kind: 'http', method: 'GET', path: '/v1/rag/search?preset=random&mode=fts&embedder=mock&k=5' }, { concurrency: 64 }),
  {
    id: 'rag-ingest', layer: 'L2', title: 'RAG ingestion',
    description: 'Sequential POST /v1/rag/ingest of the corpus ×10 (force, mock embedder): isolates chunking, embedding and COPY into Postgres. "rps" = chunks ingested per second.',
    generator: 'orchestrator', platforms: BOTH, requires_gemini: false,
    defaults: cfg({ concurrency: 1, duration_s: undefined, requests: 1, warmup_s: 0, cooldown_s: 3, reps: 5 }),
    limits: { max_concurrency: 1 },
    run: { kind: 'ingest', body: { corpus: 'default', repeat: 10, force: true, embedders: ['mock'] } },
  },
  // ── L3: agent overhead (mock LLM) ──
  chat('chat-mock', 'L3', 'Chat (mock LLM)', 'Streaming chat through the ADK runner with a deterministic mock model: isolates runner, session persistence and SSE overhead without LLM variance.',
    { kind: 'chat', prompt: 'plain' }, {}),
  chat('chat-mock-tool', 'L3', 'Chat + DB tool (mock)', 'As chat-mock but the message triggers get_inventory_stats: adds tool dispatch and a Postgres aggregate inside the agent loop.',
    { kind: 'chat', prompt: 'inventory' }, {}),
  chat('chat-mock-rag', 'L3', 'Chat + RAG tool (mock)', 'As chat-mock but the message triggers search_knowledge_base: adds embedding + hybrid search inside the agent loop.',
    { kind: 'chat', prompt: 'rag' }, {}),
  chat('chat-mock-burst', 'L3', 'Chat burst ramp (mock)', 'Ramps 1 → 500 virtual users over 60 s of mock chat: shows how latency and memory degrade as concurrency climbs.',
    { kind: 'chat', prompt: 'plain' }, { concurrency: 500, duration_s: 60, reps: 1, params: { ramp: { from: 1, to: 500, over_s: 60 } } }),
  // ── L4: real Gemini ──
  {
    id: 'chat-gemini', layer: 'L4', title: 'Chat (real Gemini)',
    description: 'End-to-end chat with gemini-3.5-flash-lite, requests interleaved A/B: what a user actually feels. Capped (≤ 50 requests, c ≤ 5).',
    generator: 'chat', platforms: BOTH, requires_gemini: true,
    defaults: cfg({ concurrency: 2, duration_s: undefined, requests: 10, warmup_s: 0, cooldown_s: 0, reps: 1, mode: 'gemini' }),
    limits: { max_concurrency: GEMINI_MAX_CONCURRENCY, max_requests: GEMINI_MAX_REQUESTS },
    run: { kind: 'chat', prompt: 'plain' },
  },
  {
    id: 'rag-ingest-gemini', layer: 'L4', title: 'RAG ingestion (Gemini embeddings)',
    description: 'Ingests the default corpus once with the real gemini-embedding-2 embedder (force): measures embedding API cost in the ingest path.',
    generator: 'orchestrator', platforms: BOTH, requires_gemini: true,
    defaults: cfg({ concurrency: 1, duration_s: undefined, requests: 1, warmup_s: 0, cooldown_s: 3, reps: 1 }),
    limits: { max_concurrency: 1, max_requests: 2 },
    // Both embedders so mock vectors stay populated for the mock search/chat scenarios.
    run: { kind: 'ingest', body: { corpus: 'default', repeat: 1, force: true, embedders: ['gemini', 'mock'] } },
  },
  // ── Static ──
  {
    id: 'cold-start', layer: 'static', title: 'Cold start',
    description: 'platform.restart() then wait for /healthz (k8s: pod delete → Ready): container start to first healthy response.',
    generator: 'orchestrator', platforms: BOTH, requires_gemini: false,
    defaults: cfg({ concurrency: 1, duration_s: undefined, warmup_s: 0, cooldown_s: 5, reps: 5 }),
    limits: { max_concurrency: 1 },
    run: { kind: 'cold-start' },
  },
  // ── Kubernetes ──
  chat('scale-out', 'k8s', 'HPA scale-out', 'Mock chat ramp 1 → 400 VUs over 120 s with HPA (1–4 replicas, CPU 70%): pods needed, time to scale and pod time-to-Ready.',
    { kind: 'scale-out' },
    { concurrency: 400, duration_s: 120, reps: 1, cooldown_s: 10, params: { ramp: { from: 1, to: 400, over_s: 120 }, hpa: { min: 1, max: 4, cpu: 70 } } }, K8S),
  chat('rollout-disruption', 'k8s', 'Rolling restart under load', 'Constant mock chat c=50; platform.rollout() at t=15 s; runs until new pods are Ready + 10 s (min 60 s): errors and p99 spike = graceful-shutdown quality.',
    { kind: 'rollout' }, { concurrency: 50, duration_s: 60, reps: 1, warmup_s: 5, params: { rollout_at_s: 15, tail_s: 10 } }, K8S),
];

export function getScenario(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Public shape (strip internal `run`). */
export function publicScenarios(): Scenario[] {
  return SCENARIOS.map(({ run: _run, ...s }) => s);
}

export type ResolveResult = { ok: true; config: RunConfig; scenario: ScenarioDef } | { ok: false; error: string };

function intIn(name: string, v: unknown, min: number, maxV: number): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > maxV) return `${name} must be an integer in [${min}, ${maxV}]`;
  return null;
}

/** Merge request config over scenario defaults and validate (incl. platform + Gemini caps). */
export function resolveConfig(req: StartRunRequest, platform: PlatformMode): ResolveResult {
  if (!req || typeof req.scenario !== 'string') return { ok: false, error: 'scenario is required' };
  const s = getScenario(req.scenario);
  if (!s) return { ok: false, error: `unknown scenario '${req.scenario}'` };
  if (!s.platforms.includes(platform)) return { ok: false, error: `scenario '${s.id}' is only available on: ${s.platforms.join(', ')}` };
  const over = (req.config ?? {}) as Partial<RunConfig>;
  if (typeof over !== 'object' || Array.isArray(over)) return { ok: false, error: 'config must be an object' };

  const c: RunConfig = {
    ...s.defaults,
    ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)),
    params: { ...(s.defaults.params ?? {}), ...((over.params as Record<string, unknown>) ?? {}) },
  } as RunConfig;

  // targets
  if (!Array.isArray(c.targets) || c.targets.length === 0) return { ok: false, error: 'targets must be a non-empty array' };
  const uniq = [...new Set(c.targets)];
  if (uniq.some((t) => !TARGETS.includes(t as Target))) return { ok: false, error: `targets must be a subset of ${TARGETS.join(', ')}` };
  c.targets = TARGETS.filter((t) => uniq.includes(t));

  const errs = [
    intIn('concurrency', c.concurrency, 1, 5000),
    intIn('warmup_s', c.warmup_s, 0, 600),
    intIn('cooldown_s', c.cooldown_s, 0, 600),
    intIn('reps', c.reps, 1, 20),
    c.duration_s !== undefined && c.duration_s !== null ? intIn('duration_s', c.duration_s, 1, 3600) : null,
    c.requests !== undefined && c.requests !== null ? intIn('requests', c.requests, 1, 1_000_000) : null,
  ].filter(Boolean);
  if (errs.length) return { ok: false, error: errs.join('; ') };

  const kind = s.run.kind;
  if ((s.generator === 'oha') && !c.duration_s) return { ok: false, error: 'duration_s is required for this scenario' };
  if (s.generator === 'chat' && !c.duration_s && !c.requests) return { ok: false, error: 'duration_s or requests is required' };
  if (c.py_profile !== undefined && c.py_profile !== 'py-1w' && c.py_profile !== 'py-Nw') return { ok: false, error: "py_profile must be 'py-1w' or 'py-Nw'" };

  if (s.limits?.max_concurrency !== undefined && c.concurrency > s.limits.max_concurrency) {
    return { ok: false, error: `concurrency ${c.concurrency} exceeds the cap of ${s.limits.max_concurrency} for ${s.id}` };
  }

  // chat mode: fixed per scenario
  if (s.generator === 'chat') c.mode = s.requires_gemini ? 'gemini' : 'mock';
  else delete c.mode;

  const defRamp = s.defaults.params?.ramp as { from: number; to: number; over_s: number } | undefined;
  if (defRamp) {
    const r = (c.params?.ramp ?? {}) as Partial<{ from: number; to: number; over_s: number }>;
    const ramp = { ...defRamp, ...r };
    const e = intIn('params.ramp.from', ramp.from, 1, 5000) ?? intIn('params.ramp.to', ramp.to, 1, 5000) ?? intIn('params.ramp.over_s', ramp.over_s, 1, 3600);
    if (e) return { ok: false, error: e };
    c.params = { ...c.params, ramp };
    c.concurrency = Math.max(ramp.from, ramp.to);
  }

  if (s.requires_gemini) {
    if (!req.confirm_gemini) return { ok: false, error: `${s.id} calls the real Gemini API; set confirm_gemini: true to acknowledge cost/rate limits` };
    c.warmup_s = 0; // warm-up would spend tokens
    if (kind === 'chat') {
      if (!c.requests) return { ok: false, error: 'requests is required for Gemini chat (count-capped)' };
      delete c.duration_s;
      const total = c.requests * c.reps * c.targets.length;
      if (total > GEMINI_MAX_REQUESTS) {
        return { ok: false, error: `requests × reps × targets = ${total} exceeds the Gemini cap of ${GEMINI_MAX_REQUESTS}` };
      }
    } else {
      const total = c.reps * c.targets.length * (c.requests ?? 1);
      const cap = s.limits?.max_requests ?? GEMINI_MAX_REQUESTS;
      if (total > cap) return { ok: false, error: `reps × targets × requests = ${total} exceeds the Gemini cap of ${cap} for ${s.id}` };
    }
  }
  if (kind === 'ingest' || kind === 'cold-start') c.warmup_s = 0;
  if (req.quiet_mode_ack !== undefined) c.params = { ...c.params, quiet_mode_ack: !!req.quiet_mode_ack };
  if (c.params && Object.keys(c.params).length === 0) delete c.params;
  return { ok: true, config: c, scenario: s };
}

/** A/B order for rep (1-based): odd reps use config order, even reps reverse it (FR-12). */
export function targetOrder(targets: readonly Target[], rep: number): Target[] {
  return rep % 2 === 1 ? [...targets] : [...targets].reverse();
}
