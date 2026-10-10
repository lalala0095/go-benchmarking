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
3. `internal/db`: `pgxpool` (schema-qualified SQL, default search_path) and the GORM postgres dialector for ADK sessions.
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
