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
