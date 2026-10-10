import httpx
import pytest

from app.rag.embed import mock_embed
from tests.conftest import CONTRACTS
from tests.fakes import install_fakes


@pytest.fixture
async def client():
    _, pool = install_fakes()
    from app.main import create_app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://t") as c:
        c.pool = pool
        yield c


async def test_chunk_endpoint(client):
    text = (CONTRACTS / "fixtures" / "rag-chunking" / "cases" / "01-basic.md").read_text()
    r = await client.post("/v1/rag/chunk", json={"content": text})
    assert r.status_code == 200
    chunks = r.json()["chunks"]
    assert chunks and list(chunks[0]) == ["chunk_index", "heading", "content"]
    assert (await client.post("/v1/rag/chunk", json={})).status_code == 400


async def test_embed_endpoint(client):
    r = await client.post("/v1/rag/embed", json={"texts": ["hello world", "x"], "embedder": "mock"})
    body = r.json()
    assert body["dim"] == 768 and body["vectors"][0] == mock_embed("hello world")
    assert set(body["timings"]) == {"embed_ms", "total_ms"}
    assert (await client.post("/v1/rag/embed", json={"texts": ["a"] * 257})).status_code == 400
    r = await client.post("/v1/rag/embed", json={"texts": ["a"], "embedder": "gemini"})
    assert r.status_code == 502 and r.json()["code"] == "UPSTREAM_ERROR"


@pytest.mark.parametrize("mode,marker", [("hybrid", "fused"), ("vector", "1 - ("), ("fts", "ts_rank_cd")])
async def test_search_endpoint_modes(client, mode, marker):
    r = await client.get("/v1/rag/search", params={"q": "chunking", "mode": mode, "k": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "chunking" and body["mode"] == mode and body["embedder"] == "mock"
    assert set(body["results"][0]) == {"source", "title", "heading", "content", "score"}
    assert len(body["results"][0]["content"]) == 900  # untruncated outside the tool
    sql, args = client.pool.conn.queries[-1]
    assert marker in sql and "embedding_mock" in sql or mode == "fts"
    assert args[1:] == ("chunking", 3) and len(args[0]) == 768
    assert "db;dur=" in r.headers["server-timing"]


async def test_search_validation_and_preset(client):
    assert (await client.get("/v1/rag/search")).status_code == 400
    assert (await client.get("/v1/rag/search", params={"q": "x", "k": 21})).status_code == 400
    assert (await client.get("/v1/rag/search", params={"q": "x", "mode": "bm25"})).status_code == 400
    r = await client.get("/v1/rag/search", params={"preset": "random"})
    assert r.status_code == 200 and r.json()["query"]


async def test_ingest_validation(client):
    assert (await client.post("/v1/rag/ingest", json={})).status_code == 400
    r = await client.post("/v1/rag/ingest", json={"corpus": "default", "embedders": ["gemini"]})
    assert r.status_code == 400
    assert (await client.post("/v1/rag/ingest", json={"corpus": "default", "repeat": 0})).status_code == 400
