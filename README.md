# go_benchmarking — Go vs FastAPI (Google ADK + Gemini)

This is a local test bench on **Ubuntu 24.04** (Docker Compose and Kubernetes/k3s) for comparing a **Go ADK** server and a **FastAPI (Python) ADK** server side by side. Both share one PostgreSQL instance, and a dashboard provides side-by-side Gemini chat, live metrics, and repeatable benchmarks.

## Quick start

```bash
cp .env.example .env        # add GOOGLE_API_KEY (Gemini). Mock mode works without it.
make up                     # postgres + go-server + fastapi-server + dashboard
open http://localhost:3000  # side-by-side chat, live metrics, benchmarks
make test-contract          # Go/Python parity suite against the running stack
```

On the Ubuntu deployment server, run `make setup-host` once, then `make up-bench` (CPU-pinned) or `make mode-k8s OVERLAY=bench`. See [docs/08](docs/08-UBUNTU-SETUP.md) and [docs/07](docs/07-KUBERNETES.md).

**Stack:** ADK-Go v2 (net/http, pgx) vs ADK-Python 2.x (FastAPI/Uvicorn, asyncpg), Gemini `gemini-3.5-flash-lite`, hybrid RAG (`gemini-embedding-2` + pgvector + Postgres full-text), PostgreSQL 17, and a Node/React dashboard.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | **Source of truth** shared by both servers: OpenAPI, SSE events, agent spec, shared SQL, parity fixtures, and the reference implementation |
| `go-server/` | ADK-Go implementation |
| `fastapi-server/` | ADK-Python implementation |
| `dashboard/` | Hono API + React SPA, the load generator, and the benchmark orchestrator |
| `db/init/` | Postgres init (3 databases, schemas, seed) |
| `corpus/` | RAG corpus. `corpus/private/` is git-ignored. |
| `deploy/k8s/` | k3s manifests (Kustomize) and learning labs |
| `scripts/` | Ubuntu setup, quiet mode, CPU layout |

## Status

The stack is built and integration-tested on the Mac dev machine (Docker Desktop, arm64):
- **Parity:** the Go/Python parity suite passes 218 tests, plus the timing audit (6/6) when enabled.
- **Unit tests:** all green.
- **Smoke benchmark:** `make bench-smoke` passes.

Official numbers come from the Ubuntu 24.04 deployment server ([docs/08](docs/08-UBUNTU-SETUP.md)).

First smoke numbers, Mac dev box only (not official). These are 5 s runs with 1 rep and no CPU pinning:

| Scenario | Go | FastAPI |
|---|---|---|
| `ping` RPS (p99) | 158k (1.7 ms) | 25k (5.1 ms) |
| `db-read` RPS (p99) | 53k (2.4 ms) | 12.9k (7.1 ms) |
| `chat-mock` RPS at c=50 (p99) | 40 (1.19 s) | 31 (1.37 s) |
| Chat overhead (RAG tool call) | ~1 ms | ~10 ms |
| Idle memory / image size | 35 MB / 40 MB | 311 MB / 488 MB |

## Planning docs

| # | Doc | What's inside |
|---|---|---|
| 01 | [Product Requirements](docs/01-PRD.md) | Goals, the 4-layer measurement model, functional and non-functional requirements, the decision report |
| 02 | [Technical Requirements](docs/02-TECHNICAL-REQUIREMENTS.md) | Architecture, stack, **shared API/SSE contract**, scenarios, metrics |
| 03 | [App Flow](docs/03-APP-FLOW.md) | Startup, chat, live, benchmark, and compare flows |
| 04 | [Design Brief](docs/04-DESIGN-BRIEF.md) | Dashboard look, screens, components |
| 05 | [Database Schema](docs/05-DATABASE-SCHEMA.md) | 3 databases, DDL, seed, lifecycle |
| 06 | [Implementation Plan](docs/06-IMPLEMENTATION-PLAN.md) | Phased, parallel subagent workstreams with gates |
| 07 | [Kubernetes](docs/07-KUBERNETES.md) | k3s deployment, Kustomize layout, k8s scenarios, **learning labs K0–K13** |
| 08 | [Ubuntu Setup](docs/08-UBUNTU-SETUP.md) | Docker Engine + k3s install, quiet mode, CPU pinning |
| 09 | [RAG](docs/09-RAG.md) | Hybrid RAG: Gemini embeddings + pgvector + full-text (RRF), chunking spec, tool |

## Services (planned)

| Service | Host port |
|---|---|
| dashboard | http://localhost:3000 |
| go-server | http://localhost:8081 |
| fastapi-server | http://localhost:8082 |
| postgres | localhost:5432 |

In Kubernetes mode, run `make k8s-open` and open the dashboard at http://localhost:8080. The servers are reached in-cluster, or via `kubectl port-forward`.
