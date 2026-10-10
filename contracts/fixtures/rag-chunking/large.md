# 01 — Product Requirements Document (PRD)

**Project:** Go vs FastAPI ADK Benchmark ("go_benchmarking")
**Owner:** project maintainer
**Status:** v3 — 2026-10-10 (Ubuntu 24.04 deployment server, Kubernetes track, hybrid RAG with Gemini embeddings + pgvector, Gemini 3.5 Flash-Lite)
**Related docs:** [02 Technical Requirements](02-TECHNICAL-REQUIREMENTS.md) · [03 App Flow](03-APP-FLOW.md) · [04 Design Brief](04-DESIGN-BRIEF.md) · [05 Database Schema](05-DATABASE-SCHEMA.md) · [06 Implementation Plan](06-IMPLEMENTATION-PLAN.md) · [07 Kubernetes](07-KUBERNETES.md) · [08 Ubuntu Setup](08-UBUNTU-SETUP.md) · [09 RAG](09-RAG.md)

---

## 1. Problem

Future projects will be AI-agent backends built on Google's Agent Development Kit (ADK) talking to Gemini. ADK exists for both **Python** (with a built-in FastAPI server) and **Go**. We don't know:

- How much faster or cheaper Go actually is for this kind of workload.
- Where the gains show up: latency, throughput, memory, cold start, or nowhere that matters.
- Whether a hybrid makes sense, such as a Go edge/API layer with Python agents or the other way round.

Opinions and generic web-framework benchmarks don't answer this. We need numbers from **our own workload shape**: agent chat, tool calls, Postgres-backed sessions, and streaming.

## 2. Goal

Build a local, Docker-based test bench that runs a **Go ADK server** and a **FastAPI ADK server** side by side, under identical conditions, against the same PostgreSQL instance. A **dashboard** lets us:

1. Chat with Gemini through both servers at once and watch them respond side by side.
2. See live performance and resource usage for each server.
3. Run repeatable load benchmarks and compare the results over time.

The output is a **decision**: Go, FastAPI, or both, for which kinds of future project, backed by data.

**Secondary goal: learn Kubernetes.** The same stack is also deployed to a single-node **k3s** cluster on the Ubuntu machine, built step by step through hands-on labs ([07](07-KUBERNETES.md)). This also answers a practical question: does Go's advantage change once both run as pods (density, scale-out, rollout behaviour)?

## 3. Non-goals

- Production hardening, auth, multi-tenancy, or public exposure. Everything runs on one Ubuntu 24.04 desktop machine and is used through `localhost`.
- Multi-node Kubernetes. The cluster is single-node k3s; kubeadm and multi-node are optional labs only.
- Benchmarking Gemini itself. Model latency is treated as an external constant, and we isolate it out (see §6).
- Comparing every Python server stack (Litestar, Django, and so on). FastAPI on Uvicorn is the Python candidate.
- A polished end-user chat product. The chat exists to drive and observe the servers.

## 4. Users

| User | Need |
|---|---|
| **Primary: you (tech lead / decision-maker)** | Clear side-by-side evidence to choose a stack for future projects. |
| **Secondary: Claude subagents (builders)** | Unambiguous contracts and acceptance criteria to implement each container independently. |
| **Tertiary: teammates / stakeholders** | An exportable report that explains the recommendation. |

## 5. System overview (4 containers)

| # | Container | Purpose |
|---|---|---|
| 1 | `dashboard` | Web UI with side-by-side chat, live metrics, and the benchmark runner and history. It also runs the load generator and stores benchmark results. |
| 2 | `go-server` | ADK-Go agent behind an HTTP API that implements the shared contract. |
| 3 | `fastapi-server` | ADK-Python agent behind FastAPI that implements the **same** contract. ADK's built-in FastAPI app is mounted as well. |
| 4 | `postgres` | One PostgreSQL 17 instance with separate databases for each server and for the dashboard. |

**Host and deployment modes:** everything runs on **Ubuntu 24.04 LTS (desktop)** with Docker Engine. The same four images run in two modes:
- **Docker Compose:** the fast dev loop and the baseline numbers.
- **Kubernetes (k3s):** for learning, plus scale-out and rollout scenarios.

Only one mode runs at a time.

## 6. Key product insight: measure the right thing

A Gemini call takes roughly 300 ms to several seconds. Framework overhead is usually **under a few ms**. A naive "chat speed" comparison would show mostly noise. So the bench measures four layers:

| Layer | What it isolates | How |
|---|---|---|
| **L1: Raw runtime** | HTTP, JSON, and CPU throughput of Go vs Python | `/bench/*` endpoints, no LLM |
| **L2: DB path** | Driver, pool, and async efficiency against Postgres | `/bench/db/*` endpoints |
| **L3: Agent overhead** | ADK runner, session persistence, event streaming, and tool dispatch, **without** network LLM variance | Chat with a **mock LLM** (deterministic fake model, same token stream and delays in both) |
| **L4: Real end-to-end** | What a user actually feels | Chat with real Gemini, low concurrency, interleaved A/B requests |

Every chat response reports **server overhead = total server time − upstream model time**. That is the number that differs between Go and Python.

## 7. Functional requirements

### 7.1 Side-by-side chat (P0)
- FR-1: A single input box sends the same message to both servers at the same moment.
- FR-2: The responses stream token by token (SSE) into two panes, Go on the left and FastAPI on the right.
- FR-3: Each message shows TTFT (time to first token), total time, model time, server overhead, token count, and tool calls made.
- FR-4: There's a toggle between **Gemini** and **Mock LLM** modes.
- FR-5: Conversation sessions persist in Postgres through each ADK's session service, so a page reload restores history.
- FR-6: The agent has at least two tools, identical in both servers. One of them queries Postgres, so tool-calling and DB access inside the agent loop get exercised.
- FR-7: You can target one server only, or both (the default).
- FR-7a: **RAG:** both agents answer knowledge questions through a `search_knowledge_base` tool backed by a shared-spec ingestion and retrieval pipeline in PostgreSQL: `gemini-embedding-2` vectors in pgvector, hybrid with full-text search through RRF. Both servers implement ingestion (deterministic chunking, embedding, COPY) and retrieval with identical shared SQL ([09](09-RAG.md)).
- FR-7b: The dashboard has a Knowledge-base panel: ingest the default corpus, upload files, and run a test search side by side.

### 7.2 Live monitoring (P0)
- FR-8: Live CPU %, memory (RSS), network I/O, and process/thread or goroutine counts for each server, refreshed every 1 s.
- FR-9: Live request rate, error rate, and p50/p95/p99 latency per server, from each server's `/metrics`.
- FR-10: A health indicator for each container, including Postgres.

### 7.3 Benchmark runner (P0)
- FR-11: Choose a scenario (see [02 §6](02-TECHNICAL-REQUIREMENTS.md#6-benchmark-scenarios)), target(s), concurrency, duration or request count, and warm-up.
- FR-12: Targets run **sequentially**, never at the same time, so they don't compete for host CPU. Order alternates between runs (Go→Py, then Py→Go).
- FR-13: Live progress: current RPS, latency, and errors.
- FR-14: Results include RPS, latency percentiles (p50/p90/p95/p99/max), error %, CPU and memory peak and average, and **RPS per CPU core** and **RPS per 100 MB**.
- FR-15: All runs persist to Postgres, including the environment snapshot (git SHA, versions, limits).

### 7.4 History and comparison (P1)
- FR-16: List all past runs with filters by scenario and date.
- FR-17: Pick any two runs, or a Go/Py pair, and compare them with charts and deltas (for example, "Go +312% RPS, −71% p99, −84% memory").
- FR-18: Export a run or comparison as JSON, CSV, and a Markdown report.

### 7.5 Static characteristics (P1)
- FR-19: Show image size, cold-start time (container start → first healthy response), idle memory, and dependency count for each server.
- FR-20: A manual "developer-experience notes" field per server (LOC, build time, pain points). This feeds the final decision.

### 7.6 Kubernetes (P1)
- FR-21: `make mode-k8s` deploys the whole stack to k3s with Kustomize overlays (`dev`, `bench`, `scale`), and the dashboard works there the same as in Compose.
- FR-22: Every run records its **platform** (`compose` / `k8s`). The same scenario can be compared across platforms.
- FR-23: A `scale-out` scenario: HPA-driven, it measures pods needed for a target RPS, time to scale, and pod time-to-Ready.
- FR-24: A `rollout-disruption` scenario: a rolling restart under constant load, measuring errors and the p99 spike.
- FR-25: The dashboard talks to Docker or Kubernetes only through a **platform adapter**, so scenario code is platform-agnostic.
- FR-26: Lab notes (K0–K9) live in the repo next to the manifests they teach.

## 8. Non-functional requirements

- NFR-1 **Fairness:** identical CPU/memory limits, Postgres pool sizes, model, prompts, temperature, and tool definitions for both servers. Any deviation is shown in the UI.
- NFR-2 **Reproducibility:** `docker compose up` plus one `.env` file (only `GOOGLE_API_KEY` required) brings everything up. Runs record full config.
- NFR-3 **Measurement accuracy:** the load generator's own overhead must not bottleneck the test. The dashboard must flag a run as *suspect* if the dashboard container's CPU exceeds 85%.
- NFR-4 **Cost safety:** Gemini-mode load tests are capped (default max 50 requests per run, concurrency ≤ 5) and need an explicit confirmation. Mock mode is the default for load tests.
- NFR-5 **Target host:** Ubuntu 24.04 LTS desktop (x86_64 primary, arm64 supported) with Docker Engine (not Docker Desktop) and k3s. Official numbers come only from this host, run in "quiet mode" ([08 §3](08-UBUNTU-SETUP.md#3-benchmark-quiet-mode-scriptsubuntu-tunesh)). A Mac is fine for development.
- NFR-6 **Local only:** Compose ports bind to `127.0.0.1`. In k3s, servicelb is disabled and access goes through `kubectl port-forward`, so nothing is exposed to the LAN.

## 9. Success metrics (for the project itself)

- All four containers start healthy with one command in under 2 minutes on a cold build cache.
- The same prompt produces a visible side-by-side streamed response with full timing breakdown.
- Repeated runs of each scenario (3 repetitions) agree within ±10% RPS variance.
- `make mode-k8s` brings the same stack up Ready on k3s, and labs K0–K9 are completed.
- A final **Decision Report** is produced (see §10).

## 10. Deliverable: Decision Report

At the end, the dashboard exports a report answering:

1. How much faster or leaner is Go at each layer (L1–L4), with numbers?
2. Does the difference matter at our expected scale? (For example, "At 50 concurrent chat users, both are bound by Gemini; Go saves X MB RAM and Y% CPU.")
3. **Recommendation matrix:**

| Project type | Recommendation |
|---|---|
| Thin agent API, LLM-bound, small team | _filled from data_ |
| High-concurrency gateway / streaming fan-out | _filled from data_ |
| Data/ML-heavy agents needing the Python ecosystem | _filled from data_ |
| Hybrid: Go gateway + Python agent workers | _filled from data_ |

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| ADK-Go and ADK-Python feature parity differs (APIs, session schemas, streaming semantics). | Use a **custom shared contract** (`/v1/*`) that both implement on top of their ADK runner, and document any parity gaps in the UI. |
| ADK-Go is younger and its APIs move. The `session/database` package location has shifted between v2 minors. | Pin exact versions in `go.mod` and verify against pkg.go.dev at implementation time. |
| Gemini rate limits or quotas distort L4 results. | Interleave A/B requests, keep concurrency low, record HTTP 429s separately, and do the heavy load in mock mode. |
| The host machine is shared with other apps, which adds noise. | Run 3 repetitions, report the median, and use a "quiet mode" checklist in the UI. |
| Desktop noise (GNOME, browser, background updates) on the bench host. | Quiet-mode script, CPU pinning (`cpuset`) that leaves cores for the desktop, and the suspect flag. |
| Kubernetes overhead (Service routing, CFS throttling) gets mistaken for a language difference. | Record the platform per run, compare like with like, use Guaranteed QoS, and track the throttling metric. |
| Compose and k3s run at once and skew results. | `make mode-compose` / `make mode-k8s` stop the other stack, and preflight refuses to run if both are active. |
| Python is under-configured, which makes the comparison unfair. | Python runs with `uvloop`, `httptools`, `orjson`, workers = CPU limit, and asyncpg. Go uses the stdlib plus pgx. Both are "reasonable production defaults", not hand-tuned extremes. |

## 12. Open questions

1. ~~Gemini model~~ **Decided:** `gemini-3.5-flash-lite` (GA), configurable via `GEMINI_MODEL`, and recorded per run.
2. **Python workers:** a single worker (simplest, like the default `adk api_server`) or workers = CPU count? *Default: run both variants as separate profiles (`py-1w`, `py-Nw`) because that's a real-world question.*
3. Should a future phase add a **hybrid** container (a Go gateway proxying to Python ADK) to test option 3 directly? *Proposed as Phase 7 (optional).*
4. ~~Ubuntu specs~~ **Decided:** Ryzen 5 4600G (6C/12T), 16 GB DDR4, used as the deployment server. Development happens on the Mac.
5. ~~Kubernetes pacing~~ **Decided:** build everything at once (fast mode). The labs are for self-study afterwards.
6. ~~Embeddings~~ **Decided:** `gemini-embedding-2` (768 dimensions) in pgvector, hybrid with full-text search. Mock mode uses a deterministic local embedder.


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


# 03 — App Flow

## 1. Startup flow

```
make up  (docker compose up --build -d)
  │
  ├─ postgres starts → runs db/init/*.sql (first boot only)
  │     creates DBs go_app, py_app, dashboard → app schema + seed (100k bench_items) → dashboard schema
  │     healthcheck: pg_isready
  │
  ├─ go-server & fastapi-server (wait for postgres healthy)
  │     load config → open DB pools → init ADK session service (auto-migrate ADK tables)
  │     → build bench_agent (Gemini model + mock model) → start HTTP :8080
  │     healthcheck: GET /healthz
  │
  └─ dashboard (waits for both servers healthy)
        connect dashboard DB → read docker socket → serve SPA + /api on :3000
        user opens http://localhost:3000
```

### 1.1 Kubernetes mode (`make mode-k8s OVERLAY=bench`)

```
make mode-k8s
  ├─ docker compose down; systemctl start k3s
  ├─ make registry-up && make images      → localhost:5000/<svc>:<git-sha>
  ├─ make k8s-sync && make k8s-secrets    → generated/ ConfigMap sources, Secret gemini from .env
  └─ kubectl apply -k deploy/k8s/overlays/<overlay>
        ├─ Namespace bench, Secrets, ConfigMaps (db-init, agent-spec)
        ├─ StatefulSet postgres → PVC (local-path) → init scripts on first boot → Ready
        ├─ Deployments go-server, fastapi-server: initContainer waits for postgres → startupProbe → readinessProbe → Ready
        └─ Deployment dashboard (ServiceAccount + Role, PLATFORM=k8s) → Service → Ingress (Traefik)
make k8s-open → port-forward Traefik to localhost:8080 → http://localhost:8080
```

## 2. Screen map

```
┌ Top bar: [Chat] [Live] [Benchmarks] [History] [Compare]   ● go ● py ● db   mode: Mock|Gemini
│
├─ /chat        Side-by-side chat (default landing page)
├─ /live        Real-time resource and request monitor
├─ /bench       Benchmark runner (configure → run → results)
├─ /history     Runs list
├─ /compare     Pick 2 runs (or a Go/Py pair) → deltas + charts
└─ /about       Environment: platform (Compose / k8s: node, pods, QoS), versions, limits, static characteristics, DX notes
```

## 3. Flow A: side-by-side chat

```
User types "What's our electronics inventory?"  [mode: Gemini]  [targets: both]
  │
  ▼
SPA  POST /api/chat {message, mode, targets, conversation_id}
  │
  ▼
Dashboard API
  ├─ if no session per target yet: POST /v1/sessions on each server (in parallel)
  ├─ t0 = now; open POST /v1/chat/stream to go-server AND fastapi-server simultaneously
  ├─ relay each upstream SSE event to the browser, tagged {target}
  │     records client_ttft_ms on first `token`, client_total_ms on `done`
  └─ on both `done` → persist chat_turns rows → emit `turn_complete` summary
  │
  ▼
SPA
  ├─ left pane (Go) and right pane (Py) stream tokens independently
  ├─ tool_call events render as collapsible chips ("🔧 get_inventory_stats · 3.1 ms")
  └─ under each reply: metric strip
        TTFT 412ms │ Total 1.83s │ Model 1.79s │ Overhead 4.2ms │ 128 tok
     and a "winner" marker on the lower overhead / TTFT
```

**Inside each server (both implement this same sequence):**

```
POST /v1/chat/stream
  → validate → start timer → write `meta`
  → runner.Run(user_id, session_id, message)       [ADK]
       ├─ session service loads session (Postgres)        ← session_ms
       ├─ model.generate (timed decorator)                ← model_ms
       │     └─ if function_call → tool executes (pgx/asyncpg) ← tool_ms
       │         → model.generate again
       ├─ partial events → `token` SSE
       └─ session service appends events (Postgres)       ← session_ms
  → compute overhead_ms → write `done` → close
```

RAG path (a question about the docs or knowledge base):

```
model → function_call search_knowledge_base(query)
  → server embeds the query (gemini or mock) → hybrid SQL (09 §6) on its own DB → tool response {results:[{source,heading,content}]}
  → SSE `tool_call` event (UI shows source chips) → model answers citing [source]
```

Knowledge-base startup: the dashboard calls `/v1/rag/stats` on both servers, and any server with 0 documents gets `POST /v1/rag/ingest {corpus:"default"}`.

Edge cases:
- If one server errors, its pane shows an error card with the code. The other pane continues.
- A Gemini 429 shows the code `UPSTREAM_429` with a "rate limited, try Mock mode" hint.
- "New conversation" creates new sessions on both servers.
- On reload, the SPA fetches `/api/conversations/:id` and rebuilds the panes from the dashboard DB. Each server's own history is also available via `GET /v1/sessions/{id}`.

## 4. Flow B: live monitor

```
SPA opens /live → GET /api/live (SSE, 1 Hz)
Dashboard every 1 s:
  docker stats (go-server, fastapi-server, postgres, dashboard)
  every 2 s: scrape /metrics from both servers → compute RPS, error %, p50/p95/p99 from histogram deltas
→ push {ts, go:{cpu,mem,net,threads,rps,p99,…}, python:{…}, postgres:{…}, dashboard:{cpu}}
SPA keeps a rolling 5-minute window in memory and renders paired sparklines/charts
```

Live works at all times. It's most informative while a benchmark or chat is running.

## 5. Flow C: run a benchmark

```
/bench
 1. Pick scenario (cards grouped L1 / L2 / L3 / L4 / Static)
 2. Form prefilled from /api/scenarios: targets, concurrency, duration, reps, warm-up, profile (py-1w / py-Nw)
    └─ L4 (Gemini): show cost/rate-limit confirm dialog, caps enforced
 3. [Run] → POST /api/runs → 201 {run_id}  (409 if another run is active → show "run in progress" link)
 4. Navigate to /bench/:run_id → GET /api/runs/:id/stream
       phases: preflight → warmup(A) → run(A) → cooldown → warmup(B) → run(B) → … reps … → analyze
       live: progress bar, current RPS, latency, errors, per-target CPU/mem
 5. Analyze: compute stats, flags (suspect?), persist → `complete` event
 6. Results view:
       headline deltas  (e.g., "Go: 4.1× RPS · p99 −68% · mem −82%")
       percentile table, latency histogram (overlay), RPS-over-time, CPU/mem-over-time
       buttons: Export JSON/CSV/MD · Compare with… · Re-run
```

Kubernetes-only scenarios (greyed out in Compose mode):

```
scale-out:          set HPA on A → ramp VUs → record replicas / RPS / p99 each second → reset to 1 replica → repeat for B
rollout-disruption: constant load on A → platform.rollout(A) at t=15 s → continue until new pods Ready + 10 s
                    → count errors, p99 spike, time-to-complete → repeat for B
```

Orchestrator state machine:

```
queued → preflight → running(rep i, target X, phase) → analyzing → complete
                 ↘ failed (preflight/health)         ↘ cancelled (user)
```

## 6. Flow D: history and compare

```
/history → GET /api/runs?scenario=&from=  → table (date, scenario, targets, headline delta, suspect flag)
  select row → /bench/:run_id (results view)
  select 2 rows → /compare?a=&b=

/compare → GET /api/compare → side-by-side tables + overlaid charts + delta badges
          → Export MD (feeds the Decision Report)
```

## 7. Flow E: decision report

```
/about → "Generate Decision Report"
  dashboard collects the latest non-suspect run per scenario (both targets)
  + static characteristics + DX notes
  → renders Markdown (docs/report template) → download / save to ./reports/ (bind mount)
```


# 04 — Design Brief (Dashboard)

## 1. Purpose and tone

This is an engineer's instrument panel, not a marketing site. It should feel like a precise lab tool: dense but calm, numbers first, and every comparison readable at a glance. One question drives every screen: **"Which side is better here, and by how much?"**

## 2. Principles

1. **Always paired.** Go and Python appear in fixed positions everywhere: **Go on the left, Python on the right**, and in that order in tables and legends.
2. **Deltas over raw values.** Every comparison shows the delta and ratio, for example "−68% p99" or "4.1× RPS", with the better side highlighted.
3. **Honest data.** Show sample size, reps, variance, and suspect flags. Never hide errors.
4. **Separate model time from server time.** Timing strips always split *model* from *overhead* visually, so Gemini latency never gets mistaken for server speed.
5. **Calm by default.** Motion only for streaming text and live charts.

## 3. Visual identity

| Token | Light | Dark (default) | Use |
|---|---|---|---|
| `--bg` | `#F7F8FA` | `#0E1116` | page |
| `--surface` | `#FFFFFF` | `#161B22` | cards / panes |
| `--border` | `#E3E6EB` | `#2A313C` | dividers |
| `--text` | `#14171C` | `#E6EAF0` | primary text |
| `--muted` | `#5B6472` | `#8B95A5` | labels |
| `--go` | `#0B7FAB` | `#3FB6E0` | Go series (Go-brand cyan family) |
| `--py` | `#B8860B` | `#F2C14E` | Python series (Python-yellow family) |
| `--better` | `#1A7F37` | `#3FB950` | winning delta |
| `--worse` | `#C93C37` | `#F85149` | losing delta |
| `--model` | `#8250DF` | `#A371F7` | model-time segment in timing bars |

- **Typography:** Inter for the UI and JetBrains Mono for all numbers, code, and IDs. Numbers use `font-variant-numeric: tabular-nums`.
- **Density:** 4 px spacing grid. Cards are 12 px radius with 1 px border and no heavy shadows.
- **Icons:** Lucide.
- The Go/Py colours are chosen to stay distinguishable for colour-blind users (blue vs yellow). Every series is also labelled with text, never colour alone.

## 4. Key screens

### 4.1 Chat (`/chat`), the landing page

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Mode: (•) Mock  ( ) Gemini]   Targets: [x] Go [x] Python   [New chat]  │
├───────────────────────────────────┬──────────────────────────────────────┤
│  GO  · adk-go v2.5 · net/http     │  PYTHON · google-adk 2.x · FastAPI   │
│                                   │                                      │
│  👤 What's our electronics stock? │  👤 What's our electronics stock?   │
│  🔧 get_inventory_stats  3.1 ms   │  🔧 get_inventory_stats  5.8 ms     │
│  🤖 Electronics has 12,412 items… │  🤖 Electronics has 12,412 items…   │
│  ┌ timing bar ───────────────┐    │  ┌ timing bar ───────────────┐      │
│  │███████████████████▌ ░     │    │  │███████████████████▌ ░░    │      │
│  └ model 1.79s  overhead 4ms ┘    │  └ model 1.81s  overhead 19ms┘      │
│  TTFT 412ms · total 1.83s · ✓     │  TTFT 431ms · total 1.86s           │
├───────────────────────────────────┴──────────────────────────────────────┤
│  [ Type a message…                                         ] [Send ⏎]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- The timing bar is a stacked horizontal bar: model (purple), tool, session/db, overhead. Hovering shows exact ms.
- A conversation summary in the footer gives the average overhead and TTFT per side across the conversation.
- A **Knowledge base** drawer (right edge, collapsible) shows doc, chunk, and Gemini-embedded chunk counts per side, an "Ingest default corpus" button with Go vs Py ingest timings, file upload, and a test-search box showing both result lists side by side with mode (hybrid / vector / fts) and embedder selectors, plus `embed_ms` and `db_ms`.
- `search_knowledge_base` tool chips list the retrieved sources (`docs/07-KUBERNETES.md › Probes`).

### 4.2 Live (`/live`)
- A 2-column grid of paired mini-charts (Go | Py): CPU %, Memory MB, RPS, p99 ms, threads/goroutines.
- A Postgres row below: connections, CPU, memory.
- A dashboard-health chip warns when the load generator's CPU is above 85%.

### 4.3 Benchmarks (`/bench`)
- Scenario cards grouped by layer (L1 Runtime, L2 Database, L3 Agent/mock, L4 Gemini, Static). Each card has a one-line explanation of *what it isolates*.
- A config drawer appears when you pick a card. Advanced fields (warm-up, reps, profile) start collapsed.
- **Running:** a phase stepper, a big live RPS number per side, and live latency and CPU charts.
- **Results:** a headline delta banner, then a percentile table (p50/p90/p95/p99/max, both sides plus a delta column), an overlaid latency histogram (log-x), RPS over time, CPU/mem over time, and derived metrics (RPS/core, RPS/100 MB).

### 4.4 History and Compare
- History is a dense sortable table with a suspect-flag icon and checkboxes. Selecting 2 enables **Compare**.
- Compare shows a two-column summary, delta badges, and overlaid charts. It also works **across platforms** (same scenario, Compose vs k8s), and each run carries a platform badge (`🐳 compose` / `⎈ k8s`).

### 4.5 About / Environment
- A platform panel. In k8s it shows the node, pods per target with status, restarts, QoS class, and HPA state.
- A versions table, resource limits, image size, cold start, idle memory, and dependency count.
- A DX notes editor per server (Markdown), saved to the DB.
- **Generate Decision Report.**

## 5. Components (build once, reuse)

`TargetBadge`, `PlatformBadge`, `DeltaBadge(value, betterWhen: "lower"|"higher")`, `TimingBar`, `MetricStrip`, `PairedChart`, `PercentileTable`, `ScenarioCard`, `RunPhaseStepper`, `HealthDot`, `SuspectFlag`, `StreamPane`.

## 6. States

- **Empty:** for example, "No runs yet. Start with *ping*, the 20-second smoke test."
- **Loading:** skeletons, never spinners on full pages.
- **Error:** an inline card with the error code and target. Errors on one side never blank the other side.
- **Offline target:** grey the pane, show a health dot and a "Retry" button. In k8s, show the pod status (for example `CrashLoopBackOff`, `ImagePullBackOff`) with a hint to run `kubectl describe`. That's handy during the labs.
- **Run preflight:** a quiet-mode checklist dialog (close heavy apps, power profile on performance) before every official run.

## 7. Accessibility and responsiveness

- WCAG AA contrast in both themes, full keyboard support for chat and the run controls, and `aria-live="polite"` on streaming panes.
- The primary target is ≥ 1280 px desktop. Below 900 px, the chat panes stack (Go first) and charts go single-column.


# 05 — Database Schema

One PostgreSQL 17 container with **three databases**:

| Database | Owner/user | Used by | Contains |
|---|---|---|---|
| `go_app` | `bench` | go-server | ADK-Go session tables (auto-managed) and the `app` schema (bench + tool data) |
| `py_app` | `bench` | fastapi-server | ADK-Python session tables (auto-managed) and the **identical** `app` schema |
| `dashboard` | `bench` | dashboard | conversations, benchmark runs, samples, and environment snapshots |

**Why separate app DBs instead of one shared DB?**
1. ADK-Go and ADK-Python create **their own, different session table schemas** (their names and columns can collide, for example `sessions`, `events`, `app_states`, `user_states`). Separate DBs avoid conflicts.
2. Writes from one server's benchmark can't bloat or lock the other's tables. Both DBs are seeded identically, so the comparison stays fair.
3. It mirrors reality: each service owns its database.

Both servers still share **one Postgres process** (as requested), so they compete equally for the same DB engine. That's why targets are benchmarked sequentially, never at the same time.

---

## 1. Bootstrap: `db/init/00-create-databases.sql`

```sql
-- runs once on first container boot (as POSTGRES_USER=bench)
CREATE DATABASE go_app;
CREATE DATABASE py_app;
CREATE DATABASE dashboard;
```

The same `db/init/` files are used in both modes. Compose bind-mounts them, and k8s mounts them from the `db-init` ConfigMap. So scripts must not reference paths outside `/docker-entrypoint-initdb.d`.

`db/init/05-apply.sh` runs `10-app-schema.sql` and `30-seed.sql` against **both** `go_app` and `py_app`, and `20-dashboard-schema.sql` against `dashboard`, using `psql -v ON_ERROR_STOP=1 -d <db> -f …`.

Postgres tuning (`command:` in compose): `-c shared_buffers=512MB -c max_connections=200 -c synchronous_commit=on -c random_page_cost=1.1`.

---

## 2. App schema (identical in `go_app` and `py_app`): `db/init/10-app-schema.sql`

```sql
CREATE SCHEMA IF NOT EXISTS app;

-- Read workload + agent tool data (100k deterministic rows)
CREATE TABLE app.bench_items (
    id          INTEGER      PRIMARY KEY,
    sku         TEXT         NOT NULL UNIQUE,
    name        TEXT         NOT NULL,
    category    TEXT         NOT NULL,          -- 10 categories: electronics, books, toys, …
    price       NUMERIC(10,2) NOT NULL,
    stock       INTEGER      NOT NULL,
    attributes  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX bench_items_category_idx ON app.bench_items (category);

-- Write workload (dashboard truncates it directly before each db-write run)
-- RAG tables: app.rag_documents, app.rag_chunks (pgvector HNSW x2 + tsvector GIN). Full DDL in docs/09-RAG.md §4.
-- Requires CREATE EXTENSION vector (image pgvector/pgvector:pg17).

CREATE TABLE app.bench_writes (
    id          BIGSERIAL    PRIMARY KEY,
    payload     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Seed (`30-seed.sql`) is deterministic, so both DBs hold byte-identical data:

```sql
INSERT INTO app.bench_items (id, sku, name, category, price, stock, attributes)
SELECT g,
       'SKU-' || lpad(g::text, 6, '0'),
       'Item ' || g,
       (ARRAY['electronics','books','toys','home','garden','sports','beauty','food','auto','office'])[1 + (g % 10)],
       round(((g * 7919) % 100000) / 100.0 + 1, 2),
       (g * 31) % 500,
       jsonb_build_object('color', (ARRAY['red','green','blue','black'])[1 + (g % 4)], 'weight_g', (g * 13) % 5000)
FROM generate_series(1, 100000) AS g;
ANALYZE app.bench_items;
```

The servers connect with `search_path=app,public`, so bench SQL can use unqualified names. ADK session tables live in `public`.

### 2.1 ADK-managed session tables (do not hand-write)

| Server | Created by | Expected tables (verify at implementation) |
|---|---|---|
| go-server | `session/database` (GORM) `AutoMigrate` at startup | `sessions`, `events`, `app_states`, `user_states` (GORM naming) |
| fastapi-server | `DatabaseSessionService` (SQLAlchemy) `create_all` at startup | `sessions`, `events`, `app_states`, `user_states` |

These schemas belong to ADK and can change between ADK versions. **No application code may query them directly.** History goes through the ADK session service API (`GET /v1/sessions/{id}`). After implementation, record the actual DDL (`pg_dump -s`) in `docs/appendix-adk-session-ddl.md` for reference.

---

## 3. Dashboard schema: `db/init/20-dashboard-schema.sql`

```sql
CREATE TYPE target_impl  AS ENUM ('go', 'python');
CREATE TYPE run_status   AS ENUM ('queued','preflight','running','analyzing','complete','failed','cancelled');
CREATE TYPE chat_mode    AS ENUM ('gemini','mock');

-- ── Side-by-side chat ─────────────────────────────────────────────
CREATE TABLE conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT,
    mode          chat_mode   NOT NULL,
    go_session_id TEXT,                     -- session id on go-server
    py_session_id TEXT,                     -- session id on fastapi-server
    user_id       TEXT        NOT NULL DEFAULT 'dashboard-user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_turns (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_index       INTEGER     NOT NULL,
    target           target_impl NOT NULL,
    request_id       UUID        NOT NULL,
    user_message     TEXT        NOT NULL,
    reply_text       TEXT,
    tool_calls       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{name,args,duration_ms}]
    status           TEXT        NOT NULL,                       -- ok | error
    error_code       TEXT,
    -- server-reported timings (from `done` event)
    server_total_ms  DOUBLE PRECISION,
    model_ms         DOUBLE PRECISION,
    tool_ms          DOUBLE PRECISION,
    session_ms       DOUBLE PRECISION,
    overhead_ms      DOUBLE PRECISION,
    server_ttft_ms   DOUBLE PRECISION,
    -- client-measured (dashboard)
    client_ttft_ms   DOUBLE PRECISION,
    client_total_ms  DOUBLE PRECISION,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, turn_index, target)
);

-- ── Environment snapshot (one per run; dedupe by hash) ────────────
CREATE TABLE environments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hash          TEXT        NOT NULL UNIQUE,     -- sha256 of the json below
    platform      TEXT        NOT NULL,            -- compose | k8s
    git_sha       TEXT,
    host_info     JSONB       NOT NULL,            -- Ubuntu version, kernel, arch, nproc, RAM, power profile; k8s: k3s version, node, overlay
    go_info       JSONB       NOT NULL,            -- /v1/info + container limits + image size
    py_info       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Benchmark runs ────────────────────────────────────────────────
CREATE TABLE benchmark_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario        TEXT        NOT NULL,          -- ping | json | cpu | sleep-io | db-read | … | chat-gemini | cold-start | scale-out | rollout-disruption
    layer           TEXT        NOT NULL,          -- L1 | L2 | L3 | L4 | static | k8s
    platform        TEXT        NOT NULL,          -- compose | k8s (denormalised for filtering)
    config          JSONB       NOT NULL,          -- {concurrency, duration_s, warmup_s, reps, targets, py_profile, mode, …}
    status          run_status  NOT NULL DEFAULT 'queued',
    environment_id  UUID        REFERENCES environments(id),
    suspect         BOOLEAN     NOT NULL DEFAULT false,
    suspect_reasons TEXT[]      NOT NULL DEFAULT '{}',
    notes           TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_runs_scenario_created_idx ON benchmark_runs (scenario, platform, created_at DESC);
-- Only one active run at a time (FR-12 / 409 busy)
CREATE UNIQUE INDEX benchmark_runs_one_active
    ON benchmark_runs ((true)) WHERE status IN ('queued','preflight','running','analyzing');

-- One row per (run, target, repetition)
CREATE TABLE run_results (
    id              BIGSERIAL PRIMARY KEY,
    run_id          UUID        NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target          target_impl NOT NULL,
    rep             SMALLINT    NOT NULL,
    order_in_rep    SMALLINT    NOT NULL,          -- 1 = ran first, 2 = ran second
    requests_total  BIGINT      NOT NULL,
    errors_total    BIGINT      NOT NULL,
    status_counts   JSONB       NOT NULL,          -- {"200": 123, "429": 2}
    duration_s      DOUBLE PRECISION NOT NULL,
    rps             DOUBLE PRECISION NOT NULL,
    lat_p50_ms      DOUBLE PRECISION, lat_p90_ms DOUBLE PRECISION,
    lat_p95_ms      DOUBLE PRECISION, lat_p99_ms DOUBLE PRECISION,
    lat_max_ms      DOUBLE PRECISION, lat_mean_ms DOUBLE PRECISION,
    ttft_p50_ms     DOUBLE PRECISION, ttft_p99_ms DOUBLE PRECISION,      -- chat scenarios
    overhead_p50_ms DOUBLE PRECISION, overhead_p99_ms DOUBLE PRECISION,  -- chat scenarios
    cpu_avg_pct     DOUBLE PRECISION, cpu_max_pct DOUBLE PRECISION,
    cpu_throttled_pct DOUBLE PRECISION,           -- from bench_cgroup_cpu_throttled_seconds_total
    max_replicas    SMALLINT,                      -- scale-out (k8s)
    rollout_errors  BIGINT,                        -- rollout-disruption (k8s)
    mem_avg_mb      DOUBLE PRECISION, mem_max_mb  DOUBLE PRECISION,
    rps_per_core    DOUBLE PRECISION,
    rps_per_100mb   DOUBLE PRECISION,
    latency_histogram JSONB,                       -- HDR-style buckets [{le_ms, count}]
    raw_summary     JSONB,                         -- oha json / node runner summary verbatim
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, target, rep)
);

-- Time series during a run (1 Hz)
CREATE TABLE run_samples (
    run_id      UUID        NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target      target_impl NOT NULL,
    rep         SMALLINT    NOT NULL,
    t_offset_s  INTEGER     NOT NULL,             -- seconds since this target's run start
    rps         DOUBLE PRECISION,
    lat_p50_ms  DOUBLE PRECISION,
    lat_p99_ms  DOUBLE PRECISION,
    errors      INTEGER,
    cpu_pct     DOUBLE PRECISION,
    mem_mb      DOUBLE PRECISION,
    threads     INTEGER,                          -- goroutines / threads
    db_pool_in_use INTEGER,
    replicas    SMALLINT,                         -- k8s: ready pods for this target at this second
    PRIMARY KEY (run_id, target, rep, t_offset_s)
);

-- Static characteristics (cold start, image size, idle mem) & DX notes
CREATE TABLE static_measurements (
    id           BIGSERIAL PRIMARY KEY,
    target       target_impl NOT NULL,
    metric       TEXT        NOT NULL,            -- cold_start_ms | pod_ready_ms | image_size_mb | idle_mem_mb | dep_count | build_time_s | loc
    platform     TEXT        NOT NULL,            -- compose | k8s
    value        DOUBLE PRECISION NOT NULL,
    environment_id UUID REFERENCES environments(id),
    measured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dx_notes (
    target      target_impl PRIMARY KEY,
    markdown    TEXT        NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dx_notes (target) VALUES ('go'), ('python');
```

`gen_random_uuid()` is built in from PG13+, so no extension is needed.

### 3.1 Useful views

```sql
-- Median across reps per run/target (what the UI headlines use)
CREATE VIEW run_summary AS
SELECT run_id, target,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY rps)          AS rps_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lat_p99_ms)   AS p99_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mem_avg_mb)   AS mem_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY overhead_p50_ms) AS overhead_p50_median,
       (stddev_pop(rps) / NULLIF(avg(rps),0)) * 100              AS rps_cv_pct
FROM run_results GROUP BY run_id, target;
```

---

## 4. ER overview

```
dashboard DB
 conversations 1──* chat_turns
 environments  1──* benchmark_runs 1──* run_results
                                   1──* run_samples
 environments  1──* static_measurements
 dx_notes (2 rows)

go_app / py_app DB (identical)
 app.bench_items      (100k seeded, read-only)
 app.bench_writes     (append; truncated by dashboard before db-write runs)
 app.rag_documents 1──* app.rag_chunks   (RAG knowledge base: vectors + FTS)
 public.<ADK session tables>  (owned by ADK; never queried directly)
```

## 5. Data lifecycle

- Before each `db-write` run, the dashboard runs `TRUNCATE app.bench_writes` on both app DBs through its own direct connections, so table size doesn't drift between targets.
- Chat-mock load runs create many ADK sessions. Afterwards the dashboard calls `DELETE /v1/sessions/{id}` for the sessions it created, or offers "Purge bench sessions" in `/about`.
- `make reset-db` wipes the Compose volume, and `make k8s-reset-db` deletes the k8s PVC. Init scripts re-run on the next boot. The Compose and k8s databases are **separate** (Docker volume vs local-path PVC), but they're seeded identically. Benchmark history lives in whichever `dashboard` DB was active. Use the dashboard's export/import (JSON) to merge history across modes.
- Migrations after v1: add numbered files `db/migrations/NNN_*.sql`, applied by the dashboard at startup with a `schema_migrations` table. Init scripts stay frozen at v1.


# 06 — Implementation Plan (subagent-driven)

The work is split so subagents can build in **parallel with no file overlap**. Contracts are frozen first (Phase 0). After that, each container is an independent workstream with its own directory and acceptance gate. Kubernetes comes in once the stack works in Docker Compose.

**Host:** Ubuntu 24.04 LTS desktop with Docker Engine, plus k3s from Phase 4. See [08](08-UBUNTU-SETUP.md).

## Ground rules for every subagent

1. **Read first:** `docs/02-TECHNICAL-REQUIREMENTS.md` (contracts), plus your workstream's section below and the relevant doc (schema / design / Kubernetes).
2. **Own only your directory.** Don't edit another workstream's files. If a contract change is needed, stop and report it. The orchestrator (main Claude) updates `contracts/` and the TRD, then informs all workstreams.
3. **Pin exact versions** and verify ADK APIs against current docs/pkg.go.dev (`google.golang.org/adk/v2`, `google-adk` on PyPI). Don't code ADK APIs from memory.
4. **Everything builds in containers on the Ubuntu host.** Don't assume Go, Python, or Node are installed. Use `docker compose build <svc>` and `docker compose run --rm <svc> go test ./...` (or the equivalent). Official benchmark numbers come only from the Ubuntu host.
5. **Done means:** the acceptance checklist passes, tests are green, the service is healthy (Compose, and from Phase 4 also k8s), and the completion report lists files, commands run, deviations, and open issues.
6. No secrets in code. `GOOGLE_API_KEY` comes only from `.env` (Compose) or the `gemini` Secret created from it (k8s).
7. **Local reference source** (shallow clones, read-only, outside this repo) is in `../adk_samples/`:
   - `adk-go/`: ADK-Go source. See `examples/quickstart`, `examples/rest` (REST server), `examples/tools`, `session/database` (GORM session service), and `model/` (model interface for the mock LLM).
   - `adk-python/`: ADK-Python source. See `src/google/adk/cli/fast_api.py` (`get_fast_api_app`), `sessions/database_session_service.py`, and `models/base_llm.py` (for the mock LLM).
   - `adk-samples/`: official samples in `core/{go,python}` and `contrib/{go,python,…}`.
   Before coding, check out the tag you pin (`git fetch --depth 1 origin tag vX.Y.Z`) so the source matches your dependency version.
8. **Kubernetes-ready from day one** (it costs almost nothing now): read all config from env vars, log to stdout, handle SIGTERM gracefully (drain in-flight requests and SSE within 20 s), and keep `/healthz` (DB-aware) separate from `/bench/ping` (DB-free).

## Phase overview

```
Phase 0  Foundation, contracts, Ubuntu host scripts   (main Claude)          ── gate G0
         Phase 1 + Phase 4 (k8s manifests) run in parallel in fast mode
Phase 1  Build in parallel                            (4 agents: DB, GO, PY, DASH) ── gate G1
Phase 2  Parity & integration                         (1 agent)              ── gate G2
Phase 3  Benchmark engine & results UI (Compose)      (2 agents)             ── gate G3
Phase 4  Kubernetes (k3s) deployment + labs K0–K9     (2 agents + you)       ── gate G4
Phase 5  Validation runs, both platforms              (1 agent + you)        ── gate G5
Phase 6  Decision report & polish                     (1–2 agents)           ── gate G6
Phase 7  (optional) Hybrid: Go gateway → Python ADK
```

---

## Phase 0: Foundation and host (agent: `foundation`)

**Deliverables**
- `git init` with a `.gitignore` (`.env`, `node_modules`, `__pycache__`, `bin/`, `reports/`, `deploy/k8s/base/generated/`).
- `docker-compose.yml` with all 4 services (stub images are fine for servers and dashboard), limits from `.env` (`SERVER_CPUS`, `SERVER_MEM`, `DASH_CPUS`), healthchecks, `127.0.0.1` port binds, and `ulimits: nofile: 65535`. Add `docker-compose.bench.yml` with `cpuset` pinning, generated from `scripts/cpu-layout.sh` ([08 §5](08-UBUNTU-SETUP.md#5-cpu-pinning-linux-only-advantage)).
- `.env.example` and a `Makefile` with these targets: `up`, `up-bench`, `down`, `logs`, `ps`, `reset-db`, `test-go`, `test-py`, `test-dash`, `test-contract`, `bench-smoke`, `tune-host`, `untune-host`. The k8s targets are stubbed for Phase 4.
- `scripts/ubuntu-setup.sh`, `scripts/ubuntu-tune.sh` (+ untune), and `scripts/cpu-layout.sh`, per [08](08-UBUNTU-SETUP.md). They must be idempotent, and use `set -euo pipefail` and `shellcheck`-clean code.
- `contracts/openapi.yaml` (from TRD §5), `contracts/sse-events.md`, `contracts/agent-spec.md`, and `contracts/fixtures/`.
- A `README.md` quick start for Ubuntu.

**Gate G0:** you run `scripts/ubuntu-setup.sh` on the Ubuntu machine, and `docker run hello-world` works without sudo. `docker compose config` is valid. The OpenAPI file validates (`npx @redocly/cli lint`). You review and approve the contracts.

---

## Phase 1: Parallel build (4 agents, launched in one message)

### WS-DB (agent: `db`), owns `db/`
- Init scripts exactly as in [05](05-DATABASE-SCHEMA.md): create DBs, apply app schema and seed to both app DBs, and set up the dashboard schema and views. They must work both from Compose's bind mount and from a k8s ConfigMap mounted at `/docker-entrypoint-initdb.d`, so no paths outside that dir.
- **Acceptance:** fresh `make reset-db && make up postgres` → 3 DBs. `SELECT count(*) FROM app.bench_items` returns 100000 in both `go_app` and `py_app`. An md5 checksum of `bench_items` is equal across both DBs.

### WS-GO (agent: `go-server`), owns `go-server/`
1. Multi-stage Dockerfile (`golang:<version from ADK-Go go.mod>` → `gcr.io/distroless/static`), static binary, non-root.
2. `internal/config`: env parsing.
3. `internal/db`: `pgxpool` (search_path=app,public) and the GORM postgres dialector for ADK sessions.
4. `internal/agent`: `llmagent.New(...)` with the Gemini model (`model/gemini`), the instruction from `contracts/agent-spec.md`, and two function tools. The runner uses the ADK `session/database` service with `AutoMigrate`.
5. `internal/mockllm`: implements ADK-Go's model interface per the mock script, including the function-call branch.
6. A timing decorator that wraps the model to accumulate `model_ms`. Tool and session timing go through wrappers or callbacks.
7. `internal/api`: stdlib mux with `/healthz`, `/v1/info`, `/v1/sessions*`, `/v1/chat`, `/v1/chat/stream` (SSE with `http.Flusher`), and `Server-Timing` headers. Graceful shutdown with `http.Server.Shutdown` on SIGTERM.
8. `internal/bench`: every `/bench/*` endpoint per TRD §5.4.
9. `internal/metrics`: Prometheus metrics with the exact names in TRD §7, **including the `bench_cgroup_*` metrics read from `/sys/fs/cgroup`**.
10. Tests: handler tests (httptest), mock-LLM event sequence, bench endpoint correctness, and cgroup file parsing.
- **Acceptance:** container healthy. `curl` checks pass for every endpoint. A mock chat streams `meta → token×N → done` with all timing fields. The "inventory" message produces a `tool_call` with correct DB numbers. A Gemini chat works with a real key. `docker stop` mid-stream closes the stream cleanly. `go test ./...` and `go vet` pass.

### WS-PY (agent: `fastapi-server`), owns `fastapi-server/`
1. Dockerfile on `python:3.12-slim` with `uv`, a non-root user, and the CMD `uvicorn app.main:app --host 0.0.0.0 --port 8080 --workers ${PY_WORKERS} --loop uvloop --http httptools --no-access-log --timeout-graceful-shutdown 20`.
2. `app/main.py`: build the app with `get_fast_api_app(agents_dir=..., session_service_uri="postgresql+asyncpg://…/py_app", web=False)` and **include** the custom routers. Keep ADK native routes.
3. `app/db.py`: asyncpg pool (size = `DB_POOL_MAX // PY_WORKERS`, min 2), created on lifespan startup.
4. `app/agent/`: `LlmAgent` with the same instruction, tools, and generate config. A `Runner` uses the same `DatabaseSessionService` instance.
5. `app/mockllm.py`: a `BaseLlm` subclass per the mock script, using `await asyncio.sleep`.
6. A timing wrapper (model, tool, session), identical in semantics to Go.
7. `app/api/`: `/healthz`, `/v1/info`, `/v1/sessions*`, `/v1/chat`, `/v1/chat/stream` (`StreamingResponse`/`EventSourceResponse`), and `Server-Timing`.
8. `app/bench/`: every `/bench/*` endpoint. **CPU bench:** use `hashlib` in the default `async def` route (it blocks the loop, which is the honest behaviour), plus a `?offload=1` variant using `run_in_threadpool`.
9. `app/metrics.py`: prometheus-client in multiprocess mode (`PROMETHEUS_MULTIPROC_DIR`), plus the `bench_cgroup_*` metrics. The cgroup is per-container, so it covers all workers.
10. Tests: pytest + httpx `AsyncClient`, mirroring the Go tests.
- **Acceptance:** the same as WS-GO, on port 8082, plus ADK's native `/list-apps` responds.

### WS-DASH (agent: `dashboard`), owns `dashboard/`
1. Dockerfile: a Node 22 build stage (SPA) and a runtime stage. Copy in the `oha` binary for `TARGETARCH`.
2. `server/platform/`: the **Platform adapter interface** (TRD §8.1) and the `compose` implementation (dockerode). The k8s implementation comes in Phase 4, but the interface is fixed now.
3. `server/`: Hono app serving the SPA, `/api/platform`, `/api/targets`, `/api/chat` (fan-out SSE relay with client-side timings and persistence), and `/api/live` (cgroup metrics scrape + platform stats).
4. `web/`: layout, theme tokens, components from [04 §5](04-DESIGN-BRIEF.md), and the `/chat` and `/live` pages. The top bar shows the platform badge.
5. Build against `contracts/openapi.yaml`, using a contract-faithful stub (`dashboard/dev/stub-target.ts`) until the real servers exist.
- **Acceptance:** against two stub targets, the chat streams in both panes with the metric strip, and live charts update at 1 Hz. With real servers, the same works in Mock and Gemini mode. Conversations survive a reload.

**Gate G1:** each stream's acceptance checklist passes independently.

---

## Phase 2: Parity and integration (agent: `parity`)

- `contracts/tests/` is a Vitest suite parameterised over both targets (base URLs from env, so it also runs in k8s later). It covers the schemas of every endpoint, SSE event order and fields, the `bench/json` output equality, `bench/cpu` hash equality, `db/read` row equality, tool-call results in mock mode, and session create/read/delete.
- A **timing-semantics audit:** with mock settings of 250 ms first token and 60 tokens × 15 ms, both servers should report `model_ms` ≈ 1150 ms ± 5% and `overhead_ms` < 50 ms.
- A **cgroup metrics audit:** under the `cpu` scenario, `bench_cgroup_cpu_usage_seconds_total` agrees with `docker stats` within 10%.
- **Gate G2:** the contract suite is 100% green on both targets, and both audits pass.

## Phase 3: Benchmark engine and results UI (2 agents in parallel)

### WS-ORCH (agent: `orchestrator`), owns `dashboard/server/bench/`
- Scenario catalogue (TRD §6), the run state machine, warm-up, cooldown, A/B alternation, reps, and the one-active-run lock.
- `oha` driver and a Node chat runner (`undici`, VU pool, TTFT, ramp).
- A 1 Hz sampler (cgroup metrics + platform stats) → `run_samples`, and an analyzer → `run_results`, including `platform` and the suspect flags.
- Preflight goes **only through the Platform adapter**. It checks that the other stack isn't active and that the quiet-mode checklist was acknowledged.
- Housekeeping (truncate `bench_writes`, delete bench sessions). Cold start through `platform.restart()`.
- Unit tests for the stats math and the state machine.

### WS-RESULTS-UI (agent: `results-ui`), owns `dashboard/web/src/pages/{bench,history,compare,about}`
- The scenario cards (k8s-only scenarios greyed out in Compose mode), config drawer, Gemini confirmation dialog, quiet-mode checklist dialog, running view, results, history (with a platform filter), compare (including cross-platform), about page, and DX notes.

**Gate G3:** `make bench-smoke` (ping, db-read, chat-mock at 5 s each, 1 rep) completes on Compose, persists, and renders.

## Phase 4: Kubernetes (2 agents + you), see [07](07-KUBERNETES.md)

### WS-K8S (agent: `k8s`), owns `deploy/k8s/`
- Host files (`k3s-config.yaml`, `registries.yaml`) and the Make targets (`registry-up`, `images`, `k8s-*`, `mode-*`).
- The Kustomize base and the overlays `dev`, `bench`, and `scale`, following the rules in [07 §4.1](07-KUBERNETES.md#41-key-manifest-rules-for-the-implementing-agent).
- Lab notes `deploy/k8s/labs/K0.md … K9.md`: commands, expected output, the break-it exercise, and answers in `<details>`.
- **Fast mode (chosen):** everything is built in one go, in parallel with Phase 1. The lab notes are written for self-study afterwards.

### WS-K8S-ADAPTER (agent: `k8s-adapter`), owns `dashboard/server/platform/k8s.ts`
- Implements the Platform interface with `@kubernetes/client-node`, using the in-cluster ServiceAccount. Covers `info` (QoS class, node, image digests), `containerStats` (metrics-server, plus the servers' own cgroup metrics), `restart` (delete pod → watch Ready), `scale`, `rollout` (patch the restart annotation → watch rollout), and `isOtherStackActive`.
- Adds the `scale-out` and `rollout-disruption` scenarios to the orchestrator catalogue (coordinate with the orchestrator through main Claude).

**Gate G4:** see [07 §7](07-KUBERNETES.md#7-kubernetes-done-criteria-gate-g4).

## Phase 5: Validation and calibration (agent: `validator` + you)

- Run `make tune-host` and close heavy apps. Run every scenario 3× on **Compose (`up-bench`, pinned)** and 3× on **k8s (`bench` overlay)**. Check that the coefficient of variation is ≤ 10%.
- A load-generator ceiling check: `ping` against a static nginx. Dashboard CPU should stay under 85%.
- Sanity-check against expectations. Go should lead on `cpu`, `ping`, and `json`, and on idle memory. `chat-gemini` should be near-equal. Investigate anything surprising: fix bugs, never "fix" results.
- Run both Python profiles (`py-1w`, `py-Nw`) and, in k8s, compare `py-1w × N pods` with `py-Nw × 1 pod`.
- **Gate G5:** a complete, non-suspect result set exists for all scenarios on both platforms.

## Phase 6: Report and polish (agents: `report`, optional `native-adk`)

- The Decision Report generator (PRD §10), now including a **Kubernetes section** (pods needed, scale speed, rollout errors, density).
- Optional: a native-ADK API comparison (`/run_sse` vs ADK-Go's REST handler under `/adk`).
- Accessibility pass and final README.
- **Gate G6:** you review the Decision Report.

## Phase 7 (optional): Hybrid

A `hybrid-gateway` Go service (sessions, auth, and SSE fan-out) proxies agent execution to the Python ADK. It's deployed in Compose and k8s and benchmarked as a 3rd target.

---

## Suggested subagent launch sequence

| Step | Launch | Parallel? | Est. effort |
|---|---|---|---|
| 1 | `foundation` → you run `ubuntu-setup.sh` | — | S |
| 2 | `db`, `go-server`, `fastapi-server`, `dashboard` | **yes, 4 agents** | L each |
| 3 | `parity` | — | M |
| 4 | `orchestrator`, `results-ui` | **yes, 2 agents** | L, M |
| 5 | `k8s` (per lab group, pausing for you), `k8s-adapter` | partly parallel | M, M |
| 6 | `validator` | — | M (mostly wall-clock) |
| 7 | `report` (+ `native-adk`) | yes | S–M |

Each subagent prompt should include its workstream section verbatim, links to the docs, and the ground rules above. Use `isolation: "worktree"` for parallel agents if you want branch-per-stream review, and merge at each gate.

## Prerequisites from you

- [ ] An Ubuntu 24.04 machine with Docker Engine (installed by `scripts/ubuntu-setup.sh` in Phase 0). Ideally 12+ threads and 16–32 GB RAM.
- [ ] Claude Code running on the Ubuntu machine (recommended), with this repo and `../adk_samples` cloned there ([08 §7](08-UBUNTU-SETUP.md#7-where-claude-code-runs)).
- [ ] A `GOOGLE_API_KEY` (Gemini API, AI Studio) in `.env`. Check your quota for L4 runs.
- [ ] Approve the contracts at gate G0.
- [ ] Answer the open questions in PRD §12, or accept the defaults.


# 07 — Kubernetes (k3s) Deployment and Learning Path

This doc has two goals:
1. Run the **same four images** on Kubernetes, so we can benchmark Go vs FastAPI where Kubernetes changes the picture: density, scale-out, and rollouts.
2. **Teach Kubernetes** through labs that build this project step by step, with no throwaway tutorials.

Docker Compose stays the fast dev loop and the baseline. Kubernetes comes in at Phase 4 ([06](06-IMPLEMENTATION-PLAN.md)), after the app works in Compose.

---

## 1. Why k3s (on Ubuntu 24.04 desktop)

| Option | Verdict |
|---|---|
| **k3s** ✅ | A real, CNCF-conformant Kubernetes in one binary and systemd service, light enough to share a desktop. It bundles containerd, CoreDNS, Traefik (Ingress), local-path storage, metrics-server, and NetworkPolicy enforcement. |
| MicroK8s | Also good on Ubuntu (Canonical, snap). Strict snap confinement and add-on management add friction. |
| kind / minikube | Great for CI and tutorials, but Kubernetes-inside-Docker (or a VM) adds a network/virtualization layer that skews benchmarks. |
| kubeadm | Best for learning internals, but heavy for day one. Optional lab K13. |

Single node. Multi-node is out of scope.

## 2. Cluster configuration

`deploy/k8s/host/k3s-config.yaml` (copied to `/etc/rancher/k3s/config.yaml` before install, see [08](08-UBUNTU-SETUP.md)):

```yaml
write-kubeconfig-mode: "0600"
disable:
  - servicelb          # don't open :80/:443 to the LAN; we use port-forward
kubelet-arg:
  - "max-pods=110"
  # K12 (advanced) adds: cpu-manager-policy=static, reserved-cpus=0-1
```

`deploy/k8s/host/registries.yaml` lets k3s pull from the local registry:

```yaml
mirrors:
  "localhost:5000":
    endpoint: ["http://localhost:5000"]
```

**Image flow:** `make registry-up` runs `registry:2` on `127.0.0.1:5000` under Docker. Then `make images` builds each image, tags it `localhost:5000/<svc>:<git-sha>`, and pushes it. Overlays pin that tag through `kustomize edit set image`. Tags are immutable, so no `:latest`.

## 3. Cluster architecture

```
namespace: bench
┌───────────────────────────────────────────────────────────────────────────┐
│  Ingress (Traefik, kube-system) ── path / ──▶ Service dashboard :3000     │
│                                                                           │
│  Deployment dashboard (1)  SA: dashboard + Role (pods, deployments/scale, │
│        │                    pods metrics) ── load generator runs here     │
│        ├──▶ Service go-server      :8080 ──▶ Deployment go-server (1..4)   │
│        └──▶ Service fastapi-server :8080 ──▶ Deployment fastapi-server(1..4)│
│                                        │                                  │
│                         Service postgres (headless) ──▶ StatefulSet postgres│
│                                                         PVC 10Gi local-path│
│  Secret gemini (GOOGLE_API_KEY) · Secret postgres-credentials             │
│  ConfigMap db-init (db/init/*) · ConfigMap agent-spec (contracts/…)       │
│  HPA go-server / fastapi-server (scale overlay only)                      │
│  NetworkPolicies (lab K10)                                                │
└───────────────────────────────────────────────────────────────────────────┘
Access: make k8s-open → kubectl -n kube-system port-forward svc/traefik 8080:80 → http://localhost:8080
```

The app code doesn't change between Compose and Kubernetes. Only env values and the dashboard's **platform adapter** (`PLATFORM=k8s`, TRD §8.1) differ. Service DNS names deliberately match the Compose service names (`go-server`, `fastapi-server`, `postgres`), so `DATABASE_URL` and target URLs stay identical.

## 4. Manifest layout (Kustomize)

```
deploy/k8s/
├── host/                       # k3s-config.yaml, registries.yaml (host files, not applied)
├── base/
│   ├── kustomization.yaml      # namespace: bench; configMapGenerator / secretGenerator
│   ├── namespace.yaml
│   ├── generated/              # git-ignored; `make k8s-sync` copies db/init/* + contracts/agent-spec.md here
│   ├── postgres/   statefulset.yaml  service.yaml
│   ├── go-server/  deployment.yaml   service.yaml
│   ├── fastapi-server/ deployment.yaml service.yaml
│   └── dashboard/  deployment.yaml service.yaml serviceaccount.yaml role.yaml rolebinding.yaml ingress.yaml
└── overlays/
    ├── dev/        # small limits, 1 replica each, fast iteration
    ├── bench/      # Guaranteed QoS (requests == limits) matching Compose limits; used for numbers
    └── scale/      # bench + HPA (min 1, max 4, CPU 70%) for go-server and fastapi-server
```

Why `generated/`: Kustomize refuses to load files outside its directory, so `make k8s-sync` copies them in. It runs automatically before `make k8s-up`.

### 4.1 Key manifest rules (for the implementing agent)

| Concern | Rule |
|---|---|
| Probes | `startupProbe` on `/healthz` (generous, covers ADK migrations). `readinessProbe` on `/healthz` (checks the DB). `livenessProbe` on **`/bench/ping`**: liveness must not depend on the DB, or a DB blip restarts every pod (a lesson in K3). |
| Startup order | An initContainer (`pgvector/pgvector:pg17`, the same image as Postgres, already pulled, `pg_isready` loop) on both servers. Kubernetes has no `depends_on`. |
| Resources | Base sets requests and limits. The `bench` overlay sets requests == limits (`cpu: 2`, `memory: 1Gi`), giving the **Guaranteed** QoS class. |
| Python workers | `PY_WORKERS` comes from the downward API: `resourceFieldRef: {resource: limits.cpu, divisor: "1"}`. Workers track the CPU limit automatically. Go needs nothing, because the runtime reads the cgroup limit. |
| Secrets | `make k8s-secrets` creates Secret `gemini` from `.env`. It's never committed. (Secrets are only base64. Sealed Secrets / SOPS is an optional extra.) |
| Postgres | StatefulSet with 1 replica, `volumeClaimTemplates` 10Gi on `local-path`, and ConfigMap `db-init` mounted at `/docker-entrypoint-initdb.d`. These are the same scripts Compose uses. |
| Dashboard RBAC | Role in `bench`: `pods` get/list/watch/delete. `deployments`, `deployments/scale` get/patch. `horizontalpodautoscalers` get/list/patch. `pods.metrics.k8s.io` get/list. Nothing cluster-scoped. |
| Rollouts | `strategy: RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0`, and a `preStop` sleep of 5 s so endpoints are removed before SIGTERM. Both servers must handle SIGTERM gracefully (drain in-flight SSE, with a 20 s grace period). |
| Labels | `app.kubernetes.io/name`, `app.kubernetes.io/part-of: go-benchmarking`, and `bench/target: go|python`. |

### 4.2 Make targets

`registry-up`, `images`, `k8s-sync`, `k8s-secrets`, `k8s-up` (`OVERLAY=dev|bench|scale`, default `dev`), `k8s-down`, `k8s-status`, `k8s-open`, `k8s-logs SVC=…`, `k8s-reset-db` (deletes the PVC), `mode-compose`, `mode-k8s`.

## 5. What Kubernetes adds to the benchmark

| Scenario / dimension | Question it answers |
|---|---|
| **Platform dimension** (any scenario run with `PLATFORM=k8s`) | How much do Service routing (iptables DNAT), the CNI bridge, and CFS limits cost, and does that cost differ between Go and Python? |
| `scale-out` | Under ramping chat-mock load with HPA, how many pods does each need for the same RPS? How fast do they scale, and how fast is a new pod Ready (Go's static binary vs Python's import time)? |
| `rollout-disruption` | During a rolling restart under constant load, how many errors and how big a p99 spike? (This tests graceful shutdown quality.) |
| `cold-start` (k8s variant) | Pod delete → new pod Ready, including image pull from the local registry. |
| Density | Memory requests needed per pod, so how many replicas fit on a node. Uses idle and under-load memory from cgroup metrics. |
| Python process model | Compare `py-1w × N pods` with `py-Nw × 1 pod` for the same total CPU. This is a classic Kubernetes design question for Python. |

## 6. Learning path (labs)

Each lab builds a real piece of this project. In **learning mode** (the default), main Claude runs the k8s agent one lab group at a time and then **stops so you can do the lab yourself**. Read the manifests, run the commands, and do the "break it" exercise. Each lab's notes go in `deploy/k8s/labs/Kn.md`, written by the agent: the commands, expected output, and answers to the check-yourself questions, hidden in `<details>`.

| Lab | You build | Concepts | Try it | Break it on purpose | Check yourself |
|---|---|---|---|---|---|
| **K0 Cluster up** | k3s installed, kubeconfig | Node, control plane, kubelet, namespaces, kubeconfig contexts | `kubectl get nodes -o wide`, `kubectl get pods -A`, `k9s` | `sudo systemctl stop k3s`, then run kubectl. What fails, and what keeps running? | What runs in `kube-system`, and why? |
| **K1 Images** | local registry + `make images` | Image refs, tags vs digests, `imagePullPolicy`, containerd | `sudo k3s crictl images` | Deploy a typo'd tag → `ImagePullBackOff` → `kubectl describe pod` | Why are immutable tags safer than `:latest`? |
| **K2 Postgres** | Secret, ConfigMap, StatefulSet, PVC, headless Service | Stateful vs stateless, PV/PVC/StorageClass, stable pod identity | `kubectl exec -it postgres-0 -- psql -U bench -l` | Delete `postgres-0`. Does the data survive? Then delete the PVC. | Why a StatefulSet, not a Deployment? When would you use an operator (CloudNativePG)? |
| **K3 go-server** | Deployment, Service, probes, initContainer | ReplicaSets, labels and selectors, Service DNS, probe types | `kubectl port-forward svc/go-server 8081:8080`, `curl localhost:8081/v1/info` | Make readiness hit a 404 path. Watch the endpoints empty out (`kubectl get endpointslices`). | Why must liveness not depend on the DB? |
| **K4 fastapi-server** | Deployment with the downward API and a ConfigMap volume | Env from resources, config as volumes, rollout on ConfigMap change | `kubectl exec … -- env | grep PY_WORKERS` | Set the memory limit to 128Mi → `OOMKilled` → `kubectl describe` | Why does ConfigMap-as-env need a restart, but a volume mount doesn't? |
| **K5 Dashboard** | ServiceAccount, Role, RoleBinding, Ingress | RBAC, least privilege, Ingress controllers, port-forward | `kubectl auth can-i delete pods --as=system:serviceaccount:bench:dashboard -n bench`, `make k8s-open` | Remove `delete` from the Role → the cold-start scenario fails with 403 | Why is the Traefik `LoadBalancer` Service `<pending>` with servicelb disabled? |
| **K6 Kustomize** | dev / bench / scale overlays | Bases, overlays, patches, generators, image overrides | `kubectl diff -k deploy/k8s/overlays/bench` | Break a patch target name and read the error | When would you pick Helm instead? |
| **K7 Resources and QoS** | the `bench` overlay | requests vs limits, QoS classes, CFS throttling, OOM | `kubectl get pod -o jsonpath='{.status.qosClass}'`. Watch `bench_cgroup_cpu_throttled_seconds_total` during the `cpu` scenario. | Set CPU limit `500m` on Go and compare RPS and throttling | Why do many teams drop CPU limits but keep memory limits? |
| **K8 Rollouts** | rollout strategy, preStop, graceful shutdown | Rolling updates, maxSurge/maxUnavailable, rollback | `kubectl rollout restart deploy/go-server`, `kubectl rollout undo …`. Run the `rollout-disruption` scenario. | Set `maxUnavailable: 1`, remove preStop, and compare error counts | What happens to an open SSE stream during a rollout? |
| **K9 Autoscaling** | the `scale` overlay with HPA | metrics-server, the HPA algorithm, stabilization windows | `kubectl get hpa -w` during the `scale-out` scenario | Remove CPU requests. The HPA can't compute utilization, so why? | Is CPU the right scaling signal for an LLM-bound service? What would be better (concurrency, queue depth)? |
| K10 *(opt)* NetworkPolicy | default-deny plus allow rules | Pod isolation and enforcement (k3s's kube-router) | `kubectl exec` curl tests between pods | Forget DNS egress and watch everything break | Why does default-deny need an explicit DNS rule? |
| K11 *(opt)* Helm + observability | `kube-prometheus-stack` | Helm charts and values, ServiceMonitor, Grafana | Dashboard for the `bench_*` metrics | — | Helm vs Kustomize trade-offs? |
| K12 *(opt, advanced)* CPU manager | kubelet `cpu-manager-policy=static` | Exclusive cores, Guaranteed pods with integer CPUs | Compare benchmark variance with K7 | — | Why does the static policy only apply to integer-CPU Guaranteed pods? |
| K13 *(opt)* kubeadm | a cluster from scratch (VM or 2nd machine) | Control-plane components, certificates, CNI choice | — | — | What does k3s hide from you? |

**Suggested pacing:** K0–K2 in a first session, K3–K5 in a second, K6–K9 in a third (with benchmarks), then optional labs whenever.

## 7. Kubernetes "done" criteria (gate G4)

- `make mode-k8s OVERLAY=bench` brings everything up Ready, and `make k8s-open` serves the dashboard.
- The dashboard runs side-by-side chat in k8s, the same as in Compose.
- `make bench-smoke` passes with `PLATFORM=k8s`.
- `scale-out`, `rollout-disruption`, and k8s `cold-start` complete and persist.
- Lab notes K0–K9 exist in `deploy/k8s/labs/`.


# 08 — Ubuntu 24.04 Host Setup

The **deployment server** is **Ubuntu 24.04 LTS** on an **AMD Ryzen 5 4600G (6 cores / 12 threads), 16 GB DDR4**. Development happens on the Mac (Docker Desktop, arm64). The Ubuntu box pulls from GitHub, builds its own amd64 images, and runs the stack. Official benchmark numbers come only from the Ubuntu box.

**Accessing the dashboard from the Mac:** all ports stay bound to `127.0.0.1` on the server. Use an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 -L 8080:localhost:8080 <user>@<ubuntu-host>
# Compose: http://localhost:3000   k8s (after `make k8s-open` on the server): http://localhost:8080
```

**Deploy loop:** `git push` on the Mac, then on the server run `git pull && make up-bench` (or `make mode-k8s OVERLAY=bench`).

`scripts/ubuntu-setup.sh` (one-time) and `scripts/ubuntu-tune.sh` (before benchmark sessions) automate everything below. The foundation agent writes them in Phase 0, and you run them.

---

## 1. Hardware guidance

| | Minimum | Recommended |
|---|---|---|
| CPU | 8 threads | 12+ threads (**this box: 12**) |
| RAM | 16 GB (**this box**) | 32 GB |
| Disk | 30 GB free SSD | 60 GB+ NVMe |

The default limits use 10 CPUs: Postgres 2, go-server 2, fastapi-server 2, dashboard/load generator 4. **On a desktop you must also leave about 2 cores for GNOME and the browser** that renders the live charts. On an 8-thread machine, set `SERVER_CPUS=1` and `DASH_CPUS=2` in `.env`. The UI always shows the effective limits.

On a laptop, keep it **plugged in**, because battery mode throttles the CPU and ruins repeatability.

## 2. Install (one-time, `scripts/ubuntu-setup.sh`)

### 2.1 Base tools
```bash
sudo apt update && sudo apt install -y git make curl jq ca-certificates gnupg htop linux-tools-common linux-tools-$(uname -r)
```

### 2.2 Docker Engine (official apt repo)

Use **Docker Engine**, not Docker Desktop for Linux and not the snap:
- Docker Desktop for Linux runs containers inside a VM. That adds a virtualization layer and its own CPU/memory cap, which distorts benchmarks.
- The snap package has confinement quirks with bind mounts and sockets.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # log out and back in
docker run --rm hello-world
```

If Docker Desktop is already installed, check with `docker context ls`. The active context must be `default` (Engine), **not** `desktop-linux`.

### 2.3 Kubernetes tooling (needed from Phase 4, see [07](07-KUBERNETES.md))
```bash
# k3s: config first, then install
sudo mkdir -p /etc/rancher/k3s
sudo cp deploy/k8s/host/k3s-config.yaml   /etc/rancher/k3s/config.yaml
sudo cp deploy/k8s/host/registries.yaml   /etc/rancher/k3s/registries.yaml
curl -sfL https://get.k3s.io | sh -
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown $USER: ~/.kube/config && chmod 600 ~/.kube/config

# kubectl comes with k3s (also as `k3s kubectl`). Extras for learning:
sudo snap install k9s --devmode     # terminal UI; or download the release binary
sudo snap install helm --classic    # optional labs
sudo snap install kustomize         # for `kustomize edit set image`
```

k3s ships its own containerd, so it coexists with Docker Engine. **Don't benchmark both stacks at once.** Use `make mode-compose` / `make mode-k8s` (see §4).

To stop k3s from starting at boot when you're not using it: `sudo systemctl disable --now k3s`. To start it again: `sudo systemctl start k3s`.

### 2.4 Optional editor tooling
Go, Python, and Node are **not** needed on the host, because everything builds in containers. For editor support (gopls, pyright), `sudo snap install go --classic` and `uv` are optional.

### 2.5 Checks
```bash
stat -fc %T /sys/fs/cgroup        # must print cgroup2fs (Ubuntu 24.04 default). The servers read their own cgroup stats.
docker info | grep -E "Cgroup (Driver|Version)"   # systemd / 2
nproc && free -g
```

## 3. Benchmark "quiet mode" (`scripts/ubuntu-tune.sh`)

A desktop is noisy. Run `make tune-host` before a benchmark session. It does the following, and `make untune-host` reverts it:

| Setting | Command | Why |
|---|---|---|
| Power profile | `powerprofilesctl set performance` | Ubuntu 24.04 defaults to *balanced*, which scales the CPU frequency down. |
| No suspend / screen lock during runs | `gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'` plus `systemd-inhibit` around `make bench-*` | A suspend mid-run kills the run. |
| Pause background jobs | `sudo systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer` (`snapd` refresh: `sudo snap refresh --hold=2h`) | Avoids random CPU/disk spikes. |
| Network sysctls | `net.core.somaxconn=65535`, `net.ipv4.ip_local_port_range="1024 65535"`, `net.ipv4.tcp_tw_reuse=1` (persisted in `/etc/sysctl.d/99-bench.conf`) | High-concurrency runs open many sockets. |
| Swap | `sudo swapoff -a` during sessions (optional) | Swapping makes memory results meaningless. |

**Manual checklist (shown in the dashboard's preflight dialog):** close heavy apps (IDE indexing, other browsers, video calls), keep only one dashboard tab open, and don't use the machine during a run. The dashboard's live charts cost some CPU too, so the `bench` profile reserves cores for the desktop (§5).

## 4. Switching between Compose and Kubernetes

| Make target | Does |
|---|---|
| `make mode-compose` | Stops k3s (`sudo systemctl stop k3s` + `k3s-killall.sh`), then `docker compose up -d` |
| `make mode-k8s` | `docker compose down`, starts k3s, `make k8s-up` |

Preflight in every benchmark run (via the dashboard's platform adapter) refuses to start if the *other* stack is active.

### 4600G layout

The 4600G has SMT sibling pairs `(n, n+6)`. Check with `lscpu -e`. The default `scripts/cpu-layout.sh` result gives each server one **full physical core** (both hyperthreads):

| Physical core | CPUs | Owner |
|---|---|---|
| 0 | 0, 6 | OS, sshd, k3s control plane |
| 1 | 1, 7 | postgres |
| 2 | 2, 8 | go-server |
| 3 | 3, 9 | fastapi-server |
| 4–5 | 4, 5, 10, 11 | dashboard / load generator |

Memory budget (16 GB): postgres 2 GB, each server 1 GB, dashboard 2 GB, k3s about 1 GB. The rest goes to the OS and page cache.

## 5. CPU pinning (Linux-only advantage)

On Linux, Docker's `cpuset` gives containers **dedicated cores**. `docker-compose.bench.yml` (used by `make up-bench`) pins them like this on a 12-thread machine:

| Cores | Owner |
|---|---|
| 0–1 | desktop, browser, OS (left unassigned) |
| 2–3 | postgres |
| 4–5 | go-server |
| 6–7 | fastapi-server |
| 8–11 | dashboard / load generator |

`scripts/cpu-layout.sh` generates this from `nproc`, and avoids splitting SMT siblings across owners where possible (it reads `lscpu -e`). The Kubernetes equivalent is the static CPU manager ([07](07-KUBERNETES.md), lab K12).

## 6. Security on a desktop

- Compose ports bind to `127.0.0.1` only. Note that Docker-published ports **bypass `ufw`**, which is why binding to `127.0.0.1` matters.
- In k3s, the bundled `servicelb` is **disabled**, so Traefik doesn't open port 80 to your LAN. You reach the cluster with `make k8s-open` (a `kubectl port-forward` to localhost).
- `.env` holds `GOOGLE_API_KEY`, is git-ignored, and has `chmod 600`.

## 7. Where Claude Code runs

**Decided:** Claude Code runs on the **Mac** for development. The Ubuntu box is deployment-only. On the server:
- Clone this repo to `~/my-projects/go_benchmarking`.
- Clone the ADK reference repos to `~/my-projects/adk_samples` (the docs reference them as `../adk_samples`):
  ```bash
  mkdir -p ~/my-projects/adk_samples && cd ~/my-projects/adk_samples
  for r in adk-samples adk-go adk-python; do git clone --depth 1 https://github.com/google/$r.git; done
  ```
- If you keep developing on the Mac too, sync through a git remote. Images are always rebuilt on Ubuntu (an Apple-Silicon build is arm64, and the Ubuntu box is probably amd64).


# 09 — RAG Pipeline (Gemini embeddings + pgvector, hybrid with full-text search)

Both servers implement the **same** retrieval-augmented generation pipeline:

1. Ingest documents and chunk them deterministically.
2. Embed the chunks with **`gemini-embedding-2`** (768 dimensions).
3. Store chunks and vectors in PostgreSQL (**pgvector**, HNSW index) alongside a full-text `tsvector`.
4. Retrieve with **hybrid search**: vector kNN + full-text, fused with Reciprocal Rank Fusion (RRF).

The SQL lives in shared files under `contracts/sql/`, and **both servers load those files**, so Go and Python execute byte-identical queries. They differ only in chunking code, embedding client, driver, and serialization, which is exactly what we want to compare.

Each server ingests into **its own** DB (`go_app` / `py_app`), consistent with [05](05-DATABASE-SCHEMA.md).

---

## 1. Corpus

- `corpus/` at the repo root holds `.md` and `.txt` files. It's mounted read-only at `/corpus` in both servers. In k8s it comes from ConfigMap `rag-corpus`, generated by `make k8s-sync`. Keep the corpus under 900 KB because of the ConfigMap limit. Larger corpora go through the HTTP ingest API.
- Default content: a copy of this project's `docs/*.md` (`make corpus` refreshes it), so the agents can answer questions about the project itself.
- `corpus/private/` is **git-ignored**. Put your own non-public documents there.
- `source` = path relative to the corpus root (for example `docs/07-KUBERNETES.md`). `title` = the first `# ` heading, or the file name if there isn't one.

## 2. Chunking algorithm (normative, must match in both languages)

Input: the document text. Output: an ordered list of `{chunk_index, heading, content}`.

**Definitions:** *whitespace* means only the ASCII characters `[ \t\n\v\f\r]`. Every *trim* and *split on whitespace* uses this set, not Unicode whitespace. The reference implementation is `contracts/tools/reference.py`. If this text and that file disagree, the file wins.

1. Normalise line endings to `\n`. Strip a UTF-8 BOM.
2. Walk the lines. A line matching `^#{1,6} ` (outside a fenced block) starts a new **section**. Its `heading` is the line text without the leading `#`s and space, trimmed. Text before the first heading has `heading = ""`. Lines inside fenced code blocks (between lines starting with ` ``` `) are never treated as headings. Heading lines aren't part of the section body.
3. Split each section body into **paragraphs** on one or more blank lines (lines that are empty after trimming), except inside fenced code blocks, which stay one paragraph. Trim each paragraph of surrounding whitespace, and drop empty ones.
4. Pack paragraphs greedily into chunks within a section. Join with `"\n\n"`, and start a new chunk when adding the next paragraph would make `len(content) > 1200`. **Length means Unicode code points**: `utf8.RuneCountInString` in Go, `len(str)` in Python.
5. A single paragraph longer than 1200 code points is split on whitespace runs into word-packed pieces of ≤ 1200 code points, joined by a single space. A single word longer than 1200 is hard-split every 1200 code points.
6. Chunks never span sections. A section with no paragraphs produces no chunk.
7. `chunk_index` is 0-based across the whole document.
8. **Embedding input text** = `heading + "\n\n" + content` when the heading is non-empty, otherwise `content`.

`contracts/fixtures/rag-chunking/` contains input files and the expected JSON output. **Both implementations must reproduce these byte-for-byte.** That's a parity test.

## 3. Embedders

| Embedder | Used when | Details |
|---|---|---|
| `gemini` | chat `mode: "gemini"`; ingest when `GOOGLE_API_KEY` is set | Model `GEMINI_EMBED_MODEL` (default `gemini-embedding-2`). `output_dimensionality: 768`. Task type `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for queries, *if the model supports task types. Verify at implementation; if not, omit it in both servers.* Batch up to `EMBED_BATCH_SIZE` (default 100; verify the API limit) texts per request. Retry on 429/5xx with exponential backoff (base 1 s, max 5 tries). **Always L2-normalise** the returned vectors client-side. |
| `mock` | chat `mode: "mock"`; always computed at ingest (free) | A deterministic "hashing trick" bag-of-words vector, 768 dims, defined below. It also sleeps `MOCK_EMBED_DELAY_MS` (default 40) **once per batch call** to simulate network latency. |

**Mock embedding algorithm (normative):**
1. Extract tokens with the regex `[A-Za-z0-9]+` and ASCII-lowercase each token. Non-ASCII characters are separators.
2. For each token, `h = FNV-1a 32-bit(token bytes)`, `idx = h % 768`, `sign = +1 if (h >> 31) == 0 else -1`, then `v[idx] += sign` (float64).
3. L2-normalise (if the norm is 0, return the zero vector). Store as float4.

Parity check: the vectors agree within `1e-6` per component. The mock is lexical, not semantic, but it exercises the exact same code path, index, and SQL as real embeddings.

## 4. Schema (in `app` schema of both app DBs; requires `CREATE EXTENSION vector`)

Postgres image: **`pgvector/pgvector:pg17`**.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE app.rag_documents (
    id            BIGSERIAL   PRIMARY KEY,
    source        TEXT        NOT NULL UNIQUE,
    title         TEXT        NOT NULL,
    content_hash  TEXT        NOT NULL,              -- sha256 hex of normalised text
    char_count    INTEGER     NOT NULL,
    chunk_count   INTEGER     NOT NULL,
    embed_model   TEXT,                              -- gemini model used, NULL if mock-only
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app.rag_chunks (
    id                BIGSERIAL   PRIMARY KEY,
    document_id       BIGINT      NOT NULL REFERENCES app.rag_documents(id) ON DELETE CASCADE,
    chunk_index       INTEGER     NOT NULL,
    heading           TEXT        NOT NULL DEFAULT '',
    content           TEXT        NOT NULL,
    char_count        INTEGER     NOT NULL,
    embedding_gemini  vector(768),                   -- NULL if ingested without an API key
    embedding_mock    vector(768) NOT NULL,
    tsv               tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', heading), 'A') ||
                        setweight(to_tsvector('english', content), 'B')) STORED,
    UNIQUE (document_id, chunk_index)
);
CREATE INDEX rag_chunks_tsv_idx    ON app.rag_chunks USING GIN (tsv);
CREATE INDEX rag_chunks_gemini_idx ON app.rag_chunks USING hnsw (embedding_gemini vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX rag_chunks_mock_idx   ON app.rag_chunks USING hnsw (embedding_mock   vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

Two columns rather than an `embedder` row key, so each query hits its own HNSW index without depending on partial-index predicates and bind parameters.

## 5. Ingestion

`POST /v1/rag/ingest`

```json
{ "corpus": "default" }                                   // every .md/.txt under /corpus (recursive, sorted by path; skips private/ unless "include_private": true)
{ "documents": [ { "source": "notes/a.md", "title": "optional", "content": "..." } ] }
{ "corpus": "default", "repeat": 10, "force": true, "embedders": ["mock"] }   // benchmark mode: sources "r{i}/<path>"
```

`embedders` defaults to `["gemini","mock"]` when `GOOGLE_API_KEY` is set, otherwise `["mock"]`.

For each document:
1. Compute `content_hash`. If the same `source` and hash already exist, skip it (`skipped++`), unless `force`.
2. Chunk (§2) and embed all chunks with each requested embedder (batched).
3. In **one transaction**: upsert `rag_documents` (on `source`), `DELETE FROM app.rag_chunks WHERE document_id = $1`, then insert chunks with **COPY**: Go `pgx.CopyFrom` with `pgvector-go` types registered, Python asyncpg `copy_records_to_table` with `pgvector.asyncpg.register_vector`. If COPY with vectors fails in either language, **both** switch to multi-row `INSERT`. Report this to main Claude so it can align them.

Response:
```json
{ "documents": 9, "skipped": 0, "chunks": 214, "chars": 98120, "embedders": ["gemini","mock"],
  "timings": { "read_ms": 1.2, "chunk_ms": 3.4, "embed_ms": 2310.5, "embed_gemini_ms": 2290.1, "embed_mock_ms": 20.4, "db_ms": 41.0, "total_ms": 2356.1 } }
```

Other endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/rag/chunk` | Dry run: `{content}` → `{chunks:[{chunk_index,heading,content}]}`. No DB, no embedding. |
| POST | `/v1/rag/embed` | `{texts:[…], embedder:"mock"\|"gemini", task:"document"\|"query"}` → `{vectors:[[…]], timings}`. Parity tests and debugging. |
| GET | `/v1/rag/search?q=…&k=5&mode=hybrid\|vector\|fts&embedder=mock\|gemini` | Retrieval only. `?preset=random` picks a query from `contracts/fixtures/rag-queries.json`. Defaults are `mode=hybrid` and `embedder=mock`. |
| GET | `/v1/rag/stats` | `{documents, chunks, chars, gemini_embedded_chunks, last_ingested_at}` |
| DELETE | `/v1/rag/documents` | Wipe the KB (`TRUNCATE app.rag_documents CASCADE`) |

## 6. Retrieval (shared SQL files)

`contracts/sql/rag_search_hybrid.sql`, `rag_search_vector.sql`, and `rag_search_fts.sql`. Each server loads them at startup and replaces the token `{{EMB_COL}}` with `embedding_gemini` or `embedding_mock` (a fixed whitelist, never user input), giving 6 prepared statements. Parameters: `$1` = query vector, `$2` = query text, `$3` = k.

Hybrid (RRF, k_rrf = 60, 40 candidates per arm):

```sql
WITH q AS (
  SELECT $1::vector AS emb,
         replace(plainto_tsquery('english', $2)::text, ' & ', ' | ')::tsquery AS tsq
),
vec AS (
  SELECT id, row_number() OVER (ORDER BY dist, id) AS r
  FROM (SELECT c.id, c.{{EMB_COL}} <=> q.emb AS dist
        FROM app.rag_chunks c, q
        WHERE c.{{EMB_COL}} IS NOT NULL
        ORDER BY c.{{EMB_COL}} <=> q.emb
        LIMIT 40) s
),
fts AS (
  SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS r
  FROM (SELECT c.id, ts_rank_cd(c.tsv, q.tsq) AS rank
        FROM app.rag_chunks c, q
        WHERE q.tsq <> ''::tsquery AND c.tsv @@ q.tsq
        ORDER BY rank DESC, c.id
        LIMIT 40) s
),
fused AS (
  SELECT id, sum(1.0 / (60 + r)) AS score
  FROM (SELECT id, r FROM vec UNION ALL SELECT id, r FROM fts) u
  GROUP BY id
)
SELECT c.id, d.source, d.title, c.heading, c.content, f.score
FROM fused f
JOIN app.rag_chunks c    ON c.id = f.id
JOIN app.rag_documents d ON d.id = c.document_id
ORDER BY f.score DESC, c.id
LIMIT $3;
```

The `vector` and `fts` variants return just that arm (the score is `1 - dist` or `rank`). For `fts`, `$1` is accepted but unused, so the statement signatures stay identical.

- `k` defaults to 5, max 20. In tool responses, content is truncated to 800 code points.
- Search response: `{"query","mode","embedder","results":[{"source","title","heading","content","score"}],"timings":{"embed_ms","db_ms","total_ms"}}`.

## 7. Agent tool

`search_knowledge_base(query: string, top_k: integer = 5)`: embeds the query with the embedder matching the chat mode (Gemini → `gemini`, but fall back to `mock` if `gemini_embedded_chunks = 0`), runs hybrid search, and returns `{results:[{source, heading, content}]}`. The SSE `tool_call` event includes `{"embed_ms","db_ms"}`. The agent instruction (`contracts/agent-spec.md`) tells the model to call the tool for any question about the project, its docs, or the knowledge base, to answer only from the results, and to cite `[source]`.

**Mock LLM branch:** if the user message contains `docs` or `knowledge` (case-insensitive), the mock calls `search_knowledge_base({"query": <user message>, "top_k": 5})`. It then streams `Based on [<top source>]: ` followed by the standard mock tokens.

## 8. Benchmark scenarios added

| ID | Layer | Target | Default load |
|---|---|---|---|
| `rag-chunk` | L1 | POST /v1/rag/chunk with `contracts/fixtures/rag-chunking/large.md` (~200 KB) | c=16, 20 s |
| `rag-embed-mock` | L1 | POST /v1/rag/embed (64 texts, mock), which measures the hashing and float math | c=16, 20 s |
| `rag-search` | L2 | GET /v1/rag/search?preset=random&mode=hybrid&embedder=mock | c=64, 20 s |
| `rag-search-vector` / `rag-search-fts` | L2 | the same with each single arm | c=64, 20 s |
| `rag-ingest` | L2 | POST /v1/rag/ingest `{corpus:"default", repeat:10, force:true, embedders:["mock"]}`, sequential | 5 reps |
| `chat-mock-rag` | L3 | chat stream, mode=mock, "docs" message | c=50, 30 s |
| `rag-ingest-gemini` | L4 | ingest with the gemini embedder, `repeat:1`, force | 1 rep, confirm dialog |

## 9. Dashboard

- The **Knowledge base** drawer (on `/chat`) shows stats for both servers side by side, including how many chunks have Gemini embeddings. It has **Ingest default corpus** (into both, showing Go vs Py timing including `embed_ms`), **Upload files** (.md/.txt, sent to both), and **Test search** (the same query on both, with mode and embedder selectors, showing results and timings side by side).
- On startup, the dashboard backend calls `/v1/rag/stats` on both servers and ingests `{"corpus":"default"}` into any server with 0 documents.
- In chat, `search_knowledge_base` tool calls show the retrieved sources as chips.


# 01 — Product Requirements Document (PRD)

**Project:** Go vs FastAPI ADK Benchmark ("go_benchmarking")
**Owner:** project maintainer
**Status:** v3 — 2026-10-10 (Ubuntu 24.04 deployment server, Kubernetes track, hybrid RAG with Gemini embeddings + pgvector, Gemini 3.5 Flash-Lite)
**Related docs:** [02 Technical Requirements](02-TECHNICAL-REQUIREMENTS.md) · [03 App Flow](03-APP-FLOW.md) · [04 Design Brief](04-DESIGN-BRIEF.md) · [05 Database Schema](05-DATABASE-SCHEMA.md) · [06 Implementation Plan](06-IMPLEMENTATION-PLAN.md) · [07 Kubernetes](07-KUBERNETES.md) · [08 Ubuntu Setup](08-UBUNTU-SETUP.md) · [09 RAG](09-RAG.md)

---

## 1. Problem

Future projects will be AI-agent backends built on Google's Agent Development Kit (ADK) talking to Gemini. ADK exists for both **Python** (with a built-in FastAPI server) and **Go**. We don't know:

- How much faster or cheaper Go actually is for this kind of workload.
- Where the gains show up: latency, throughput, memory, cold start, or nowhere that matters.
- Whether a hybrid makes sense, such as a Go edge/API layer with Python agents or the other way round.

Opinions and generic web-framework benchmarks don't answer this. We need numbers from **our own workload shape**: agent chat, tool calls, Postgres-backed sessions, and streaming.

## 2. Goal

Build a local, Docker-based test bench that runs a **Go ADK server** and a **FastAPI ADK server** side by side, under identical conditions, against the same PostgreSQL instance. A **dashboard** lets us:

1. Chat with Gemini through both servers at once and watch them respond side by side.
2. See live performance and resource usage for each server.
3. Run repeatable load benchmarks and compare the results over time.

The output is a **decision**: Go, FastAPI, or both, for which kinds of future project, backed by data.

**Secondary goal: learn Kubernetes.** The same stack is also deployed to a single-node **k3s** cluster on the Ubuntu machine, built step by step through hands-on labs ([07](07-KUBERNETES.md)). This also answers a practical question: does Go's advantage change once both run as pods (density, scale-out, rollout behaviour)?

## 3. Non-goals

- Production hardening, auth, multi-tenancy, or public exposure. Everything runs on one Ubuntu 24.04 desktop machine and is used through `localhost`.
- Multi-node Kubernetes. The cluster is single-node k3s; kubeadm and multi-node are optional labs only.
- Benchmarking Gemini itself. Model latency is treated as an external constant, and we isolate it out (see §6).
- Comparing every Python server stack (Litestar, Django, and so on). FastAPI on Uvicorn is the Python candidate.
- A polished end-user chat product. The chat exists to drive and observe the servers.

## 4. Users

| User | Need |
|---|---|
| **Primary: you (tech lead / decision-maker)** | Clear side-by-side evidence to choose a stack for future projects. |
| **Secondary: Claude subagents (builders)** | Unambiguous contracts and acceptance criteria to implement each container independently. |
| **Tertiary: teammates / stakeholders** | An exportable report that explains the recommendation. |

## 5. System overview (4 containers)

| # | Container | Purpose |
|---|---|---|
| 1 | `dashboard` | Web UI with side-by-side chat, live metrics, and the benchmark runner and history. It also runs the load generator and stores benchmark results. |
| 2 | `go-server` | ADK-Go agent behind an HTTP API that implements the shared contract. |
| 3 | `fastapi-server` | ADK-Python agent behind FastAPI that implements the **same** contract. ADK's built-in FastAPI app is mounted as well. |
| 4 | `postgres` | One PostgreSQL 17 instance with separate databases for each server and for the dashboard. |

**Host and deployment modes:** everything runs on **Ubuntu 24.04 LTS (desktop)** with Docker Engine. The same four images run in two modes:
- **Docker Compose:** the fast dev loop and the baseline numbers.
- **Kubernetes (k3s):** for learning, plus scale-out and rollout scenarios.

Only one mode runs at a time.

## 6. Key product insight: measure the right thing

A Gemini call takes roughly 300 ms to several seconds. Framework overhead is usually **under a few ms**. A naive "chat speed" comparison would show mostly noise. So the bench measures four layers:

| Layer | What it isolates | How |
|---|---|---|
| **L1: Raw runtime** | HTTP, JSON, and CPU throughput of Go vs Python | `/bench/*` endpoints, no LLM |
| **L2: DB path** | Driver, pool, and async efficiency against Postgres | `/bench/db/*` endpoints |
| **L3: Agent overhead** | ADK runner, session persistence, event streaming, and tool dispatch, **without** network LLM variance | Chat with a **mock LLM** (deterministic fake model, same token stream and delays in both) |
| **L4: Real end-to-end** | What a user actually feels | Chat with real Gemini, low concurrency, interleaved A/B requests |

Every chat response reports **server overhead = total server time − upstream model time**. That is the number that differs between Go and Python.

## 7. Functional requirements

### 7.1 Side-by-side chat (P0)
- FR-1: A single input box sends the same message to both servers at the same moment.
- FR-2: The responses stream token by token (SSE) into two panes, Go on the left and FastAPI on the right.
- FR-3: Each message shows TTFT (time to first token), total time, model time, server overhead, token count, and tool calls made.
- FR-4: There's a toggle between **Gemini** and **Mock LLM** modes.
- FR-5: Conversation sessions persist in Postgres through each ADK's session service, so a page reload restores history.
- FR-6: The agent has at least two tools, identical in both servers. One of them queries Postgres, so tool-calling and DB access inside the agent loop get exercised.
- FR-7: You can target one server only, or both (the default).
- FR-7a: **RAG:** both agents answer knowledge questions through a `search_knowledge_base` tool backed by a shared-spec ingestion and retrieval pipeline in PostgreSQL: `gemini-embedding-2` vectors in pgvector, hybrid with full-text search through RRF. Both servers implement ingestion (deterministic chunking, embedding, COPY) and retrieval with identical shared SQL ([09](09-RAG.md)).
- FR-7b: The dashboard has a Knowledge-base panel: ingest the default corpus, upload files, and run a test search side by side.

### 7.2 Live monitoring (P0)
- FR-8: Live CPU %, memory (RSS), network I/O, and process/thread or goroutine counts for each server, refreshed every 1 s.
- FR-9: Live request rate, error rate, and p50/p95/p99 latency per server, from each server's `/metrics`.
- FR-10: A health indicator for each container, including Postgres.

### 7.3 Benchmark runner (P0)
- FR-11: Choose a scenario (see [02 §6](02-TECHNICAL-REQUIREMENTS.md#6-benchmark-scenarios)), target(s), concurrency, duration or request count, and warm-up.
- FR-12: Targets run **sequentially**, never at the same time, so they don't compete for host CPU. Order alternates between runs (Go→Py, then Py→Go).
- FR-13: Live progress: current RPS, latency, and errors.
- FR-14: Results include RPS, latency percentiles (p50/p90/p95/p99/max), error %, CPU and memory peak and average, and **RPS per CPU core** and **RPS per 100 MB**.
- FR-15: All runs persist to Postgres, including the environment snapshot (git SHA, versions, limits).

### 7.4 History and comparison (P1)
- FR-16: List all past runs with filters by scenario and date.
- FR-17: Pick any two runs, or a Go/Py pair, and compare them with charts and deltas (for example, "Go +312% RPS, −71% p99, −84% memory").
- FR-18: Export a run or comparison as JSON, CSV, and a Markdown report.

### 7.5 Static characteristics (P1)
- FR-19: Show image size, cold-start time (container start → first healthy response), idle memory, and dependency count for each server.
- FR-20: A manual "developer-experience notes" field per server (LOC, build time, pain points). This feeds the final decision.

### 7.6 Kubernetes (P1)
- FR-21: `make mode-k8s` deploys the whole stack to k3s with Kustomize overlays (`dev`, `bench`, `scale`), and the dashboard works there the same as in Compose.
- FR-22: Every run records its **platform** (`compose` / `k8s`). The same scenario can be compared across platforms.
- FR-23: A `scale-out` scenario: HPA-driven, it measures pods needed for a target RPS, time to scale, and pod time-to-Ready.
- FR-24: A `rollout-disruption` scenario: a rolling restart under constant load, measuring errors and the p99 spike.
- FR-25: The dashboard talks to Docker or Kubernetes only through a **platform adapter**, so scenario code is platform-agnostic.
- FR-26: Lab notes (K0–K9) live in the repo next to the manifests they teach.

## 8. Non-functional requirements

- NFR-1 **Fairness:** identical CPU/memory limits, Postgres pool sizes, model, prompts, temperature, and tool definitions for both servers. Any deviation is shown in the UI.
- NFR-2 **Reproducibility:** `docker compose up` plus one `.env` file (only `GOOGLE_API_KEY` required) brings everything up. Runs record full config.
- NFR-3 **Measurement accuracy:** the load generator's own overhead must not bottleneck the test. The dashboard must flag a run as *suspect* if the dashboard container's CPU exceeds 85%.
- NFR-4 **Cost safety:** Gemini-mode load tests are capped (default max 50 requests per run, concurrency ≤ 5) and need an explicit confirmation. Mock mode is the default for load tests.
- NFR-5 **Target host:** Ubuntu 24.04 LTS desktop (x86_64 primary, arm64 supported) with Docker Engine (not Docker Desktop) and k3s. Official numbers come only from this host, run in "quiet mode" ([08 §3](08-UBUNTU-SETUP.md#3-benchmark-quiet-mode-scriptsubuntu-tunesh)). A Mac is fine for development.
- NFR-6 **Local only:** Compose ports bind to `127.0.0.1`. In k3s, servicelb is disabled and access goes through `kubectl port-forward`, so nothing is exposed to the LAN.

## 9. Success metrics (for the project itself)

- All four containers start healthy with one command in under 2 minutes on a cold build cache.
- The same prompt produces a visible side-by-side streamed response with full timing breakdown.
- Repeated runs of each scenario (3 repetitions) agree within ±10% RPS variance.
- `make mode-k8s` brings the same stack up Ready on k3s, and labs K0–K9 are completed.
- A final **Decision Report** is produced (see §10).

## 10. Deliverable: Decision Report

At the end, the dashboard exports a report answering:

1. How much faster or leaner is Go at each layer (L1–L4), with numbers?
2. Does the difference matter at our expected scale? (For example, "At 50 concurrent chat users, both are bound by Gemini; Go saves X MB RAM and Y% CPU.")
3. **Recommendation matrix:**

| Project type | Recommendation |
|---|---|
| Thin agent API, LLM-bound, small team | _filled from data_ |
| High-concurrency gateway / streaming fan-out | _filled from data_ |
| Data/ML-heavy agents needing the Python ecosystem | _filled from data_ |
| Hybrid: Go gateway + Python agent workers | _filled from data_ |

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| ADK-Go and ADK-Python feature parity differs (APIs, session schemas, streaming semantics). | Use a **custom shared contract** (`/v1/*`) that both implement on top of their ADK runner, and document any parity gaps in the UI. |
| ADK-Go is younger and its APIs move. The `session/database` package location has shifted between v2 minors. | Pin exact versions in `go.mod` and verify against pkg.go.dev at implementation time. |
| Gemini rate limits or quotas distort L4 results. | Interleave A/B requests, keep concurrency low, record HTTP 429s separately, and do the heavy load in mock mode. |
| The host machine is shared with other apps, which adds noise. | Run 3 repetitions, report the median, and use a "quiet mode" checklist in the UI. |
| Desktop noise (GNOME, browser, background updates) on the bench host. | Quiet-mode script, CPU pinning (`cpuset`) that leaves cores for the desktop, and the suspect flag. |
| Kubernetes overhead (Service routing, CFS throttling) gets mistaken for a language difference. | Record the platform per run, compare like with like, use Guaranteed QoS, and track the throttling metric. |
| Compose and k3s run at once and skew results. | `make mode-compose` / `make mode-k8s` stop the other stack, and preflight refuses to run if both are active. |
| Python is under-configured, which makes the comparison unfair. | Python runs with `uvloop`, `httptools`, `orjson`, workers = CPU limit, and asyncpg. Go uses the stdlib plus pgx. Both are "reasonable production defaults", not hand-tuned extremes. |

## 12. Open questions

1. ~~Gemini model~~ **Decided:** `gemini-3.5-flash-lite` (GA), configurable via `GEMINI_MODEL`, and recorded per run.
2. **Python workers:** a single worker (simplest, like the default `adk api_server`) or workers = CPU count? *Default: run both variants as separate profiles (`py-1w`, `py-Nw`) because that's a real-world question.*
3. Should a future phase add a **hybrid** container (a Go gateway proxying to Python ADK) to test option 3 directly? *Proposed as Phase 7 (optional).*
4. ~~Ubuntu specs~~ **Decided:** Ryzen 5 4600G (6C/12T), 16 GB DDR4, used as the deployment server. Development happens on the Mac.
5. ~~Kubernetes pacing~~ **Decided:** build everything at once (fast mode). The labs are for self-study afterwards.
6. ~~Embeddings~~ **Decided:** `gemini-embedding-2` (768 dimensions) in pgvector, hybrid with full-text search. Mock mode uses a deterministic local embedder.


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


# 03 — App Flow

## 1. Startup flow

```
make up  (docker compose up --build -d)
  │
  ├─ postgres starts → runs db/init/*.sql (first boot only)
  │     creates DBs go_app, py_app, dashboard → app schema + seed (100k bench_items) → dashboard schema
  │     healthcheck: pg_isready
  │
  ├─ go-server & fastapi-server (wait for postgres healthy)
  │     load config → open DB pools → init ADK session service (auto-migrate ADK tables)
  │     → build bench_agent (Gemini model + mock model) → start HTTP :8080
  │     healthcheck: GET /healthz
  │
  └─ dashboard (waits for both servers healthy)
        connect dashboard DB → read docker socket → serve SPA + /api on :3000
        user opens http://localhost:3000
```

### 1.1 Kubernetes mode (`make mode-k8s OVERLAY=bench`)

```
make mode-k8s
  ├─ docker compose down; systemctl start k3s
  ├─ make registry-up && make images      → localhost:5000/<svc>:<git-sha>
  ├─ make k8s-sync && make k8s-secrets    → generated/ ConfigMap sources, Secret gemini from .env
  └─ kubectl apply -k deploy/k8s/overlays/<overlay>
        ├─ Namespace bench, Secrets, ConfigMaps (db-init, agent-spec)
        ├─ StatefulSet postgres → PVC (local-path) → init scripts on first boot → Ready
        ├─ Deployments go-server, fastapi-server: initContainer waits for postgres → startupProbe → readinessProbe → Ready
        └─ Deployment dashboard (ServiceAccount + Role, PLATFORM=k8s) → Service → Ingress (Traefik)
make k8s-open → port-forward Traefik to localhost:8080 → http://localhost:8080
```

## 2. Screen map

```
┌ Top bar: [Chat] [Live] [Benchmarks] [History] [Compare]   ● go ● py ● db   mode: Mock|Gemini
│
├─ /chat        Side-by-side chat (default landing page)
├─ /live        Real-time resource and request monitor
├─ /bench       Benchmark runner (configure → run → results)
├─ /history     Runs list
├─ /compare     Pick 2 runs (or a Go/Py pair) → deltas + charts
└─ /about       Environment: platform (Compose / k8s: node, pods, QoS), versions, limits, static characteristics, DX notes
```

## 3. Flow A: side-by-side chat

```
User types "What's our electronics inventory?"  [mode: Gemini]  [targets: both]
  │
  ▼
SPA  POST /api/chat {message, mode, targets, conversation_id}
  │
  ▼
Dashboard API
  ├─ if no session per target yet: POST /v1/sessions on each server (in parallel)
  ├─ t0 = now; open POST /v1/chat/stream to go-server AND fastapi-server simultaneously
  ├─ relay each upstream SSE event to the browser, tagged {target}
  │     records client_ttft_ms on first `token`, client_total_ms on `done`
  └─ on both `done` → persist chat_turns rows → emit `turn_complete` summary
  │
  ▼
SPA
  ├─ left pane (Go) and right pane (Py) stream tokens independently
  ├─ tool_call events render as collapsible chips ("🔧 get_inventory_stats · 3.1 ms")
  └─ under each reply: metric strip
        TTFT 412ms │ Total 1.83s │ Model 1.79s │ Overhead 4.2ms │ 128 tok
     and a "winner" marker on the lower overhead / TTFT
```

**Inside each server (both implement this same sequence):**

```
POST /v1/chat/stream
  → validate → start timer → write `meta`
  → runner.Run(user_id, session_id, message)       [ADK]
       ├─ session service loads session (Postgres)        ← session_ms
       ├─ model.generate (timed decorator)                ← model_ms
       │     └─ if function_call → tool executes (pgx/asyncpg) ← tool_ms
       │         → model.generate again
       ├─ partial events → `token` SSE
       └─ session service appends events (Postgres)       ← session_ms
  → compute overhead_ms → write `done` → close
```

RAG path (a question about the docs or knowledge base):

```
model → function_call search_knowledge_base(query)
  → server embeds the query (gemini or mock) → hybrid SQL (09 §6) on its own DB → tool response {results:[{source,heading,content}]}
  → SSE `tool_call` event (UI shows source chips) → model answers citing [source]
```

Knowledge-base startup: the dashboard calls `/v1/rag/stats` on both servers, and any server with 0 documents gets `POST /v1/rag/ingest {corpus:"default"}`.

Edge cases:
- If one server errors, its pane shows an error card with the code. The other pane continues.
- A Gemini 429 shows the code `UPSTREAM_429` with a "rate limited, try Mock mode" hint.
- "New conversation" creates new sessions on both servers.
- On reload, the SPA fetches `/api/conversations/:id` and rebuilds the panes from the dashboard DB. Each server's own history is also available via `GET /v1/sessions/{id}`.

## 4. Flow B: live monitor

```
SPA opens /live → GET /api/live (SSE, 1 Hz)
Dashboard every 1 s:
  docker stats (go-server, fastapi-server, postgres, dashboard)
  every 2 s: scrape /metrics from both servers → compute RPS, error %, p50/p95/p99 from histogram deltas
→ push {ts, go:{cpu,mem,net,threads,rps,p99,…}, python:{…}, postgres:{…}, dashboard:{cpu}}
SPA keeps a rolling 5-minute window in memory and renders paired sparklines/charts
```

Live works at all times. It's most informative while a benchmark or chat is running.

## 5. Flow C: run a benchmark

```
/bench
 1. Pick scenario (cards grouped L1 / L2 / L3 / L4 / Static)
 2. Form prefilled from /api/scenarios: targets, concurrency, duration, reps, warm-up, profile (py-1w / py-Nw)
    └─ L4 (Gemini): show cost/rate-limit confirm dialog, caps enforced
 3. [Run] → POST /api/runs → 201 {run_id}  (409 if another run is active → show "run in progress" link)
 4. Navigate to /bench/:run_id → GET /api/runs/:id/stream
       phases: preflight → warmup(A) → run(A) → cooldown → warmup(B) → run(B) → … reps … → analyze
       live: progress bar, current RPS, latency, errors, per-target CPU/mem
 5. Analyze: compute stats, flags (suspect?), persist → `complete` event
 6. Results view:
       headline deltas  (e.g., "Go: 4.1× RPS · p99 −68% · mem −82%")
       percentile table, latency histogram (overlay), RPS-over-time, CPU/mem-over-time
       buttons: Export JSON/CSV/MD · Compare with… · Re-run
```

Kubernetes-only scenarios (greyed out in Compose mode):

```
scale-out:          set HPA on A → ramp VUs → record replicas / RPS / p99 each second → reset to 1 replica → repeat for B
rollout-disruption: constant load on A → platform.rollout(A) at t=15 s → continue until new pods Ready + 10 s
                    → count errors, p99 spike, time-to-complete → repeat for B
```

Orchestrator state machine:

```
queued → preflight → running(rep i, target X, phase) → analyzing → complete
                 ↘ failed (preflight/health)         ↘ cancelled (user)
```

## 6. Flow D: history and compare

```
/history → GET /api/runs?scenario=&from=  → table (date, scenario, targets, headline delta, suspect flag)
  select row → /bench/:run_id (results view)
  select 2 rows → /compare?a=&b=

/compare → GET /api/compare → side-by-side tables + overlaid charts + delta badges
          → Export MD (feeds the Decision Report)
```

## 7. Flow E: decision report

```
/about → "Generate Decision Report"
  dashboard collects the latest non-suspect run per scenario (both targets)
  + static characteristics + DX notes
  → renders Markdown (docs/report template) → download / save to ./reports/ (bind mount)
```


# 04 — Design Brief (Dashboard)

## 1. Purpose and tone

This is an engineer's instrument panel, not a marketing site. It should feel like a precise lab tool: dense but calm, numbers first, and every comparison readable at a glance. One question drives every screen: **"Which side is better here, and by how much?"**

## 2. Principles

1. **Always paired.** Go and Python appear in fixed positions everywhere: **Go on the left, Python on the right**, and in that order in tables and legends.
2. **Deltas over raw values.** Every comparison shows the delta and ratio, for example "−68% p99" or "4.1× RPS", with the better side highlighted.
3. **Honest data.** Show sample size, reps, variance, and suspect flags. Never hide errors.
4. **Separate model time from server time.** Timing strips always split *model* from *overhead* visually, so Gemini latency never gets mistaken for server speed.
5. **Calm by default.** Motion only for streaming text and live charts.

## 3. Visual identity

| Token | Light | Dark (default) | Use |
|---|---|---|---|
| `--bg` | `#F7F8FA` | `#0E1116` | page |
| `--surface` | `#FFFFFF` | `#161B22` | cards / panes |
| `--border` | `#E3E6EB` | `#2A313C` | dividers |
| `--text` | `#14171C` | `#E6EAF0` | primary text |
| `--muted` | `#5B6472` | `#8B95A5` | labels |
| `--go` | `#0B7FAB` | `#3FB6E0` | Go series (Go-brand cyan family) |
| `--py` | `#B8860B` | `#F2C14E` | Python series (Python-yellow family) |
| `--better` | `#1A7F37` | `#3FB950` | winning delta |
| `--worse` | `#C93C37` | `#F85149` | losing delta |
| `--model` | `#8250DF` | `#A371F7` | model-time segment in timing bars |

- **Typography:** Inter for the UI and JetBrains Mono for all numbers, code, and IDs. Numbers use `font-variant-numeric: tabular-nums`.
- **Density:** 4 px spacing grid. Cards are 12 px radius with 1 px border and no heavy shadows.
- **Icons:** Lucide.
- The Go/Py colours are chosen to stay distinguishable for colour-blind users (blue vs yellow). Every series is also labelled with text, never colour alone.

## 4. Key screens

### 4.1 Chat (`/chat`), the landing page

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [Mode: (•) Mock  ( ) Gemini]   Targets: [x] Go [x] Python   [New chat]  │
├───────────────────────────────────┬──────────────────────────────────────┤
│  GO  · adk-go v2.5 · net/http     │  PYTHON · google-adk 2.x · FastAPI   │
│                                   │                                      │
│  👤 What's our electronics stock? │  👤 What's our electronics stock?   │
│  🔧 get_inventory_stats  3.1 ms   │  🔧 get_inventory_stats  5.8 ms     │
│  🤖 Electronics has 12,412 items… │  🤖 Electronics has 12,412 items…   │
│  ┌ timing bar ───────────────┐    │  ┌ timing bar ───────────────┐      │
│  │███████████████████▌ ░     │    │  │███████████████████▌ ░░    │      │
│  └ model 1.79s  overhead 4ms ┘    │  └ model 1.81s  overhead 19ms┘      │
│  TTFT 412ms · total 1.83s · ✓     │  TTFT 431ms · total 1.86s           │
├───────────────────────────────────┴──────────────────────────────────────┤
│  [ Type a message…                                         ] [Send ⏎]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- The timing bar is a stacked horizontal bar: model (purple), tool, session/db, overhead. Hovering shows exact ms.
- A conversation summary in the footer gives the average overhead and TTFT per side across the conversation.
- A **Knowledge base** drawer (right edge, collapsible) shows doc, chunk, and Gemini-embedded chunk counts per side, an "Ingest default corpus" button with Go vs Py ingest timings, file upload, and a test-search box showing both result lists side by side with mode (hybrid / vector / fts) and embedder selectors, plus `embed_ms` and `db_ms`.
- `search_knowledge_base` tool chips list the retrieved sources (`docs/07-KUBERNETES.md › Probes`).

### 4.2 Live (`/live`)
- A 2-column grid of paired mini-charts (Go | Py): CPU %, Memory MB, RPS, p99 ms, threads/goroutines.
- A Postgres row below: connections, CPU, memory.
- A dashboard-health chip warns when the load generator's CPU is above 85%.

### 4.3 Benchmarks (`/bench`)
- Scenario cards grouped by layer (L1 Runtime, L2 Database, L3 Agent/mock, L4 Gemini, Static). Each card has a one-line explanation of *what it isolates*.
- A config drawer appears when you pick a card. Advanced fields (warm-up, reps, profile) start collapsed.
- **Running:** a phase stepper, a big live RPS number per side, and live latency and CPU charts.
- **Results:** a headline delta banner, then a percentile table (p50/p90/p95/p99/max, both sides plus a delta column), an overlaid latency histogram (log-x), RPS over time, CPU/mem over time, and derived metrics (RPS/core, RPS/100 MB).

### 4.4 History and Compare
- History is a dense sortable table with a suspect-flag icon and checkboxes. Selecting 2 enables **Compare**.
- Compare shows a two-column summary, delta badges, and overlaid charts. It also works **across platforms** (same scenario, Compose vs k8s), and each run carries a platform badge (`🐳 compose` / `⎈ k8s`).

### 4.5 About / Environment
- A platform panel. In k8s it shows the node, pods per target with status, restarts, QoS class, and HPA state.
- A versions table, resource limits, image size, cold start, idle memory, and dependency count.
- A DX notes editor per server (Markdown), saved to the DB.
- **Generate Decision Report.**

## 5. Components (build once, reuse)

`TargetBadge`, `PlatformBadge`, `DeltaBadge(value, betterWhen: "lower"|"higher")`, `TimingBar`, `MetricStrip`, `PairedChart`, `PercentileTable`, `ScenarioCard`, `RunPhaseStepper`, `HealthDot`, `SuspectFlag`, `StreamPane`.

## 6. States

- **Empty:** for example, "No runs yet. Start with *ping*, the 20-second smoke test."
- **Loading:** skeletons, never spinners on full pages.
- **Error:** an inline card with the error code and target. Errors on one side never blank the other side.
- **Offline target:** grey the pane, show a health dot and a "Retry" button. In k8s, show the pod status (for example `CrashLoopBackOff`, `ImagePullBackOff`) with a hint to run `kubectl describe`. That's handy during the labs.
- **Run preflight:** a quiet-mode checklist dialog (close heavy apps, power profile on performance) before every official run.

## 7. Accessibility and responsiveness

- WCAG AA contrast in both themes, full keyboard support for chat and the run controls, and `aria-live="polite"` on streaming panes.
- The primary target is ≥ 1280 px desktop. Below 900 px, the chat panes stack (Go first) and charts go single-column.


# 05 — Database Schema

One PostgreSQL 17 container with **three databases**:

| Database | Owner/user | Used by | Contains |
|---|---|---|---|
| `go_app` | `bench` | go-server | ADK-Go session tables (auto-managed) and the `app` schema (bench + tool data) |
| `py_app` | `bench` | fastapi-server | ADK-Python session tables (auto-managed) and the **identical** `app` schema |
| `dashboard` | `bench` | dashboard | conversations, benchmark runs, samples, and environment snapshots |

**Why separate app DBs instead of one shared DB?**
1. ADK-Go and ADK-Python create **their own, different session table schemas** (their names and columns can collide, for example `sessions`, `events`, `app_states`, `user_states`). Separate DBs avoid conflicts.
2. Writes from one server's benchmark can't bloat or lock the other's tables. Both DBs are seeded identically, so the comparison stays fair.
3. It mirrors reality: each service owns its database.

Both servers still share **one Postgres process** (as requested), so they compete equally for the same DB engine. That's why targets are benchmarked sequentially, never at the same time.

---

## 1. Bootstrap: `db/init/00-create-databases.sql`

```sql
-- runs once on first container boot (as POSTGRES_USER=bench)
CREATE DATABASE go_app;
CREATE DATABASE py_app;
CREATE DATABASE dashboard;
```

The same `db/init/` files are used in both modes. Compose bind-mounts them, and k8s mounts them from the `db-init` ConfigMap. So scripts must not reference paths outside `/docker-entrypoint-initdb.d`.

`db/init/05-apply.sh` runs `10-app-schema.sql` and `30-seed.sql` against **both** `go_app` and `py_app`, and `20-dashboard-schema.sql` against `dashboard`, using `psql -v ON_ERROR_STOP=1 -d <db> -f …`.

Postgres tuning (`command:` in compose): `-c shared_buffers=512MB -c max_connections=200 -c synchronous_commit=on -c random_page_cost=1.1`.

---

## 2. App schema (identical in `go_app` and `py_app`): `db/init/10-app-schema.sql`

```sql
CREATE SCHEMA IF NOT EXISTS app;

-- Read workload + agent tool data (100k deterministic rows)
CREATE TABLE app.bench_items (
    id          INTEGER      PRIMARY KEY,
    sku         TEXT         NOT NULL UNIQUE,
    name        TEXT         NOT NULL,
    category    TEXT         NOT NULL,          -- 10 categories: electronics, books, toys, …
    price       NUMERIC(10,2) NOT NULL,
    stock       INTEGER      NOT NULL,
    attributes  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX bench_items_category_idx ON app.bench_items (category);

-- Write workload (dashboard truncates it directly before each db-write run)
-- RAG tables: app.rag_documents, app.rag_chunks (pgvector HNSW x2 + tsvector GIN). Full DDL in docs/09-RAG.md §4.
-- Requires CREATE EXTENSION vector (image pgvector/pgvector:pg17).

CREATE TABLE app.bench_writes (
    id          BIGSERIAL    PRIMARY KEY,
    payload     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Seed (`30-seed.sql`) is deterministic, so both DBs hold byte-identical data:

```sql
INSERT INTO app.bench_items (id, sku, name, category, price, stock, attributes)
SELECT g,
       'SKU-' || lpad(g::text, 6, '0'),
       'Item ' || g,
       (ARRAY['electronics','books','toys','home','garden','sports','beauty','food','auto','office'])[1 + (g % 10)],
       round(((g * 7919) % 100000) / 100.0 + 1, 2),
       (g * 31) % 500,
       jsonb_build_object('color', (ARRAY['red','green','blue','black'])[1 + (g % 4)], 'weight_g', (g * 13) % 5000)
FROM generate_series(1, 100000) AS g;
ANALYZE app.bench_items;
```

The servers connect with `search_path=app,public`, so bench SQL can use unqualified names. ADK session tables live in `public`.

### 2.1 ADK-managed session tables (do not hand-write)

| Server | Created by | Expected tables (verify at implementation) |
|---|---|---|
| go-server | `session/database` (GORM) `AutoMigrate` at startup | `sessions`, `events`, `app_states`, `user_states` (GORM naming) |
| fastapi-server | `DatabaseSessionService` (SQLAlchemy) `create_all` at startup | `sessions`, `events`, `app_states`, `user_states` |

These schemas belong to ADK and can change between ADK versions. **No application code may query them directly.** History goes through the ADK session service API (`GET /v1/sessions/{id}`). After implementation, record the actual DDL (`pg_dump -s`) in `docs/appendix-adk-session-ddl.md` for reference.

---

## 3. Dashboard schema: `db/init/20-dashboard-schema.sql`

```sql
CREATE TYPE target_impl  AS ENUM ('go', 'python');
CREATE TYPE run_status   AS ENUM ('queued','preflight','running','analyzing','complete','failed','cancelled');
CREATE TYPE chat_mode    AS ENUM ('gemini','mock');

-- ── Side-by-side chat ─────────────────────────────────────────────
CREATE TABLE conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT,
    mode          chat_mode   NOT NULL,
    go_session_id TEXT,                     -- session id on go-server
    py_session_id TEXT,                     -- session id on fastapi-server
    user_id       TEXT        NOT NULL DEFAULT 'dashboard-user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_turns (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_index       INTEGER     NOT NULL,
    target           target_impl NOT NULL,
    request_id       UUID        NOT NULL,
    user_message     TEXT        NOT NULL,
    reply_text       TEXT,
    tool_calls       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{name,args,duration_ms}]
    status           TEXT        NOT NULL,                       -- ok | error
    error_code       TEXT,
    -- server-reported timings (from `done` event)
    server_total_ms  DOUBLE PRECISION,
    model_ms         DOUBLE PRECISION,
    tool_ms          DOUBLE PRECISION,
    session_ms       DOUBLE PRECISION,
    overhead_ms      DOUBLE PRECISION,
    server_ttft_ms   DOUBLE PRECISION,
    -- client-measured (dashboard)
    client_ttft_ms   DOUBLE PRECISION,
    client_total_ms  DOUBLE PRECISION,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, turn_index, target)
);

-- ── Environment snapshot (one per run; dedupe by hash) ────────────
CREATE TABLE environments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hash          TEXT        NOT NULL UNIQUE,     -- sha256 of the json below
    platform      TEXT        NOT NULL,            -- compose | k8s
    git_sha       TEXT,
    host_info     JSONB       NOT NULL,            -- Ubuntu version, kernel, arch, nproc, RAM, power profile; k8s: k3s version, node, overlay
    go_info       JSONB       NOT NULL,            -- /v1/info + container limits + image size
    py_info       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Benchmark runs ────────────────────────────────────────────────
CREATE TABLE benchmark_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario        TEXT        NOT NULL,          -- ping | json | cpu | sleep-io | db-read | … | chat-gemini | cold-start | scale-out | rollout-disruption
    layer           TEXT        NOT NULL,          -- L1 | L2 | L3 | L4 | static | k8s
    platform        TEXT        NOT NULL,          -- compose | k8s (denormalised for filtering)
    config          JSONB       NOT NULL,          -- {concurrency, duration_s, warmup_s, reps, targets, py_profile, mode, …}
    status          run_status  NOT NULL DEFAULT 'queued',
    environment_id  UUID        REFERENCES environments(id),
    suspect         BOOLEAN     NOT NULL DEFAULT false,
    suspect_reasons TEXT[]      NOT NULL DEFAULT '{}',
    notes           TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_runs_scenario_created_idx ON benchmark_runs (scenario, platform, created_at DESC);
-- Only one active run at a time (FR-12 / 409 busy)
CREATE UNIQUE INDEX benchmark_runs_one_active
    ON benchmark_runs ((true)) WHERE status IN ('queued','preflight','running','analyzing');

-- One row per (run, target, repetition)
CREATE TABLE run_results (
    id              BIGSERIAL PRIMARY KEY,
    run_id          UUID        NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target          target_impl NOT NULL,
    rep             SMALLINT    NOT NULL,
    order_in_rep    SMALLINT    NOT NULL,          -- 1 = ran first, 2 = ran second
    requests_total  BIGINT      NOT NULL,
    errors_total    BIGINT      NOT NULL,
    status_counts   JSONB       NOT NULL,          -- {"200": 123, "429": 2}
    duration_s      DOUBLE PRECISION NOT NULL,
    rps             DOUBLE PRECISION NOT NULL,
    lat_p50_ms      DOUBLE PRECISION, lat_p90_ms DOUBLE PRECISION,
    lat_p95_ms      DOUBLE PRECISION, lat_p99_ms DOUBLE PRECISION,
    lat_max_ms      DOUBLE PRECISION, lat_mean_ms DOUBLE PRECISION,
    ttft_p50_ms     DOUBLE PRECISION, ttft_p99_ms DOUBLE PRECISION,      -- chat scenarios
    overhead_p50_ms DOUBLE PRECISION, overhead_p99_ms DOUBLE PRECISION,  -- chat scenarios
    cpu_avg_pct     DOUBLE PRECISION, cpu_max_pct DOUBLE PRECISION,
    cpu_throttled_pct DOUBLE PRECISION,           -- from bench_cgroup_cpu_throttled_seconds_total
    max_replicas    SMALLINT,                      -- scale-out (k8s)
    rollout_errors  BIGINT,                        -- rollout-disruption (k8s)
    mem_avg_mb      DOUBLE PRECISION, mem_max_mb  DOUBLE PRECISION,
    rps_per_core    DOUBLE PRECISION,
    rps_per_100mb   DOUBLE PRECISION,
    latency_histogram JSONB,                       -- HDR-style buckets [{le_ms, count}]
    raw_summary     JSONB,                         -- oha json / node runner summary verbatim
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, target, rep)
);

-- Time series during a run (1 Hz)
CREATE TABLE run_samples (
    run_id      UUID        NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target      target_impl NOT NULL,
    rep         SMALLINT    NOT NULL,
    t_offset_s  INTEGER     NOT NULL,             -- seconds since this target's run start
    rps         DOUBLE PRECISION,
    lat_p50_ms  DOUBLE PRECISION,
    lat_p99_ms  DOUBLE PRECISION,
    errors      INTEGER,
    cpu_pct     DOUBLE PRECISION,
    mem_mb      DOUBLE PRECISION,
    threads     INTEGER,                          -- goroutines / threads
    db_pool_in_use INTEGER,
    replicas    SMALLINT,                         -- k8s: ready pods for this target at this second
    PRIMARY KEY (run_id, target, rep, t_offset_s)
);

-- Static characteristics (cold start, image size, idle mem) & DX notes
CREATE TABLE static_measurements (
    id           BIGSERIAL PRIMARY KEY,
    target       target_impl NOT NULL,
    metric       TEXT        NOT NULL,            -- cold_start_ms | pod_ready_ms | image_size_mb | idle_mem_mb | dep_count | build_time_s | loc
    platform     TEXT        NOT NULL,            -- compose | k8s
    value        DOUBLE PRECISION NOT NULL,
    environment_id UUID REFERENCES environments(id),
    measured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dx_notes (
    target      target_impl PRIMARY KEY,
    markdown    TEXT        NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dx_notes (target) VALUES ('go'), ('python');
```

`gen_random_uuid()` is built in from PG13+, so no extension is needed.

### 3.1 Useful views

```sql
-- Median across reps per run/target (what the UI headlines use)
CREATE VIEW run_summary AS
SELECT run_id, target,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY rps)          AS rps_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY lat_p99_ms)   AS p99_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mem_avg_mb)   AS mem_median,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY overhead_p50_ms) AS overhead_p50_median,
       (stddev_pop(rps) / NULLIF(avg(rps),0)) * 100              AS rps_cv_pct
FROM run_results GROUP BY run_id, target;
```

---

## 4. ER overview

```
dashboard DB
 conversations 1──* chat_turns
 environments  1──* benchmark_runs 1──* run_results
                                   1──* run_samples
 environments  1──* static_measurements
 dx_notes (2 rows)

go_app / py_app DB (identical)
 app.bench_items      (100k seeded, read-only)
 app.bench_writes     (append; truncated by dashboard before db-write runs)
 app.rag_documents 1──* app.rag_chunks   (RAG knowledge base: vectors + FTS)
 public.<ADK session tables>  (owned by ADK; never queried directly)
```

## 5. Data lifecycle

- Before each `db-write` run, the dashboard runs `TRUNCATE app.bench_writes` on both app DBs through its own direct connections, so table size doesn't drift between targets.
- Chat-mock load runs create many ADK sessions. Afterwards the dashboard calls `DELETE /v1/sessions/{id}` for the sessions it created, or offers "Purge bench sessions" in `/about`.
- `make reset-db` wipes the Compose volume, and `make k8s-reset-db` deletes the k8s PVC. Init scripts re-run on the next boot. The Compose and k8s databases are **separate** (Docker volume vs local-path PVC), but they're seeded identically. Benchmark history lives in whichever `dashboard` DB was active. Use the dashboard's export/import (JSON) to merge history across modes.
- Migrations after v1: add numbered files `db/migrations/NNN_*.sql`, applied by the dashboard at startup with a `schema_migrations` table. Init scripts stay frozen at v1.


# 06 — Implementation Plan (subagent-driven)

The work is split so subagents can build in **parallel with no file overlap**. Contracts are frozen first (Phase 0). After that, each container is an independent workstream with its own directory and acceptance gate. Kubernetes comes in once the stack works in Docker Compose.

**Host:** Ubuntu 24.04 LTS desktop with Docker Engine, plus k3s from Phase 4. See [08](08-UBUNTU-SETUP.md).

## Ground rules for every subagent

1. **Read first:** `docs/02-TECHNICAL-REQUIREMENTS.md` (contracts), plus your workstream's section below and the relevant doc (schema / design / Kubernetes).
2. **Own only your directory.** Don't edit another workstream's files. If a contract change is needed, stop and report it. The orchestrator (main Claude) updates `contracts/` and the TRD, then informs all workstreams.
3. **Pin exact versions** and verify ADK APIs against current docs/pkg.go.dev (`google.golang.org/adk/v2`, `google-adk` on PyPI). Don't code ADK APIs from memory.
4. **Everything builds in containers on the Ubuntu host.** Don't assume Go, Python, or Node are installed. Use `docker compose build <svc>` and `docker compose run --rm <svc> go test ./...` (or the equivalent). Official benchmark numbers come only from the Ubuntu host.
5. **Done means:** the acceptance checklist passes, tests are green, the service is healthy (Compose, and from Phase 4 also k8s), and the completion report lists files, commands run, deviations, and open issues.
6. No secrets in code. `GOOGLE_API_KEY` comes only from `.env` (Compose) or the `gemini` Secret created from it (k8s).
7. **Local reference source** (shallow clones, read-only, outside this repo) is in `../adk_samples/`:
   - `adk-go/`: ADK-Go source. See `examples/quickstart`, `examples/rest` (REST server), `examples/tools`, `session/database` (GORM session service), and `model/` (model interface for the mock LLM).
   - `adk-python/`: ADK-Python source. See `src/google/adk/cli/fast_api.py` (`get_fast_api_app`), `sessions/database_session_service.py`, and `models/base_llm.py` (for the mock LLM).
   - `adk-samples/`: official samples in `core/{go,python}` and `contrib/{go,python,…}`.
   Before coding, check out the tag you pin (`git fetch --depth 1 origin tag vX.Y.Z`) so the source matches your dependency version.
8. **Kubernetes-ready from day one** (it costs almost nothing now): read all config from env vars, log to stdout, handle SIGTERM gracefully (drain in-flight requests and SSE within 20 s), and keep `/healthz` (DB-aware) separate from `/bench/ping` (DB-free).

## Phase overview

```
Phase 0  Foundation, contracts, Ubuntu host scripts   (main Claude)          ── gate G0
         Phase 1 + Phase 4 (k8s manifests) run in parallel in fast mode
Phase 1  Build in parallel                            (4 agents: DB, GO, PY, DASH) ── gate G1
Phase 2  Parity & integration                         (1 agent)              ── gate G2
Phase 3  Benchmark engine & results UI (Compose)      (2 agents)             ── gate G3
Phase 4  Kubernetes (k3s) deployment + labs K0–K9     (2 agents + you)       ── gate G4
Phase 5  Validation runs, both platforms              (1 agent + you)        ── gate G5
Phase 6  Decision report & polish                     (1–2 agents)           ── gate G6
Phase 7  (optional) Hybrid: Go gateway → Python ADK
```

---

## Phase 0: Foundation and host (agent: `foundation`)

**Deliverables**
- `git init` with a `.gitignore` (`.env`, `node_modules`, `__pycache__`, `bin/`, `reports/`, `deploy/k8s/base/generated/`).
- `docker-compose.yml` with all 4 services (stub images are fine for servers and dashboard), limits from `.env` (`SERVER_CPUS`, `SERVER_MEM`, `DASH_CPUS`), healthchecks, `127.0.0.1` port binds, and `ulimits: nofile: 65535`. Add `docker-compose.bench.yml` with `cpuset` pinning, generated from `scripts/cpu-layout.sh` ([08 §5](08-UBUNTU-SETUP.md#5-cpu-pinning-linux-only-advantage)).
- `.env.example` and a `Makefile` with these targets: `up`, `up-bench`, `down`, `logs`, `ps`, `reset-db`, `test-go`, `test-py`, `test-dash`, `test-contract`, `bench-smoke`, `tune-host`, `untune-host`. The k8s targets are stubbed for Phase 4.
- `scripts/ubuntu-setup.sh`, `scripts/ubuntu-tune.sh` (+ untune), and `scripts/cpu-layout.sh`, per [08](08-UBUNTU-SETUP.md). They must be idempotent, and use `set -euo pipefail` and `shellcheck`-clean code.
- `contracts/openapi.yaml` (from TRD §5), `contracts/sse-events.md`, `contracts/agent-spec.md`, and `contracts/fixtures/`.
- A `README.md` quick start for Ubuntu.

**Gate G0:** you run `scripts/ubuntu-setup.sh` on the Ubuntu machine, and `docker run hello-world` works without sudo. `docker compose config` is valid. The OpenAPI file validates (`npx @redocly/cli lint`). You review and approve the contracts.

---

## Phase 1: Parallel build (4 agents, launched in one message)

### WS-DB (agent: `db`), owns `db/`
- Init scripts exactly as in [05](05-DATABASE-SCHEMA.md): create DBs, apply app schema and seed to both app DBs, and set up the dashboard schema and views. They must work both from Compose's bind mount and from a k8s ConfigMap mounted at `/docker-entrypoint-initdb.d`, so no paths outside that dir.
- **Acceptance:** fresh `make reset-db && make up postgres` → 3 DBs. `SELECT count(*) FROM app.bench_items` returns 100000 in both `go_app` and `py_app`. An md5 checksum of `bench_items` is equal across both DBs.

### WS-GO (agent: `go-server`), owns `go-server/`
1. Multi-stage Dockerfile (`golang:<version from ADK-Go go.mod>` → `gcr.io/distroless/static`), static binary, non-root.
2. `internal/config`: env parsing.
3. `internal/db`: `pgxpool` (search_path=app,public) and the GORM postgres dialector for ADK sessions.
4. `internal/agent`: `llmagent.New(...)` with the Gemini model (`model/gemini`), the instruction from `contracts/agent-spec.md`, and two function tools. The runner uses the ADK `session/database` service with `AutoMigrate`.
5. `internal/mockllm`: implements ADK-Go's model interface per the mock script, including the function-call branch.
6. A timing decorator that wraps the model to accumulate `model_ms`. Tool and session timing go through wrappers or callbacks.
7. `internal/api`: stdlib mux with `/healthz`, `/v1/info`, `/v1/sessions*`, `/v1/chat`, `/v1/chat/stream` (SSE with `http.Flusher`), and `Server-Timing` headers. Graceful shutdown with `http.Server.Shutdown` on SIGTERM.
8. `internal/bench`: every `/bench/*` endpoint per TRD §5.4.
9. `internal/metrics`: Prometheus metrics with the exact names in TRD §7, **including the `bench_cgroup_*` metrics read from `/sys/fs/cgroup`**.
10. Tests: handler tests (httptest), mock-LLM event sequence, bench endpoint correctness, and cgroup file parsing.
- **Acceptance:** container healthy. `curl` checks pass for every endpoint. A mock chat streams `meta → token×N → done` with all timing fields. The "inventory" message produces a `tool_call` with correct DB numbers. A Gemini chat works with a real key. `docker stop` mid-stream closes the stream cleanly. `go test ./...` and `go vet` pass.

### WS-PY (agent: `fastapi-server`), owns `fastapi-server/`
1. Dockerfile on `python:3.12-slim` with `uv`, a non-root user, and the CMD `uvicorn app.main:app --host 0.0.0.0 --port 8080 --workers ${PY_WORKERS} --loop uvloop --http httptools --no-access-log --timeout-graceful-shutdown 20`.
2. `app/main.py`: build the app with `get_fast_api_app(agents_dir=..., session_service_uri="postgresql+asyncpg://…/py_app", web=False)` and **include** the custom routers. Keep ADK native routes.
3. `app/db.py`: asyncpg pool (size = `DB_POOL_MAX // PY_WORKERS`, min 2), created on lifespan startup.
4. `app/agent/`: `LlmAgent` with the same instruction, tools, and generate config. A `Runner` uses the same `DatabaseSessionService` instance.
5. `app/mockllm.py`: a `BaseLlm` subclass per the mock script, using `await asyncio.sleep`.
6. A timing wrapper (model, tool, session), identical in semantics to Go.
7. `app/api/`: `/healthz`, `/v1/info`, `/v1/sessions*`, `/v1/chat`, `/v1/chat/stream` (`StreamingResponse`/`EventSourceResponse`), and `Server-Timing`.
8. `app/bench/`: every `/bench/*` endpoint. **CPU bench:** use `hashlib` in the default `async def` route (it blocks the loop, which is the honest behaviour), plus a `?offload=1` variant using `run_in_threadpool`.
9. `app/metrics.py`: prometheus-client in multiprocess mode (`PROMETHEUS_MULTIPROC_DIR`), plus the `bench_cgroup_*` metrics. The cgroup is per-container, so it covers all workers.
10. Tests: pytest + httpx `AsyncClient`, mirroring the Go tests.
- **Acceptance:** the same as WS-GO, on port 8082, plus ADK's native `/list-apps` responds.

### WS-DASH (agent: `dashboard`), owns `dashboard/`
1. Dockerfile: a Node 22 build stage (SPA) and a runtime stage. Copy in the `oha` binary for `TARGETARCH`.
2. `server/platform/`: the **Platform adapter interface** (TRD §8.1) and the `compose` implementation (dockerode). The k8s implementation comes in Phase 4, but the interface is fixed now.
3. `server/`: Hono app serving the SPA, `/api/platform`, `/api/targets`, `/api/chat` (fan-out SSE relay with client-side timings and persistence), and `/api/live` (cgroup metrics scrape + platform stats).
4. `web/`: layout, theme tokens, components from [04 §5](04-DESIGN-BRIEF.md), and the `/chat` and `/live` pages. The top bar shows the platform badge.
5. Build against `contracts/openapi.yaml`, using a contract-faithful stub (`dashboard/dev/stub-target.ts`) until the real servers exist.
- **Acceptance:** against two stub targets, the chat streams in both panes with the metric strip, and live charts update at 1 Hz. With real servers, the same works in Mock and Gemini mode. Conversations survive a reload.

**Gate G1:** each stream's acceptance checklist passes independently.

---

## Phase 2: Parity and integration (agent: `parity`)

- `contracts/tests/` is a Vitest suite parameterised over both targets (base URLs from env, so it also runs in k8s later). It covers the schemas of every endpoint, SSE event order and fields, the `bench/json` output equality, `bench/cpu` hash equality, `db/read` row equality, tool-call results in mock mode, and session create/read/delete.
- A **timing-semantics audit:** with mock settings of 250 ms first token and 60 tokens × 15 ms, both servers should report `model_ms` ≈ 1150 ms ± 5% and `overhead_ms` < 50 ms.
- A **cgroup metrics audit:** under the `cpu` scenario, `bench_cgroup_cpu_usage_seconds_total` agrees with `docker stats` within 10%.
- **Gate G2:** the contract suite is 100% green on both targets, and both audits pass.

## Phase 3: Benchmark engine and results UI (2 agents in parallel)

### WS-ORCH (agent: `orchestrator`), owns `dashboard/server/bench/`
- Scenario catalogue (TRD §6), the run state machine, warm-up, cooldown, A/B alternation, reps, and the one-active-run lock.
- `oha` driver and a Node chat runner (`undici`, VU pool, TTFT, ramp).
- A 1 Hz sampler (cgroup metrics + platform stats) → `run_samples`, and an analyzer → `run_results`, including `platform` and the suspect flags.
- Preflight goes **only through the Platform adapter**. It checks that the other stack isn't active and that the quiet-mode checklist was acknowledged.
- Housekeeping (truncate `bench_writes`, delete bench sessions). Cold start through `platform.restart()`.
- Unit tests for the stats math and the state machine.

### WS-RESULTS-UI (agent: `results-ui`), owns `dashboard/web/src/pages/{bench,history,compare,about}`
- The scenario cards (k8s-only scenarios greyed out in Compose mode), config drawer, Gemini confirmation dialog, quiet-mode checklist dialog, running view, results, history (with a platform filter), compare (including cross-platform), about page, and DX notes.

**Gate G3:** `make bench-smoke` (ping, db-read, chat-mock at 5 s each, 1 rep) completes on Compose, persists, and renders.

## Phase 4: Kubernetes (2 agents + you), see [07](07-KUBERNETES.md)

### WS-K8S (agent: `k8s`), owns `deploy/k8s/`
- Host files (`k3s-config.yaml`, `registries.yaml`) and the Make targets (`registry-up`, `images`, `k8s-*`, `mode-*`).
- The Kustomize base and the overlays `dev`, `bench`, and `scale`, following the rules in [07 §4.1](07-KUBERNETES.md#41-key-manifest-rules-for-the-implementing-agent).
- Lab notes `deploy/k8s/labs/K0.md … K9.md`: commands, expected output, the break-it exercise, and answers in `<details>`.
- **Fast mode (chosen):** everything is built in one go, in parallel with Phase 1. The lab notes are written for self-study afterwards.

### WS-K8S-ADAPTER (agent: `k8s-adapter`), owns `dashboard/server/platform/k8s.ts`
- Implements the Platform interface with `@kubernetes/client-node`, using the in-cluster ServiceAccount. Covers `info` (QoS class, node, image digests), `containerStats` (metrics-server, plus the servers' own cgroup metrics), `restart` (delete pod → watch Ready), `scale`, `rollout` (patch the restart annotation → watch rollout), and `isOtherStackActive`.
- Adds the `scale-out` and `rollout-disruption` scenarios to the orchestrator catalogue (coordinate with the orchestrator through main Claude).

**Gate G4:** see [07 §7](07-KUBERNETES.md#7-kubernetes-done-criteria-gate-g4).

## Phase 5: Validation and calibration (agent: `validator` + you)

- Run `make tune-host` and close heavy apps. Run every scenario 3× on **Compose (`up-bench`, pinned)** and 3× on **k8s (`bench` overlay)**. Check that the coefficient of variation is ≤ 10%.
- A load-generator ceiling check: `ping` against a static nginx. Dashboard CPU should stay under 85%.
- Sanity-check against expectations. Go should lead on `cpu`, `ping`, and `json`, and on idle memory. `chat-gemini` should be near-equal. Investigate anything surprising: fix bugs, never "fix" results.
- Run both Python profiles (`py-1w`, `py-Nw`) and, in k8s, compare `py-1w × N pods` with `py-Nw × 1 pod`.
- **Gate G5:** a complete, non-suspect result set exists for all scenarios on both platforms.

## Phase 6: Report and polish (agents: `report`, optional `native-adk`)

- The Decision Report generator (PRD §10), now including a **Kubernetes section** (pods needed, scale speed, rollout errors, density).
- Optional: a native-ADK API comparison (`/run_sse` vs ADK-Go's REST handler under `/adk`).
- Accessibility pass and final README.
- **Gate G6:** you review the Decision Report.

## Phase 7 (optional): Hybrid

A `hybrid-gateway` Go service (sessions, auth, and SSE fan-out) proxies agent execution to the Python ADK. It's deployed in Compose and k8s and benchmarked as a 3rd target.

---

## Suggested subagent launch sequence

| Step | Launch | Parallel? | Est. effort |
|---|---|---|---|
| 1 | `foundation` → you run `ubuntu-setup.sh` | — | S |
| 2 | `db`, `go-server`, `fastapi-server`, `dashboard` | **yes, 4 agents** | L each |
| 3 | `parity` | — | M |
| 4 | `orchestrator`, `results-ui` | **yes, 2 agents** | L, M |
| 5 | `k8s` (per lab group, pausing for you), `k8s-adapter` | partly parallel | M, M |
| 6 | `validator` | — | M (mostly wall-clock) |
| 7 | `report` (+ `native-adk`) | yes | S–M |

Each subagent prompt should include its workstream section verbatim, links to the docs, and the ground rules above. Use `isolation: "worktree"` for parallel agents if you want branch-per-stream review, and merge at each gate.

## Prerequisites from you

- [ ] An Ubuntu 24.04 machine with Docker Engine (installed by `scripts/ubuntu-setup.sh` in Phase 0). Ideally 12+ threads and 16–32 GB RAM.
- [ ] Claude Code running on the Ubuntu machine (recommended), with this repo and `../adk_samples` cloned there ([08 §7](08-UBUNTU-SETUP.md#7-where-claude-code-runs)).
- [ ] A `GOOGLE_API_KEY` (Gemini API, AI Studio) in `.env`. Check your quota for L4 runs.
- [ ] Approve the contracts at gate G0.
- [ ] Answer the open questions in PRD §12, or accept the defaults.


# 07 — Kubernetes (k3s) Deployment and Learning Path

This doc has two goals:
1. Run the **same four images** on Kubernetes, so we can benchmark Go vs FastAPI where Kubernetes changes the picture: density, scale-out, and rollouts.
2. **Teach Kubernetes** through labs that build this project step by step, with no throwaway tutorials.

Docker Compose stays the fast dev loop and the baseline. Kubernetes comes in at Phase 4 ([06](06-IMPLEMENTATION-PLAN.md)), after the app works in Compose.

---

## 1. Why k3s (on Ubuntu 24.04 desktop)

| Option | Verdict |
|---|---|
| **k3s** ✅ | A real, CNCF-conformant Kubernetes in one binary and systemd service, light enough to share a desktop. It bundles containerd, CoreDNS, Traefik (Ingress), local-path storage, metrics-server, and NetworkPolicy enforcement. |
| MicroK8s | Also good on Ubuntu (Canonical, snap). Strict snap confinement and add-on management add friction. |
| kind / minikube | Great for CI and tutorials, but Kubernetes-inside-Docker (or a VM) adds a network/virtualization layer that skews benchmarks. |
| kubeadm | Best for learning internals, but heavy for day one. Optional lab K13. |

Single node. Multi-node is out of scope.

## 2. Cluster configuration

`deploy/k8s/host/k3s-config.yaml` (copied to `/etc/rancher/k3s/config.yaml` before install, see [08](08-UBUNTU-SETUP.md)):

```yaml
write-kubeconfig-mode: "0600"
disable:
  - servicelb          # don't open :80/:443 to the LAN; we use port-forward
kubelet-arg:
  - "max-pods=110"
  # K12 (advanced) adds: cpu-manager-policy=static, reserved-cpus=0-1
```

`deploy/k8s/host/registries.yaml` lets k3s pull from the local registry:

```yaml
mirrors:
  "localhost:5000":
    endpoint: ["http://localhost:5000"]
```

**Image flow:** `make registry-up` runs `registry:2` on `127.0.0.1:5000` under Docker. Then `make images` builds each image, tags it `localhost:5000/<svc>:<git-sha>`, and pushes it. Overlays pin that tag through `kustomize edit set image`. Tags are immutable, so no `:latest`.

## 3. Cluster architecture

```
namespace: bench
┌───────────────────────────────────────────────────────────────────────────┐
│  Ingress (Traefik, kube-system) ── path / ──▶ Service dashboard :3000     │
│                                                                           │
│  Deployment dashboard (1)  SA: dashboard + Role (pods, deployments/scale, │
│        │                    pods metrics) ── load generator runs here     │
│        ├──▶ Service go-server      :8080 ──▶ Deployment go-server (1..4)   │
│        └──▶ Service fastapi-server :8080 ──▶ Deployment fastapi-server(1..4)│
│                                        │                                  │
│                         Service postgres (headless) ──▶ StatefulSet postgres│
│                                                         PVC 10Gi local-path│
│  Secret gemini (GOOGLE_API_KEY) · Secret postgres-credentials             │
│  ConfigMap db-init (db/init/*) · ConfigMap agent-spec (contracts/…)       │
│  HPA go-server / fastapi-server (scale overlay only)                      │
│  NetworkPolicies (lab K10)                                                │
└───────────────────────────────────────────────────────────────────────────┘
Access: make k8s-open → kubectl -n kube-system port-forward svc/traefik 8080:80 → http://localhost:8080
```

The app code doesn't change between Compose and Kubernetes. Only env values and the dashboard's **platform adapter** (`PLATFORM=k8s`, TRD §8.1) differ. Service DNS names deliberately match the Compose service names (`go-server`, `fastapi-server`, `postgres`), so `DATABASE_URL` and target URLs stay identical.

## 4. Manifest layout (Kustomize)

```
deploy/k8s/
├── host/                       # k3s-config.yaml, registries.yaml (host files, not applied)
├── base/
│   ├── kustomization.yaml      # namespace: bench; configMapGenerator / secretGenerator
│   ├── namespace.yaml
│   ├── generated/              # git-ignored; `make k8s-sync` copies db/init/* + contracts/agent-spec.md here
│   ├── postgres/   statefulset.yaml  service.yaml
│   ├── go-server/  deployment.yaml   service.yaml
│   ├── fastapi-server/ deployment.yaml service.yaml
│   └── dashboard/  deployment.yaml service.yaml serviceaccount.yaml role.yaml rolebinding.yaml ingress.yaml
└── overlays/
    ├── dev/        # small limits, 1 replica each, fast iteration
    ├── bench/      # Guaranteed QoS (requests == limits) matching Compose limits; used for numbers
    └── scale/      # bench + HPA (min 1, max 4, CPU 70%) for go-server and fastapi-server
```

Why `generated/`: Kustomize refuses to load files outside its directory, so `make k8s-sync` copies them in. It runs automatically before `make k8s-up`.

### 4.1 Key manifest rules (for the implementing agent)

| Concern | Rule |
|---|---|
| Probes | `startupProbe` on `/healthz` (generous, covers ADK migrations). `readinessProbe` on `/healthz` (checks the DB). `livenessProbe` on **`/bench/ping`**: liveness must not depend on the DB, or a DB blip restarts every pod (a lesson in K3). |
| Startup order | An initContainer (`pgvector/pgvector:pg17`, the same image as Postgres, already pulled, `pg_isready` loop) on both servers. Kubernetes has no `depends_on`. |
| Resources | Base sets requests and limits. The `bench` overlay sets requests == limits (`cpu: 2`, `memory: 1Gi`), giving the **Guaranteed** QoS class. |
| Python workers | `PY_WORKERS` comes from the downward API: `resourceFieldRef: {resource: limits.cpu, divisor: "1"}`. Workers track the CPU limit automatically. Go needs nothing, because the runtime reads the cgroup limit. |
| Secrets | `make k8s-secrets` creates Secret `gemini` from `.env`. It's never committed. (Secrets are only base64. Sealed Secrets / SOPS is an optional extra.) |
| Postgres | StatefulSet with 1 replica, `volumeClaimTemplates` 10Gi on `local-path`, and ConfigMap `db-init` mounted at `/docker-entrypoint-initdb.d`. These are the same scripts Compose uses. |
| Dashboard RBAC | Role in `bench`: `pods` get/list/watch/delete. `deployments`, `deployments/scale` get/patch. `horizontalpodautoscalers` get/list/patch. `pods.metrics.k8s.io` get/list. Nothing cluster-scoped. |
| Rollouts | `strategy: RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0`, and a `preStop` sleep of 5 s so endpoints are removed before SIGTERM. Both servers must handle SIGTERM gracefully (drain in-flight SSE, with a 20 s grace period). |
| Labels | `app.kubernetes.io/name`, `app.kubernetes.io/part-of: go-benchmarking`, and `bench/target: go|python`. |

### 4.2 Make targets

`registry-up`, `images`, `k8s-sync`, `k8s-secrets`, `k8s-up` (`OVERLAY=dev|bench|scale`, default `dev`), `k8s-down`, `k8s-status`, `k8s-open`, `k8s-logs SVC=…`, `k8s-reset-db` (deletes the PVC), `mode-compose`, `mode-k8s`.

## 5. What Kubernetes adds to the benchmark

| Scenario / dimension | Question it answers |
|---|---|
| **Platform dimension** (any scenario run with `PLATFORM=k8s`) | How much do Service routing (iptables DNAT), the CNI bridge, and CFS limits cost, and does that cost differ between Go and Python? |
| `scale-out` | Under ramping chat-mock load with HPA, how many pods does each need for the same RPS? How fast do they scale, and how fast is a new pod Ready (Go's static binary vs Python's import time)? |
| `rollout-disruption` | During a rolling restart under constant load, how many errors and how big a p99 spike? (This tests graceful shutdown quality.) |
| `cold-start` (k8s variant) | Pod delete → new pod Ready, including image pull from the local re