// Shared types for the dashboard HTTP API (/api/*). Source of truth between
// dashboard/server (implements) and dashboard/web (consumes). Change only via
// main Claude. Upstream server shapes are in contracts/openapi.yaml.

export type Target = 'go' | 'python';
export const TARGETS: Target[] = ['go', 'python'];
export type ChatMode = 'gemini' | 'mock';
export type PlatformMode = 'compose' | 'k8s';
export type Layer = 'L1' | 'L2' | 'L3' | 'L4' | 'static' | 'k8s';
export type PerTarget<T> = { go?: T; python?: T };
export type Fallible<T> = T | { error: string };

// ── Upstream server shapes (mirrors contracts/openapi.yaml) ──────────────
export interface ServerInfo {
  impl: Target;
  runtime: string;
  adk_version: string;
  framework: string;
  workers: number;
  gomaxprocs?: number | null;
  model: string;
  embed_model: string;
  gemini_configured?: boolean;
  db_pool_max?: number;
  cgroup_cpu_limit?: number | null;
  cgroup_memory_limit_bytes?: number | null;
  started_at: string;
}
export interface Timings {
  server_total_ms: number;
  first_token_ms: number;
  model_ms: number;
  tool_ms: number;
  session_ms: number;
  overhead_ms: number;
}
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  duration_ms: number;
  result_summary?: Record<string, unknown>;
  embed_ms?: number;
  db_ms?: number;
}
export interface Usage { input_tokens: number; output_tokens: number }
export interface RagStats {
  documents: number;
  chunks: number;
  chars: number;
  gemini_embedded_chunks: number;
  last_ingested_at?: string | null;
}
export interface IngestResponse {
  documents: number;
  skipped: number;
  chunks: number;
  chars: number;
  embedders: string[];
  timings: { read_ms: number; chunk_ms: number; embed_ms: number; embed_gemini_ms?: number; embed_mock_ms?: number; db_ms: number; total_ms: number };
}
export interface SearchResult { source: string; title: string; heading: string; content: string; score: number }
export interface SearchResponse {
  query: string;
  mode: string;
  embedder: string;
  results: SearchResult[];
  timings: { embed_ms?: number; db_ms?: number; total_ms?: number };
}

// ── Platform / targets ───────────────────────────────────────────────────
export interface ResourceLimits { cpus: number | null; memory_bytes: number | null; cpuset?: string | null }
export interface PodInfo { name: string; target: Target | 'postgres' | 'dashboard'; phase: string; ready: boolean; restarts: number; qos_class?: string; node?: string; reason?: string }
export interface PlatformInfo {
  mode: PlatformMode;
  host: { arch?: string; kernel?: string; os?: string; ncpu?: number; mem_bytes?: number };
  limits: { go?: ResourceLimits; python?: ResourceLimits; postgres?: ResourceLimits; dashboard?: ResourceLimits };
  images?: PerTarget<{ ref: string; digest?: string; size_bytes?: number }>;
  k8s?: { node?: string; k3s_version?: string; overlay?: string; pods: PodInfo[]; hpa?: PerTarget<{ min: number; max: number; current: number; desired: number }> };
}
export interface TargetStatus { healthy: boolean; url: string; info?: ServerInfo; rag?: RagStats; error?: string }
// GET /api/targets
export type TargetsResponse = Record<Target, TargetStatus>;

// ── Chat ─────────────────────────────────────────────────────────────────
export interface Conversation {
  id: string;
  title: string | null;
  mode: ChatMode;
  go_session_id: string | null;
  py_session_id: string | null;
  created_at: string;
}
export interface ChatTurn {
  turn_index: number;
  target: Target;
  request_id: string;
  user_message: string;
  reply_text: string | null;
  tool_calls: ToolCall[];
  status: 'ok' | 'error';
  error_code?: string | null;
  timings?: Timings | null;
  client_ttft_ms?: number | null;
  client_total_ms?: number | null;
  usage?: Usage | null;
  created_at: string;
}
// POST /api/conversations  body: CreateConversationRequest → Conversation
export interface CreateConversationRequest { mode: ChatMode; title?: string }
// GET /api/conversations → Conversation[] (newest first, limit 50)
// GET /api/conversations/:id → ConversationDetail
export interface ConversationDetail { conversation: Conversation; turns: ChatTurn[] }

// POST /api/chat  body: ChatRequest → text/event-stream of ChatStreamEvent.
// SSE `event:` = ChatStreamEvent.type, `data:` = JSON of the whole object.
export interface ChatRequest { conversation_id: string; message: string; mode: ChatMode; targets: Target[] }
export type ChatStreamEvent =
  | { type: 'meta'; target: Target; request_id: string; session_id: string; model: string; client_ms: number }
  | { type: 'token'; target: Target; text: string; seq: number; client_ms: number }
  | { type: 'tool_call'; target: Target; tool: ToolCall; client_ms: number }
  | { type: 'done'; target: Target; reply: string; timings: Timings; usage: Usage; client_ttft_ms: number | null; client_total_ms: number }
  | { type: 'error'; target: Target; code: string; message: string; client_ms: number }
  | { type: 'turn_complete'; turn_index: number; turns: ChatTurn[] };
// client_ms = ms since the dashboard received the /api/chat request.

// ── Live monitor ─────────────────────────────────────────────────────────
// GET /api/live → text/event-stream, `event: sample`, data: LiveSample, 1 Hz.
export interface ContainerStats { cpu_pct: number | null; mem_mb: number | null; mem_limit_mb: number | null; net_rx_bytes?: number | null; net_tx_bytes?: number | null }
export interface LiveTarget extends ContainerStats {
  healthy: boolean;
  threads: number | null;          // goroutines (Go) / threads+tasks (Python)
  rps: number | null;              // from bench_http_requests_total deltas
  err_rate: number | null;         // 0..1
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  throttled_pct: number | null;    // from bench_cgroup_cpu_throttled_seconds_total
  db_pool_in_use: number | null;
  replicas?: number | null;        // k8s
}
export interface LiveSample {
  ts: string;
  platform: PlatformMode;
  targets: Record<Target, LiveTarget>;
  postgres?: ContainerStats | null;
  dashboard?: ContainerStats | null;
  active_run_id?: string | null;
}

// ── Knowledge base (fan-out to both servers) ─────────────────────────────
// GET  /api/kb/stats → PerTarget<Fallible<RagStats>>
// POST /api/kb/ingest  body: KbIngestRequest → PerTarget<Fallible<IngestResponse>>
// POST /api/kb/upload  multipart/form-data, field "files" (.md/.txt, ≤ 2 MB each) → PerTarget<Fallible<IngestResponse>>
// GET  /api/kb/search?q=&k=5&mode=hybrid|vector|fts&embedder=mock|gemini → PerTarget<Fallible<SearchResponse>>
// DELETE /api/kb → PerTarget<Fallible<{ ok: true }>>
export interface KbIngestRequest { force?: boolean; embedders?: ('gemini' | 'mock')[] }

// ── Benchmarks ───────────────────────────────────────────────────────────
export interface RunConfig {
  targets: Target[];
  concurrency: number;
  duration_s?: number;             // time-based scenarios
  requests?: number;               // count-based scenarios (L4 caps)
  warmup_s: number;
  cooldown_s: number;
  reps: number;
  mode?: ChatMode;                 // chat scenarios
  py_profile?: 'py-1w' | 'py-Nw';  // informational; recorded with the run
  params?: Record<string, unknown>; // scenario-specific (e.g. ramp, hpa)
}
export interface Scenario {
  id: string;                      // e.g. 'ping', 'rag-search', 'chat-mock', 'scale-out'
  layer: Layer;
  title: string;
  description: string;             // what it isolates (1–2 sentences)
  generator: 'oha' | 'chat' | 'orchestrator';
  platforms: PlatformMode[];       // k8s-only scenarios: ['k8s']
  requires_gemini: boolean;        // shows confirm dialog, enforces caps
  defaults: RunConfig;
  limits?: { max_concurrency?: number; max_requests?: number };
}
// GET /api/scenarios → Scenario[]
// POST /api/runs body: StartRunRequest → 201 { run_id } | 409 { error, active_run_id } | 400 { error }
export interface StartRunRequest { scenario: string; config?: Partial<RunConfig>; confirm_gemini?: boolean; quiet_mode_ack?: boolean; notes?: string }

export type RunStatus = 'queued' | 'preflight' | 'running' | 'analyzing' | 'complete' | 'failed' | 'cancelled';
export type RunPhase = 'preflight' | 'warmup' | 'run' | 'cooldown' | 'analyze';
// GET /api/runs/:id/stream → SSE of RunStreamEvent (`event:` = type). On connect the
// server first sends a `phase` event with the current state (or `complete`/`failed` if finished).
export type RunStreamEvent =
  | { type: 'phase'; status: RunStatus; phase: RunPhase; rep: number; reps: number; target: Target | null; started_at: string }
  | { type: 'progress'; target: Target; rep: number; t_offset_s: number; rps: number | null; p50_ms: number | null; p99_ms: number | null; errors: number; cpu_pct: number | null; mem_mb: number | null; replicas?: number | null }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'complete'; run: RunDetail }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };
// POST /api/runs/:id/cancel → 202

export interface RunSummary {
  id: string;
  scenario: string;
  layer: Layer;
  platform: PlatformMode;
  status: RunStatus;
  suspect: boolean;
  suspect_reasons: string[];
  config: RunConfig;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  headline?: PerTarget<{ rps: number | null; p99_ms: number | null; mem_mb: number | null; overhead_p50_ms?: number | null }>;
}
export interface RunResult {
  target: Target;
  rep: number;
  order_in_rep: number;
  requests_total: number;
  errors_total: number;
  status_counts: Record<string, number>;
  duration_s: number;
  rps: number;
  lat_p50_ms: number | null; lat_p90_ms: number | null; lat_p95_ms: number | null; lat_p99_ms: number | null;
  lat_max_ms: number | null; lat_mean_ms: number | null;
  ttft_p50_ms: number | null; ttft_p99_ms: number | null;
  overhead_p50_ms: number | null; overhead_p99_ms: number | null;
  cpu_avg_pct: number | null; cpu_max_pct: number | null; cpu_throttled_pct: number | null;
  mem_avg_mb: number | null; mem_max_mb: number | null;
  rps_per_core: number | null; rps_per_100mb: number | null;
  max_replicas: number | null; rollout_errors: number | null;
  latency_histogram: { le_ms: number; count: number }[] | null;
}
export interface RunSample {
  target: Target; rep: number; t_offset_s: number;
  rps: number | null; lat_p50_ms: number | null; lat_p99_ms: number | null; errors: number | null;
  cpu_pct: number | null; mem_mb: number | null; threads: number | null; db_pool_in_use: number | null; replicas: number | null;
}
export interface SummaryRow {          // median across reps (view run_summary + extras)
  rps: number | null; p50_ms: number | null; p99_ms: number | null; mem_mb: number | null; cpu_pct: number | null;
  overhead_p50_ms: number | null; ttft_p50_ms: number | null; rps_per_core: number | null; rps_per_100mb: number | null;
  error_pct: number | null; rps_cv_pct: number | null;
}
export interface Delta { metric: keyof SummaryRow; go: number | null; python: number | null; ratio: number | null; better: Target | null; better_when: 'lower' | 'higher' }
export interface RunDetail {
  run: RunSummary & { environment?: Record<string, unknown> | null; error?: string | null; notes?: string | null };
  results: RunResult[];
  samples: RunSample[];
  summary: PerTarget<SummaryRow>;
  deltas: Delta[];                     // go vs python for this run
}
// GET /api/runs?scenario=&platform=&status=&limit=100 → RunSummary[]
// GET /api/runs/:id → RunDetail
// GET /api/compare?a=<run_id>&b=<run_id> → { a: RunDetail; b: RunDetail }
// GET /api/runs/:id/export?format=json|csv|md → file download
// DELETE /api/runs/:id → 204

// ── Static characteristics, DX notes, report ─────────────────────────────
export interface StaticMeasurement { target: Target; metric: string; platform: PlatformMode; value: number; measured_at: string }
// GET /api/static → StaticMeasurement[] (latest per target+metric+platform)
// POST /api/static/measure → 202 (measures image size, idle mem; cold start is a scenario)
// GET /api/dx-notes → Record<Target, { markdown: string; updated_at: string }>
// PUT /api/dx-notes/:target body { markdown } → 204
// POST /api/report → text/markdown (Decision Report; also saved to REPORTS_DIR)

// ── Misc ─────────────────────────────────────────────────────────────────
// GET /api/health → { ok: true }
// GET /api/platform → PlatformInfo
