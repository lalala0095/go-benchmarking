"""Integration tests against a real Postgres (pgvector). Run with TEST_DATABASE_URL=postgresql://…/py_app."""

import httpx
import pytest

from tests.conftest import requires_db

pytestmark = requires_db

PREFIX = "pytest-db/"


@pytest.fixture
async def client():
    from google.adk.sessions.in_memory_session_service import InMemorySessionService

    from app import agent as agent_mod
    from app import config, db
    from app.instrument import TimedSessionService
    from app.rag import search as rag_search
    from app.rag import service

    config.set_settings(config.Settings.from_env())
    s = config.get_settings()
    service.reset_embedders()
    agent_mod.set_bundle(agent_mod.build_bundle(s, session_service=TimedSessionService(InMemorySessionService())))
    rag_search.load_sql(s.sql_dir)
    rag_search.load_queries(s.contracts_dir)
    pool = await db.create_pool(s)
    from app.main import create_app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://t") as c:
        yield c
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM app.rag_documents WHERE source LIKE $1", PREFIX + "%")
    await db.close_pool()


DOCS = [
    {"source": PREFIX + "a.md", "content": "# Alpha\n\nPgvector hybrid search fuses rankings.\n\n## Beta\n\nReciprocal rank fusion."},
    {"source": PREFIX + "b.txt", "content": "Kubernetes rollout strategy uses surge pods."},
]


async def test_ingest_search_stats(client):
    r = await client.post("/v1/rag/ingest", json={"documents": DOCS, "force": True, "embedders": ["mock"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["documents"] == 2 and body["skipped"] == 0 and body["chunks"] == 3 and body["embedders"] == ["mock"]
    assert set(body["timings"]) >= {"read_ms", "chunk_ms", "embed_ms", "db_ms", "total_ms"}
    r = await client.post("/v1/rag/ingest", json={"documents": DOCS})
    assert r.json()["skipped"] == 2 and r.json()["documents"] == 0
    r = await client.post("/v1/rag/ingest", json={"documents": DOCS[:1], "repeat": 2, "force": True})
    assert r.json()["documents"] == 2
    for mode in ("hybrid", "vector", "fts"):
        r = await client.get("/v1/rag/search", params={"q": "reciprocal rank fusion", "mode": mode, "k": 3})
        assert r.status_code == 200, r.text
        res = r.json()["results"]
        assert res, mode
    r = await client.get("/v1/rag/search", params={"q": "reciprocal rank fusion", "mode": "fts", "k": 20})
    assert any(x["source"].endswith("a.md") and x["heading"] == "Beta" for x in r.json()["results"])
    st = (await client.get("/v1/rag/stats")).json()
    assert st["documents"] >= 4 and st["chunks"] >= 5 and st["last_ingested_at"]


async def test_bench_db_and_inventory(client):
    r = await client.get("/bench/db/read", params={"id": 42})
    row = r.json()
    assert row["id"] == 42 and row["sku"] == "SKU-000042" and isinstance(row["attributes"], dict)
    assert "db;dur=" in r.headers["server-timing"]
    assert (await client.get("/bench/db/read")).status_code == 200
    rows = (await client.get("/bench/db/query")).json()["rows"]
    assert len(rows) == 10 and rows[0]["category"] == "auto" and sum(x["count"] for x in rows) == 100000
    r = await client.post("/bench/db/write", json={"hello": "world"})
    assert r.status_code == 201 and isinstance(r.json()["id"], int)
    from app.agent.tools import get_inventory_stats
    from app.instrument import start_request

    start_request()
    inv = await get_inventory_stats("electronics")
    assert inv["count"] == 10000 and inv["min_price"] >= 1


async def test_healthz(client):
    r = await client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok", "db": "ok"}
