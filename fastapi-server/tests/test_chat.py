import json

import httpx
import pytest

from tests.fakes import install_fakes


@pytest.fixture
async def client():
    bundle, pool = install_fakes()
    from app.main import create_app

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        c.bundle = bundle
        c.pool = pool
        yield c


def parse_sse(text: str):
    events = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        lines = block.split("\n")
        assert lines[0].startswith("event: ") and lines[1].startswith("data: ") and len(lines) == 2
        events.append((lines[0][7:], json.loads(lines[1][6:])))
    return events


async def new_session(c, user="u1"):
    r = await c.post("/v1/sessions", json={"user_id": user})
    assert r.status_code == 201
    body = r.json()
    assert set(body) == {"session_id", "user_id", "created_at"} and body["user_id"] == user
    return body["session_id"]


async def stream(c, sid, message, mode="mock", user="u1"):
    r = await c.post(
        "/v1/chat/stream", json={"user_id": user, "session_id": sid, "message": message, "mode": mode, "request_id": "rid-1"}
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert "server-timing" not in r.headers
    return parse_sse(r.text)


TIMING_KEYS = {"server_total_ms", "first_token_ms", "model_ms", "tool_ms", "session_ms", "overhead_ms"}


def check_done(ev, n_tokens_text):
    name, d = ev
    assert name == "done"
    assert d["request_id"] == "rid-1"
    assert set(d["timings"]) == TIMING_KEYS
    t = d["timings"]
    assert t["overhead_ms"] >= 0
    assert t["server_total_ms"] >= t["model_ms"] + t["tool_ms"] + t["session_ms"] - 0.01
    assert d["reply"] == n_tokens_text
    return d


async def test_plain_mock_stream(client):
    sid = await new_session(client)
    events = await stream(client, sid, "hello there friend")
    names = [e[0] for e in events]
    assert names == ["meta"] + ["token"] * 10 + ["done"]
    meta = events[0][1]
    assert meta == {"request_id": "rid-1", "impl": "python", "session_id": sid, "mode": "mock", "model": "mock"}
    tokens = [e[1] for e in events[1:-1]]
    assert [t["seq"] for t in tokens] == list(range(1, 11))
    text = "".join(t["text"] for t in tokens)
    assert text.startswith("lorem ipsum dolor ")
    d = check_done(events[-1], text)
    assert d["usage"] == {"input_tokens": 3, "output_tokens": 10}
    t = d["timings"]
    # 20ms first token + 10 x 2ms
    assert 39 <= t["model_ms"] <= 80
    assert 0 < t["first_token_ms"] <= t["server_total_ms"]
    assert t["tool_ms"] == 0


async def test_inventory_mock_stream(client):
    sid = await new_session(client)
    events = await stream(client, sid, "What's our electronics INVENTORY looking like?")
    names = [e[0] for e in events]
    assert names == ["meta", "tool_call"] + ["token"] * 11 + ["done"]
    tc = events[1][1]
    assert tc["name"] == "get_inventory_stats" and tc["args"] == {"category": "electronics"}
    assert tc["result_summary"] == {
        "category": "electronics", "count": 1000, "avg_price": 500.52, "min_price": 1.08, "max_price": 1000.99,
    }
    assert tc["duration_ms"] >= 0 and "db_ms" in tc
    assert events[2][1]["text"] == "Electronics: 1000 items, avg price 500.52. "
    d = check_done(events[-1], "".join(e[1]["text"] for e in events[2:-1]))
    assert d["usage"]["output_tokens"] == 11
    assert d["timings"]["model_ms"] >= 20 + 20 + 10 * 2
    assert d["timings"]["tool_ms"] > 0


async def test_docs_mock_stream(client):
    sid = await new_session(client)
    events = await stream(client, sid, "According to the docs, how is overhead measured?")
    names = [e[0] for e in events]
    assert names == ["meta", "tool_call"] + ["token"] * 11 + ["done"]
    tc = events[1][1]
    assert tc["name"] == "search_knowledge_base"
    assert tc["args"] == {"query": "According to the docs, how is overhead measured?", "top_k": 5}
    assert tc["result_summary"] == {"sources": ["docs/09-RAG.md", "docs/02-TECHNICAL-REQUIREMENTS.md"]}
    assert "embed_ms" in tc and "db_ms" in tc
    assert events[2][1]["text"] == "Based on [docs/09-RAG.md]: "
    # hybrid statement with the mock column, k=5
    sql, args = client.pool.conn.queries[-1]
    assert "embedding_mock" in sql and "fused" in sql and args[1:] == ("According to the docs, how is overhead measured?", 5)


async def test_docs_mock_no_results(client):
    client.pool.conn.search_rows = []
    sid = await new_session(client)
    events = await stream(client, sid, "knowledge please")
    assert events[1][1]["result_summary"] == {"sources": []}
    assert events[2][1]["text"] == "Based on [no results]: "


async def test_history_after_tool_chat(client):
    sid = await new_session(client)
    await stream(client, sid, "inventory?")
    r = await client.get(f"/v1/sessions/{sid}", params={"user_id": "u1"})
    assert r.status_code == 200
    evs = r.json()["events"]
    roles = [(e["role"], e.get("tool")) for e in evs]
    assert roles == [("user", None), ("tool", "get_inventory_stats"), ("tool", "get_inventory_stats"), ("model", None)]
    assert evs[0]["text"] == "inventory?"
    assert evs[-1]["text"].startswith("Electronics: ")
    assert all(e["ts"].endswith("Z") for e in evs)


async def test_non_streaming_chat(client):
    sid = await new_session(client)
    r = await client.post("/v1/chat", json={"user_id": "u1", "session_id": sid, "message": "inventory", "mode": "mock"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"request_id", "session_id", "reply", "tool_calls", "timings", "usage"}
    assert body["reply"].startswith("Electronics: 1000 items")
    assert [t["name"] for t in body["tool_calls"]] == ["get_inventory_stats"]
    st = r.headers["server-timing"]
    for part in ("total;dur=", "model;dur=", "tool;dur=", "session;dur=", "db;dur="):
        assert part in st


async def test_gemini_without_key_is_upstream_error(client):
    sid = await new_session(client)
    events = await stream(client, sid, "hi", mode="gemini")
    assert [e[0] for e in events] == ["meta", "error"]
    assert events[1][1] == {"request_id": "rid-1", "code": "UPSTREAM_ERROR", "message": "GOOGLE_API_KEY not configured"}
    r = await client.post("/v1/chat", json={"user_id": "u1", "session_id": sid, "message": "hi", "mode": "gemini"})
    assert r.status_code == 502 and r.json()["code"] == "UPSTREAM_ERROR"


async def test_validation_and_missing_session(client):
    r = await client.post("/v1/chat/stream", json={"user_id": "u1", "session_id": "s", "message": ""})
    assert r.status_code == 400 and r.json()["code"] == "BAD_REQUEST"
    r = await client.post("/v1/chat/stream", json={"user_id": "u1", "session_id": "s", "message": "x", "mode": "gpt"})
    assert r.status_code == 400
    r = await client.post("/v1/chat/stream", content=b"{not json")
    assert r.status_code == 400
    r = await client.post("/v1/chat/stream", json={"user_id": "u1", "session_id": "nope", "message": "x"})
    assert r.status_code == 404 and r.json()["code"] == "SESSION_NOT_FOUND"
    r = await client.post("/v1/chat", json={"user_id": "u1", "session_id": "nope", "message": "x"})
    assert r.status_code == 404


async def test_session_lifecycle(client):
    sid = await new_session(client, "u9")
    r = await client.get(f"/v1/sessions/{sid}", params={"user_id": "u9"})
    assert r.json() == {"session_id": sid, "events": []}
    assert (await client.get(f"/v1/sessions/{sid}")).status_code == 400
    assert (await client.get(f"/v1/sessions/{sid}", params={"user_id": "other"})).status_code == 404
    assert (await client.delete(f"/v1/sessions/{sid}", params={"user_id": "u9"})).status_code == 204
    assert (await client.delete(f"/v1/sessions/{sid}", params={"user_id": "u9"})).status_code == 404
    r = await client.get(f"/v1/sessions/{sid}", params={"user_id": "u9"})
    assert r.status_code == 404 and r.json()["code"] == "SESSION_NOT_FOUND"


async def test_adk_native_list_apps(client):
    r = await client.get("/list-apps")
    assert r.status_code == 200 and "bench_agent" in r.json()
