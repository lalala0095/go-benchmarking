import type { Layer, RunConfig, Scenario } from '../../types';

const base: RunConfig = { targets: ['go', 'python'], concurrency: 64, duration_s: 20, warmup_s: 5, cooldown_s: 5, reps: 3, py_profile: 'py-Nw' };

function s(id: string, layer: Layer, title: string, description: string, over: Partial<RunConfig> = {}, extra: Partial<Scenario> = {}): Scenario {
  return {
    id,
    layer,
    title,
    description,
    generator: 'oha',
    platforms: ['compose', 'k8s'],
    requires_gemini: false,
    defaults: { ...base, ...over },
    ...extra,
  };
}

export const SCENARIOS: Scenario[] = [
  s('ping', 'L1', 'Ping', 'Bare HTTP round-trip: router + serialization of a tiny response. Isolates raw framework overhead. The 20-second smoke test.'),
  s('json', 'L1', 'JSON echo', 'Parses and re-encodes a ~2 KB JSON body. Isolates JSON codec and request-body handling.'),
  s('cpu', 'L1', 'CPU work', 'Pure CPU (fib n=25) per request. Isolates compute throughput and how each runtime uses cores (goroutines vs workers).', { concurrency: 16 }),
  s('sleep-io', 'L1', 'Sleep I/O', '100 ms non-blocking sleep at c=500. Isolates concurrency model and scheduler cost under many in-flight requests.', { concurrency: 500 }),
  s('rag-chunk', 'L1', 'RAG chunk', 'Deterministic chunking of a 200 KB document. Isolates text processing speed.', { concurrency: 16 }),
  s('rag-embed-mock', 'L1', 'RAG embed (mock)', 'Mock embedder vector generation. Isolates numeric/array handling without network.', { concurrency: 16 }),
  s('db-read', 'L2', 'DB read', 'Primary-key lookup on 100k bench_items via the pool. Isolates driver + pool overhead (pgx vs asyncpg).'),
  s('db-query', 'L2', 'DB query', 'Filtered aggregate query returning ~50 rows. Isolates row decoding and result mapping.', { concurrency: 32 }),
  s('db-write', 'L2', 'DB write', 'Single-row INSERT in a transaction. Isolates write path and pool contention.', { concurrency: 32 }),
  s('rag-search', 'L2', 'RAG search (hybrid)', 'Hybrid pgvector + FTS search with RRF, mock embedder. Isolates retrieval SQL + vector encoding.'),
  s('rag-ingest', 'L2', 'RAG ingest', 'Full ingestion of the default corpus ×10 (chunk, embed, COPY). Isolates bulk-load pipeline.', { concurrency: 1, reps: 5, duration_s: undefined, requests: 10 }, { generator: 'orchestrator' }),
  s('chat-mock', 'L3', 'Chat (mock LLM)', 'Full ADK agent loop with a mock model, new session per VU. Isolates framework + session-store overhead without Gemini.', { concurrency: 50, duration_s: 30, mode: 'mock' }, { generator: 'chat' }),
  s('chat-mock-tool', 'L3', 'Chat + tool (mock)', 'Mock model that calls get_inventory_stats (Postgres). Isolates tool dispatch + DB access inside the agent loop.', { concurrency: 50, duration_s: 30, mode: 'mock' }, { generator: 'chat' }),
  s('chat-mock-rag', 'L3', 'Chat + RAG (mock)', 'Mock model calling search_knowledge_base. Isolates retrieval inside the agent loop.', { concurrency: 50, duration_s: 30, mode: 'mock' }, { generator: 'chat' }),
  s('chat-mock-burst', 'L3', 'Chat burst ramp', 'Ramps 1 → 500 VUs over 60 s. Isolates behaviour under rising load and where each side saturates.', { concurrency: 500, duration_s: 60, mode: 'mock', params: { ramp: true } }, { generator: 'chat' }),
  s('chat-gemini', 'L4', 'Chat (Gemini)', 'Real Gemini calls, interleaved A/B. Shows that model latency dominates; compare overhead, not totals.', { concurrency: 5, duration_s: undefined, requests: 50, reps: 1, mode: 'gemini' }, { generator: 'chat', requires_gemini: true, limits: { max_concurrency: 5, max_requests: 50 } }),
  s('rag-ingest-gemini', 'L4', 'RAG ingest (Gemini)', 'Ingestion with gemini-embedding-2. Measures embedding batching and network handling.', { concurrency: 1, reps: 1, duration_s: undefined, requests: 1 }, { generator: 'orchestrator', requires_gemini: true, limits: { max_requests: 1 } }),
  s('cold-start', 'static', 'Cold start', 'Container restart → first healthy /healthz (k8s: pod delete → Ready). Isolates startup/import time.', { concurrency: 1, reps: 5, duration_s: undefined, requests: 1 }, { generator: 'orchestrator' }),
  s('scale-out', 'k8s', 'Scale-out (HPA)', 'Chat-mock ramp 1 → 400 VUs over 120 s with HPA 1–4 replicas. How many pods for the same RPS, and how fast.', { concurrency: 400, duration_s: 120, reps: 1, mode: 'mock', params: { hpa: { min: 1, max: 4, cpu: 70 } } }, { generator: 'orchestrator', platforms: ['k8s'] }),
  s('rollout-disruption', 'k8s', 'Rollout disruption', 'Rolling restart at t=15 s under constant c=50 load. Counts errors and the p99 spike: graceful-shutdown quality.', { concurrency: 50, duration_s: 60, reps: 1, mode: 'mock', params: { rollout_at_s: 15 } }, { generator: 'orchestrator', platforms: ['k8s'] }),
];
