# Contract / parity suite

Vitest + TypeScript (Node 22, ESM). It runs the same assertions against **go-server** and
**fastapi-server** and checks that they agree with each other. This suite is the main fairness gate (docs/02 §10, docs/06 Phase 2 / G2).

## Running it

Targets come from env. A target whose URL is unset is skipped. Cross-target equality tests run only when both URLs are set.

| env | meaning |
|---|---|
| `GO_URL` / `PY_URL` | base URLs of the two servers |
| `TIMING_AUDIT=1` | enable the timing-semantics audit (`suites/60-*`) |
| `TIMING_AUDIT_REPS` (5), `TIMING_AUDIT_TOLERANCE` (0.05) | audit sample count and relative `model_ms` tolerance |
| `MOCK_TOKENS` (60), `MOCK_FIRST_TOKEN_DELAY_MS` (250), `MOCK_TOKEN_DELAY_MS` (15) | must match the servers' mock env if you changed it |

```bash
# inside the compose network (what `make test-contract` does)
make up && make test-contract

# from the host, against the published ports
cd contracts/tests && npm ci
GO_URL=http://localhost:8081 PY_URL=http://localhost:8082 npx vitest run
GO_URL=http://localhost:8081 PY_URL=http://localhost:8082 TIMING_AUDIT=1 npx vitest run suites/60-timing-audit.test.ts
npx tsc --noEmit   # typecheck
```

Suites run **sequentially in file-name order** (`sequencer.ts`), because they share server state.

## What each suite proves

| file | proves |
|---|---|
| `01-openapi` | `openapi.yaml` compiles under JSON Schema 2020-12 (Ajv) and the fixtures fit it. Needs no server. |
| `00-meta` | `/healthz` and `/v1/info` match the schema, `impl` is right per target, `Server-Timing` is set. Both servers report the same model, embed model and pool size. |
| `10-bench` | `cpu` hash equals `expected-bench.json` (also with `offload=1`, and for n=3 against a local SHA-256 chain). `json` returns the right `item_count`, `total` and echo. `db/read?id=42` and `db/query` return identical rows on both servers. `db/write` returns 201 with an id. `sleep?ms=50` takes at least 50 ms. |
| `20-rag-stateless` | `/v1/rag/chunk` reproduces every `fixtures/rag-chunking/expected/*.json` exactly. `large.md` chunks are identical across servers. `/v1/rag/embed` (mock) matches `expected-mock.json` within 1e-6. Bad input returns 400 Error. |
| `30-rag-kb` | Wipe, inline ingest (title taken from `# `, skip on unchanged hash, `force` plus explicit title), then the default corpus with mock: equal documents, chunks and chars; re-ingest skips everything; `stats` is consistent. For every `rag-queries.json` query in hybrid, vector and fts modes, the ordered results (source/title/heading/content) are **identical** and scores agree within 1e-6. Also covers defaults, k bounds, `preset=random`, and 400s for bad params. **Leaves both KBs holding exactly the default corpus (mock).** |
| `40-sessions` | Create, get (empty), delete (204), then 404 Error. Unknown session gives 404, another user's session gives 404, a missing user_id gives 400. |
| `50-chat` | Mock mode for the plain, inventory and rag prompts. SSE framing (single-line JSON data) and the order `meta → (token\|tool_call)* → done`. Token `seq` runs 1..N. Tool name, args and result per agent-spec, with inventory checked against `/bench/db/query` and rag sources against `/v1/rag/search`. The reply is the deterministic mock text, with the prefix rule, and equals the concatenated tokens. Checks usage and the timing fields (`overhead = max(0, total − model − tool − session)` ± 0.5 ms, plus floors). `/v1/chat` returns the same reply. Session history holds the turn. Errors are 404/400 JSON returned before any streaming. Parity covers identical event sequence, tokens, reply, tool results, usage and history shape. |
| `60-timing-audit` | (opt-in) Median `model_ms` is about 1150 ms (plain) or 1400 ms (tool branches) within ±5%, and median `overhead_ms` is under 50 ms on both servers. Requests run sequentially. |
| `90-metrics` | `/metrics` exposes every docs/02 §7 name with the right labels after traffic. Both servers expose the same `bench_*` family set and the same route labels. |
