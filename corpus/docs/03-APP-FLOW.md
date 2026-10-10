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
