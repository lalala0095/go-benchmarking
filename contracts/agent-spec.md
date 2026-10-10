# Agent spec (shared verbatim by go-server and fastapi-server)

- **App name / agent name:** `bench_agent` (ADK `app_name` = `bench_agent`)
- **Instruction:** the exact contents of `contracts/agent-instruction.txt` (baked into both images at `/contracts/agent-instruction.txt`).
- **Model:** env `GEMINI_MODEL`, default `gemini-3.5-flash-lite`.
- **Generation config:** `max_output_tokens: 512` only. Don't set temperature, top_p, or top_k (Gemini 3.x deprecates the sampling params).
- **Streaming:** the ADK runner runs in SSE streaming mode, so partial text events become `token` SSE events.

## Tools (identical names, parameters, descriptions, and result shapes)

### `search_knowledge_base`
- Description: `Search the project knowledge base and return the most relevant passages.`
- Params: `query` (string, required), `top_k` (integer, optional, default 5, clamp 1..20)
- Behaviour: embed `query` with the embedder for the current chat mode (`gemini` → gemini, falling back to mock when `gemini_embedded_chunks = 0`; `mock` → mock). Run `contracts/sql/rag_search_hybrid.sql` with `k = top_k`.
- Result: `{"results": [{"source": str, "heading": str, "content": str /* ≤ 800 code points */}]}`
- Extra timings for the SSE `tool_call` event: `embed_ms`, `db_ms`.

### `get_inventory_stats`
- Description: `Get inventory statistics (count, avg/min/max price) for a product category.`
- Params: `category` (string, required)
- SQL (identical in both): `SELECT count(*)::int, coalesce(avg(price),0)::float8, coalesce(min(price),0)::float8, coalesce(max(price),0)::float8 FROM app.bench_items WHERE category = $1`
- Result: `{"category": str, "count": int, "avg_price": float /* rounded to 2 dp */, "min_price": float, "max_price": float}`

### `get_current_time`
- Description: `Get the current time in an IANA timezone.`
- Params: `timezone` (string, required). If the zone is unknown, fall back to UTC and set `"note": "unknown timezone, used UTC"`.
- Result: `{"timezone": str, "iso": str /* RFC 3339 with offset, second precision; UTC is written as `Z` */}`

## Mock LLM (`mode: "mock"`)

A custom model registered with the ADK runner (Go: implements ADK-Go's model interface; Python: subclasses `google.adk.models.BaseLlm`). The runner drives it exactly like Gemini, including function calls and tool responses. All waits are non-blocking (`time.Sleep` in Go, `await asyncio.sleep` in Python).

Env: `MOCK_FIRST_TOKEN_DELAY_MS` (250), `MOCK_TOKEN_DELAY_MS` (15), `MOCK_TOKENS` (60).

**First model call** (the last content in the request is the user message). `m = lowercase(user message)`, branches in this order:
1. If `m` contains `inventory`, wait `FIRST_TOKEN_DELAY`, then return a single function call `get_inventory_stats({"category": "electronics"})`.
2. Else if `m` contains `docs` or `knowledge`, wait `FIRST_TOKEN_DELAY`, then return a function call `search_knowledge_base({"query": <original user message>, "top_k": 5})`.
3. Else stream a text answer (below) with `prefix = ""`.

**Second model call** (the last content is a function response):
- After `get_inventory_stats`: `prefix = "Electronics: {count} items, avg price {avg_price}. "`
- After `search_knowledge_base`: `prefix = "Based on [{results[0].source}]: "`, or `"Based on [no results]: "` when empty.
- Then stream the text answer.

**Streaming a text answer:** sleeps are scheduled against **fixed deadlines** measured from the start of the model call. The first chunk is at `start + FIRST_TOKEN_DELAY`, and token chunk `i` at `start + FIRST_TOKEN_DELAY + (i+1)×TOKEN_DELAY`. This avoids timer drift; don't use cumulative per-token sleeps. Wait `FIRST_TOKEN_DELAY`. If `prefix` is non-empty, emit it as the first partial chunk. Then emit `MOCK_TOKENS` partial chunks, chunk `i` (0-based) = `WORDS[i % len(WORDS)] + " "`, waiting `TOKEN_DELAY` **before each** chunk. Finish with a final non-partial response containing the full concatenated text.
`WORDS = ["lorem","ipsum","dolor","sit","amet","consectetur","adipiscing","elit","sed","do","eiusmod","tempor","incididunt","ut","labore","et","dolore","magna","aliqua"]`

**Model name:** in mock mode, `meta.model` = `"mock"`.

**Session history mapping:** function-call and function-response events get role `tool`, with `tool` set to the function name.

**Usage metadata:** `input_tokens` = number of whitespace-separated words in the user message. `output_tokens` = `MOCK_TOKENS` (+1 if there's a prefix).

**Expected `model_ms`** for the plain branch is about `250 + 60×15 = 1150 ms`. For tool branches it's about `250` (the function-call turn) `+ 250 + 60×15` (the answer turn) `= 1400 ms` (plus nothing for the tool, which is counted in `tool_ms`).
