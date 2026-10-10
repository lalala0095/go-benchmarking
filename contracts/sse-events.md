# SSE events for `POST /v1/chat/stream` (both servers, identical)

Content-Type `text/event-stream`, no compression. Each event is `event: <name>\ndata: <single-line JSON>\n\n`. Events are flushed immediately.
Order: `meta` → (`token` | `tool_call`)* → (`done` | `error`). After `done` or `error` the server closes the stream.

| event | data |
|---|---|
| `meta` | `{"request_id": str, "impl": "go"\|"python", "session_id": str, "mode": "gemini"\|"mock", "model": str}` |
| `token` | `{"text": str, "seq": int /* 1-based */}` (partial text only; the final aggregated response is not re-sent) |
| `tool_call` | `{"name": str, "args": object, "duration_ms": float, "result_summary": object, "embed_ms"?: float, "db_ms"?: float}`. Emitted when the tool **finishes**. `result_summary` = `{"sources": [..]}` for search_knowledge_base, the full result for the other tools. |
| `done` | `{"request_id": str, "reply": str /* full text */, "timings": Timings, "usage": {"input_tokens": int, "output_tokens": int}}` |
| `error` | `{"request_id": str, "code": "BAD_REQUEST"\|"SESSION_NOT_FOUND"\|"UPSTREAM_429"\|"UPSTREAM_ERROR"\|"INTERNAL", "message": str}` |

`Timings` (all float milliseconds, monotonic clock):

| field | meaning |
|---|---|
| `server_total_ms` | request received → `done` about to be written |
| `first_token_ms` | request received → first `token` written (0 if none) |
| `model_ms` | total time spent awaiting the model (Gemini or mock): from calling the model to its last chunk, summed over calls |
| `tool_ms` | total tool execution time (including embedding and DB inside tools) |
| `session_ms` | time spent in ADK session service operations (get/create session, append events) |
| `overhead_ms` | `server_total_ms - model_ms - tool_ms - session_ms`, floored at 0 |

Non-streaming `POST /v1/chat` returns `{"request_id","session_id","reply","tool_calls":[...tool_call data],"timings","usage"}` with the same fields.

Non-streaming responses (`POST /v1/chat`, `/bench/*`, `/v1/rag/*`) set the header `Server-Timing: total;dur=X[, model;dur=Y, tool;dur=Z, session;dur=W, db;dur=D]`. Streams don't send Server-Timing, because their timings arrive in the `done` event.
