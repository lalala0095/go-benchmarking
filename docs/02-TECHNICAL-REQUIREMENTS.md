# 02 — Technical Requirements Document (TRD)

This is the source of truth for **contracts** between containers. Subagents must not change a contract in this file without updating every implementer.

---

## 1. Architecture

```
                         ┌──────────────────────────────────────────────┐
  Browser (localhost)    │ dashboard  :3000                             │
  ───────────────────▶   │  ├─ React SPA (static)                       │
                         │  ├─ Node/Hono API  (/api/*)                  │
                         │  │   ├─ chat fan-out + SSE relay             │
                         │  │   ├─ benchmark orchestrator               │
                         │  │   ├─ load generators (undici + oha)       │
                         │  │   └─ docker stats reader (socket, ro)     │
                         └────────┬──────────────────────┬──────────────┘
                                  │ HTTP/SSE             │ HTTP/SSE
                   ┌──────────────▼─────────┐  ┌─────────▼──────────────┐
                   │ go-server :8081        │  │ fastapi-server :8082   │
                   │  ADK-Go v2 runner      │  │  ADK-Python runner     │
                   │  net/http + pgx        │  │  FastAPI/Uvicorn+asyncpg│
                   └──────────┬─────────────┘  └──────────┬─────────────┘
                              │        Gemini API (internet)          │
                              ▼                                       ▼
                   ┌──────────────────────────────────────────────────┐
                   │ postgres :5432   DBs: go_app | py_app | dashboard│
                   └──────────────────────────────────────────────────┘
```

**Kubernetes mode:** each box becomes a Deployment (Postgres a StatefulSet) in namespace `bench`, and the arrows go through ClusterIP Services with the same names. See [07](07-KUBERNETES.md).

**Why the dashboard backend is Node/TypeScript:** it's language-neutral, so neither Go nor Python "hosts" the measurement. It's also good at SSE fan-out.

## 2. Repository layout

```
go_benchmarking/
├── docker-compose.yml
├── .env.example                 # GOOGLE_API_KEY=, GEMINI_MODEL=gemini-flash-latest
├── Makefile                     # up, down, logs, reset-db, bench-smoke, fmt, test
├── README.md
├── docs/                        # these documents
├── docker-compose.bench.yml     # cpuset pinning overlay (Linux)
├── deploy/k8s/                  # k3s host files, Kustomize base + overlays, labs/ (see 07)
├── scripts/                     # ubuntu-setup.sh, ubuntu-tune.sh, cpu-layout.sh (see 08)
├── corpus/                      # RAG corpus (.md/.txt); corpus/private/ is git-ignored — see 09
├── contracts/
│   ├── openapi.yaml             # /v1/* and /bench/* contract (both servers)
│   ├── sse-events.md            # SSE event shapes
│   ├── agent-spec.md            # system instruction, tools, mock-LLM script (shared verbatim)
│   └── fixtures/                # bench payloads (json-10kb.json, prompts.json)
├── db/
│   └── init/
│       ├── 00-create-databases.sql
│       ├── 10-app-schema.sql        # run against go_app AND py_app
│       ├── 20-dashboard-schema.sql  # run against dashboard
│       └── 30-seed.sql              # deterministic bench data for both app DBs
├── go-server/
│   ├── Dockerfile
│   ├── go.mod
│   ├── cmd/server/main.go
│   └── internal/{agent,api,bench,config,db,metrics,mockllm}/
├── fastapi-server/
│   ├── Dockerfile
│   ├── pyproject.toml           # managed with uv
│   └── app/{main.py,agent/,api/,bench/,config.py,db.py,metrics.py,mockllm.py}
└── dashboard/
    ├── Dockerfile
    ├── package.json
    ├── server/                  # Hono API (TS)
    └── web/                     # Vite + React + TS + Tailwind + Recharts
```

## 3. Tech stack and pinned versions

Pin exact versions at implementation time and record them in `/v1/info`.

| Component | Choice | Notes |
|---|---|---|
| Go | match the `go` directive of the pinned ADK-Go tag (main currently requires **1.26.x**) | Go ≥ 1.25 reads cgroup CPU limits for `GOMAXPROCS` automatically. |
| ADK-Go | `google.golang.org/adk/v2`, pinned to the latest tag (v2.5.0 as of 2026-10-10) | Packages: `agent/llmagent`, `model/gemini`, `runner`, `session`, `session/database` (GORM), `tool/functiontool`. **Verify** the `session/database` import path on pkg.go.dev, because it moved between minors. |
| Go HTTP | stdlib `net/http` (Go 1.22+ routing) | No framework, which keeps it closest to "Go's default". |
| Go DB | `pgx/v5` with `pgxpool` for bench/tool queries; `gorm.io/driver/postgres` for ADK sessions | |
| Go metrics | `prometheus/client_golang` | |
| Python | 3.12 | |
| ADK-Python | `google-adk` 2.x (2.11.0 as of 2026-10-10) | `Runner`, `LlmAgent`, `DatabaseSessionService("postgresql+asyncpg://…")`, `google.adk.cli.fast_api.get_fast_api_app` |
| Python HTTP | FastAPI + Uvicorn (`uvloop`, `httptools`), `orjson` responses | |
| Python DB | `asyncpg` pool for bench/tool queries; SQLAlchemy async (via ADK) for sessions | |
| Python metrics | `prometheus-client` | Multiprocess mode when workers > 1. |
| Dashboard | Node 22, Hono, `undici`, `pg`, `dockerode`, `@kubernetes/client-node`; Vite + React 18 + Tailwind + Recharts | |
| Load gen (HTTP micro) | `oha` (Rust), bundled binary, `--output-format json` | Handles 50k+ RPS without becoming the bottleneck. |
| Load gen (chat/SSE) | Custom Node runner on `undici` | Measures TTFT and per-event timings. |
| DB | `pgvector/pgvector:pg17` (PostgreSQL 17 + pgvector) | Go: `pgvector-go`; Python: `pgvector` (asyncpg codec) |
| Host | Ubuntu 24.04 LTS desktop, Docker Engine + compose plugin (apt repo, not snap / Docker Desktop) | cgroup v2. See [08](08-UBUNTU-SETUP.md). |
| Kubernetes | k3s (stable channel, single node), Kustomize (built into kubectl + standalone for `edit set image`), k9s, local `registry:2`. Helm only for optional labs. | See [07](07-KUBERNETES.md). |

## 4. Container and runtime configuration

### 4.1 Resource limits (fairness, NFR-1)

```yaml
# docker-compose.yml (excerpt)
x-server-limits: &server-limits
  deploy:
    resources:
      limits: { cpus: "${SERVER_CPUS:-2}", memory: "${SERVER_MEM:-1g}" }

services:
  postgres:       { image: "pgvector/pgvector:pg17", cpus: 2, mem: 2g, ports: ["127.0.0.1:5432:5432"] }
  go-server:      { <<: *server-limits, ports: ["127.0.0.1:8081:8080"] }
  fastapi-server: { <<: *server-limits, ports: ["127.0.0.1:8082:8080"] }
  dashboard:      { cpus: 4, mem: 2g, ports: ["127.0.0.1:3000:3000"],
                    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"] }
```

- Both servers listen on **:8080 inside** the container. The host ports are 8081 (Go) and 8082 (Py).
- Every service has a `healthcheck`. Servers `depends_on: postgres: condition: service_healthy`.
- Host requirement: an Ubuntu 24.04 machine with 12+ threads (10 for containers plus about 2 for the desktop and browser). With fewer, lower `SERVER_CPUS` and `DASH_CPUS`. The UI shows the effective limits.
- **CPU pinning (`make up-bench`):** `docker-compose.bench.yml` adds `cpuset` so each container gets dedicated cores, leaving cores 0–1 to the desktop ([08 §5](08-UBUNTU-SETUP.md#5-cpu-pinning-linux-only-advantage)). Official Compose numbers use this profile.
- Each server sets `ulimits: nofile: 65535`.
- In k8s, the `bench` overlay sets the same CPU/memory as requests == limits (Guaranteed QoS).

### 4.2 Server tuning (equal "production defaults")

| Setting | Go | FastAPI |
|---|---|---|
| Parallelism | `GOMAXPROCS` = cgroup limit (automatic) | `uvicorn --workers ${PY_WORKERS}` (profile `py-1w` = 1, `py-Nw` = SERVER_CPUS) |
| Event loop | n/a | `uvloop`, `httptools` |
| JSON | `encoding/json` (v1, stdlib). Optional `json/v2` flag later. | `orjson` via `ORJSONResponse` |
| DB pool (bench + tools) | pgxpool max 10 | asyncpg pool max 10 **per worker**, divided so the total is 10 |
| Logging | off at request level (INFO startup only) | `--no-access-log` |
| Timeouts | read 30 s, write 0 (SSE), idle 120 s | `--timeout-keep-alive 120` |

### 4.3 Environment variables (both servers)

| Var | Default | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | — | Gemini key (required for gemini mode) |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model id |
| `DATABASE_URL` | `postgres://bench:bench@postgres:5432/go_app` / `…/py_app` | App DB |
| `DB_POOL_MAX` | `10` | Pool size |
| `MOCK_TOKENS` | `60` | Tokens emitted by mock LLM |
| `MOCK_TOKEN_DELAY_MS` | `15` | Delay between mock tokens |
| `MOCK_FIRST_TOKEN_DELAY_MS` | `250` | Simulated model TTFT |
| `PORT` | `8080` | |
| `CORPUS_DIR` | `/corpus` | RAG corpus mount ([09](09-RAG.md)) |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-2` | Embedding model (768 dimensions) |
| `EMBED_BATCH_SIZE` | `100` | Texts per embed request |
| `MOCK_EMBED_DELAY_MS` | `40` | Simulated latency per mock embed call |
| `SQL_DIR` | `/contracts/sql` | Shared SQL files (RAG search) |

## 5. Shared HTTP contract (both servers implement it identically)

Full schemas go in `contracts/openapi.yaml`. This section is normative.

### 5.1 Meta

| Method | Path | Response |
|---|---|---|
| GET | `/healthz` | `200 {"status":"ok","db":"ok"}`. Pings the DB pool. |
| GET | `/v1/info` | `{"impl":"go"\|"python","runtime":"go1.26.x"\|"cpython3.12.x","adk_version":"…","framework":"net/http"\|"fastapi x.y","workers":N,"gomaxprocs":N,"model":"…","started_at":"ISO8601"}` |
| GET | `/metrics` | Prometheus text (see §7) |

### 5.2 Sessions

| Method | Path | Body / Response |
|---|---|---|
| POST | `/v1/sessions` | `{"user_id":"u1"}` → `201 {"session_id":"…","user_id":"u1","created_at":"…"}` |
| GET | `/v1/sessions/{id}?user_id=u1` | `{"session_id","events":[{"role":"user"\|"model"\|"tool","text","ts"}]}` |
| DELETE | `/v1/sessions/{id}?user_id=u1` | `204` |

Sessions are stored by each ADK's **own session service** in its own DB (`go_app` / `py_app`).

### 5.3 Chat

`POST /v1/chat/stream`. Request:

```json
{ "user_id": "u1", "session_id": "…", "message": "text", "mode": "gemini" | "mock", "request_id": "uuid" }
```

The response is `text/event-stream`. Events (also in `contracts/sse-events.md`):

```
event: meta
data: {"request_id":"…","impl":"go","received_at_ns":<server monotonic>}

event: token
data: {"text":"partial text","seq":1}

event: tool_call
data: {"name":"get_inventory_stats","args":{…},"duration_ms":3.2}

event: done
data: {"request_id":"…","timings":{
   "server_total_ms": 812.4,     // request received → done written
   "model_ms": 790.1,            // sum of time spent awaiting the LLM (Gemini or mock)
   "tool_ms": 3.2,               // sum of tool execution
   "session_ms": 6.8,            // ADK session read/append to Postgres
   "overhead_ms": 12.3,          // server_total - model - tool - session  (pure framework/runtime cost)
   "first_token_ms": 251.0},
 "usage":{"input_tokens":…,"output_tokens":…}}

event: error
data: {"code":"UPSTREAM_429"|"INTERNAL"|…,"message":"…"}
```

`POST /v1/chat` is the non-streaming version. It returns `{"reply":"…","timings":{…},"usage":{…}}`. The dashboard uses it for simple throughput tests.

**Timing rule:** both implementations measure with a monotonic clock (`time.Now()`/`time.Since` in Go, `time.perf_counter_ns()` in Python). `model_ms` covers only the interval spent awaiting chunks from the model. Each server wraps its model in a timing decorator (see §5.5).

Every response sets the header `Server-Timing: total;dur=…, model;dur=…, db;dur=…`.

### 5.4 Bench endpoints (L1/L2)

| Method | Path | Behaviour (must be identical) |
|---|---|---|
| GET | `/bench/ping` | `200 {"ok":true}` |
| POST | `/bench/json` | Parse the body (`contracts/fixtures/json-10kb.json`), compute `item_count` and `sum(price)`, then return `{item_count,total,echo:<body.items[0:10]>}` |
| GET | `/bench/cpu?n=25` | Compute iterative SHA-256 chained `n*1000` times over a fixed seed and return the hex. This is deliberately CPU-bound. |
| GET | `/bench/db/read?id=` | `SELECT … FROM bench_items WHERE id=$1` → row JSON. If `id` is missing, use a random id in the range 1..100000. |
| GET | `/bench/db/query` | Aggregate: `SELECT category, count(*), avg(price) FROM bench_items GROUP BY category` |
| POST | `/bench/db/write` | `INSERT INTO bench_writes(payload) VALUES ($1) RETURNING id` |
| GET | `/bench/sleep?ms=100` | Async sleep, then 200. This tests concurrency handling of I/O-bound waits (a proxy for awaiting an LLM). |

### 5.5 Agent spec (`contracts/agent-spec.md`, shared verbatim)

- **Name:** `bench_agent`
- **Instruction:** a fixed system prompt (stored in the contract file and loaded by both servers from a mounted copy).
- **Model:** `gemini-3.5-flash-lite`. **Generation config:** `max_output_tokens: 512` only. Don't set `temperature`/`top_p`/`top_k`, because Gemini 3.x deprecates the sampling params.
- **Tools (function tools, same names, args, and semantics):**
  1. `get_inventory_stats(category: string)` runs a Postgres aggregate over `bench_items` for that category and returns `{count, avg_price, min_price, max_price}`.
  2. `get_current_time(timezone: string)` returns an ISO time string.
  3. `search_knowledge_base(query: string, top_k: integer = 5)` does hybrid RAG retrieval (pgvector kNN + full-text, RRF) ([09 §6–7](09-RAG.md)).
  - **RAG endpoints** (`/v1/rag/ingest`, `/v1/rag/chunk`, `/v1/rag/embed`, `/v1/rag/search`, `/v1/rag/stats`, `DELETE /v1/rag/documents`) are part of the shared contract. See [09](09-RAG.md).
- **Mock LLM** (`mode: "mock"`): a custom model implementation (Go: implements the ADK-Go `model.LLM` interface; Python: subclasses `google.adk.models.BaseLlm`), registered so the ADK runner drives it exactly like Gemini. Script:
  - If the user message contains `docs` or `knowledge`, first call `search_knowledge_base` ([09 §6](09-RAG.md)).
  - If the user message contains `"inventory"`, first return a function call `get_inventory_stats({"category":"electronics"})`. After the tool response, stream the text answer.
  - Otherwise, wait `MOCK_FIRST_TOKEN_DELAY_MS`, then emit `MOCK_TOKENS` chunks of a fixed lorem string with `MOCK_TOKEN_DELAY_MS` between them.
  - The mock must use non-blocking sleeps (`time.Sleep` in a goroutine-friendly path for Go, `await asyncio.sleep` for Python).

### 5.6 Python: ADK built-in FastAPI app

The FastAPI server is created with `get_fast_api_app(agents_dir=…, session_service_uri=DATABASE_URL_ASYNC, web=False)`. The custom `/v1/*` and `/bench/*` routers are included on that same app. ADK's native endpoints (`/run`, `/run_sse`, `/apps/{app}/users/{user}/sessions/...`) therefore stay available for a secondary **"native ADK API"** comparison. The Go server can likewise mount ADK-Go's REST handler under `/adk/*`. That's optional, Phase 6.

## 6. Benchmark scenarios

| ID | Layer | Target endpoint | Default load | Generator |
|---|---|---|---|---|
| `ping` | L1 | GET /bench/ping | c=64, 20 s | oha |
| `json` | L1 | POST /bench/json | c=64, 20 s | oha |
| `cpu` | L1 | GET /bench/cpu?n=25 | c=16, 20 s | oha |
| `sleep-io` | L1 | GET /bench/sleep?ms=100 | c=500, 20 s | oha |
| `db-read` | L2 | GET /bench/db/read | c=64, 20 s | oha |
| `db-query` | L2 | GET /bench/db/query | c=32, 20 s | oha |
| `db-write` | L2 | POST /bench/db/write | c=32, 20 s | oha |
| `chat-mock` | L3 | POST /v1/chat/stream mode=mock | c=50, 30 s, new session per VU | Node runner |
| `chat-mock-tool` | L3 | same, message contains "inventory" | c=50, 30 s | Node runner |
| `chat-mock-burst` | L3 | ramp 1 → 500 VUs over 60 s | — | Node runner |
| `rag-chunk` | L1 | POST /v1/rag/chunk (200 KB doc) | c=16, 20 s | oha |
| `rag-embed-mock` | L1 | POST /v1/rag/embed (mock) | c=16, 20 s | oha |
| `rag-search` | L2 | GET /v1/rag/search?preset=random&mode=hybrid&embedder=mock (+ `-vector`, `-fts`) | c=64, 20 s | oha |
| `rag-ingest` | L2 | POST /v1/rag/ingest repeat=10 | 5 reps sequential | orchestrator |
| `chat-mock-rag` | L3 | chat stream mode=mock, "docs" message | c=50, 30 s | Node runner |
| `rag-ingest-gemini` | L4 | ingest with gemini embedder | 1 rep, confirm | orchestrator |
| `chat-gemini` | L4 | mode=gemini, interleaved A/B | c≤5, max 50 req | Node runner |
| `cold-start` | static | `platform.restart()` then poll `/healthz` (k8s: pod delete → Ready) | 5 reps | orchestrator |
| `scale-out` | k8s | chat-mock ramp 1 → 400 VUs over 120 s with HPA (1–4 replicas, CPU 70%) | — | Node runner + platform |
| `rollout-disruption` | k8s | chat-mock c=50 constant, `platform.rollout()` at t=15 s, run 60 s | — | Node runner + platform |

Run protocol (orchestrator):
1. Health-check both targets, and snapshot `/v1/info`, container limits, and the **platform**. Refuse to start if the other stack is active.
2. **Warm-up:** 5 s at the same concurrency (results discarded).
3. Run target A, cool down 5 s, run target B. Alternate A/B order on each repetition.
4. Default repetitions = 3. Report the median of the reps and keep all raw data.
5. Sample `docker stats` every 1 s and scrape `/metrics` every 2 s during each run.
6. Mark the run **suspect** if dashboard CPU exceeds 85%, the error rate exceeds 1%, or rep variance exceeds 10%.

## 7. Metrics

**Client-side (dashboard, authoritative for latency):** latency per request, TTFT per chat stream, status codes, bytes, RPS per second.

**Server-side `/metrics` (same names in both):**

```
bench_http_requests_total{route,status}
bench_http_request_duration_seconds_bucket{route}
bench_chat_overhead_seconds_bucket{mode}
bench_chat_model_seconds_bucket{mode}
bench_db_pool_in_use / bench_db_pool_max
bench_runtime_threads           # Go: goroutines; Python: threads + asyncio tasks
process_resident_memory_bytes   # standard
process_cpu_seconds_total       # standard
bench_cgroup_cpu_usage_seconds_total      # /sys/fs/cgroup/cpu.stat usage_usec (whole container, all workers)
bench_cgroup_cpu_throttled_seconds_total  # cpu.stat throttled_usec (CPU-limit throttling)
bench_cgroup_memory_bytes                 # /sys/fs/cgroup/memory.current
```

**Container-level:** the primary source is the `bench_cgroup_*` metrics each server exports from its own cgroup v2 files. This works identically in Compose and Kubernetes, at 1 s resolution, and covers all Python workers. Secondary sources: in Compose, `docker stats` (also used for Postgres and the dashboard); in k8s, metrics-server (about 15 s resolution) for Postgres and the dashboard.

**Derived:** RPS/core = RPS ÷ cpu_limit. RPS/100 MB = RPS ÷ (avg_mem_MB / 100). Overhead p50/p99.

## 8. Dashboard backend API (`/api/*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/platform` | `{mode:"compose"\|"k8s", limits, qos_class?, node?}` |
| GET | `/api/targets` | Health and `/v1/info` for both servers |
| POST | `/api/chat` | `{message, mode, targets:["go","python"], conversation_id}` → SSE multiplexed stream: events tagged `{target:"go"\|"python", ...original event}` |
| GET | `/api/conversations` / `/api/conversations/:id` | Saved side-by-side conversations |
| GET | `/api/live` | SSE stream every 1 s: docker stats and scraped metrics per target |
| GET/POST | `/api/kb/stats`, `/api/kb/ingest`, `/api/kb/upload`, `/api/kb/search` | Knowledge-base panel. Fans out to both servers and returns side-by-side results. |
| GET | `/api/scenarios` | Scenario catalogue with defaults |
| POST | `/api/runs` | Start a benchmark run → `{run_id}` (only one run at a time, returns 409 if busy) |
| GET | `/api/runs/:id/stream` | SSE live progress |
| POST | `/api/runs/:id/cancel` | Cancel |
| GET | `/api/runs` / `/api/runs/:id` | History / detail |
| GET | `/api/compare?a=&b=` | Comparison payload |
| GET | `/api/runs/:id/export?format=json\|csv\|md` | Export |

The chat relay must time each target on the dashboard side as well (`client_ttft_ms`, `client_total_ms`). Network hop overhead is then visible too.

### 8.1 Platform adapter

Scenario code never calls Docker or Kubernetes directly. It uses one interface, selected by `PLATFORM=compose|k8s`:

```ts
interface Platform {
  mode: 'compose' | 'k8s';
  info(): Promise<PlatformInfo>;                       // limits, image digests, QoS, node
  containerStats(t: Target | 'postgres' | 'dashboard'): Promise<Stats>;
  restart(t: Target): Promise<{ readyMs: number }>;   // compose: docker restart; k8s: delete pod, watch Ready
  scale?(t: Target, replicas: number): Promise<void>; // k8s only
  setHpa?(t: Target, cfg: HpaConfig | null): Promise<void>; // k8s only
  rollout?(t: Target): Promise<RolloutResult>;        // k8s only: restart annotation, watch rollout
  isOtherStackActive(): Promise<boolean>;             // preflight guard
}
```

## 9. Security and ops

- Compose ports bind to `127.0.0.1`. Docker-published ports bypass `ufw`, so this binding matters. The Gemini key comes only from `.env` (git-ignored, `chmod 600`). In k8s it's a Secret created from `.env` and never committed.
- Compose: the Docker socket is mounted into the dashboard. `:ro` does **not** restrict Docker API calls. The real guard is the code allowlist: only `stats`, `inspect`, and `restart`, and restart only on the two server containers.
- k8s: the dashboard uses its own ServiceAccount with a namespace-scoped Role ([07 §4.1](07-KUBERNETES.md#41-key-manifest-rules-for-the-implementing-agent)). Nothing cluster-wide. servicelb is disabled, and access is through `kubectl port-forward`.
- `make reset-db` drops and recreates volumes.

## 10. Testing requirements

- **Contract tests** (`contracts/tests/`, run from the dashboard container with Vitest): one suite runs against both `http://go-server:8080` and `http://fastapi-server:8080` and asserts identical response shapes, SSE event order, and timing fields. **This is the main parity gate.**
- Go: `go test ./...` (handlers, mock LLM, timing decorator). Python: `pytest` (same).
- Dashboard: unit tests for stats math (percentiles, derived metrics) and a smoke e2e that runs `ping` for 3 s.
