"""/v1/rag/* (docs/09-RAG.md §5–6)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.responses import Response

from app.api.common import add_server_timing, int_param, json_object
from app.errors import bad_request
from app.instrument import ms, now_ns
from app.rag import search as rag_search
from app.rag import service
from app.rag.chunker import chunk
from app.responses import ORJSONResponse

router = APIRouter(prefix="/v1/rag", default_response_class=ORJSONResponse)


@router.post("/chunk")
async def rag_chunk(request: Request):
    body = await json_object(request)
    content = body.get("content")
    if not isinstance(content, str):
        raise bad_request("content must be a string")
    return ORJSONResponse({"chunks": chunk(content)})


@router.post("/embed")
async def rag_embed(request: Request):
    t0 = now_ns()
    body = await json_object(request)
    texts = body.get("texts")
    embedder = body.get("embedder") or "mock"
    task = body.get("task") or "document"
    if not isinstance(texts, list) or not all(isinstance(x, str) for x in texts):
        raise bad_request("texts must be an array of strings")
    if len(texts) > 256:
        raise bad_request("at most 256 texts")
    if embedder not in ("mock", "gemini"):
        raise bad_request("embedder must be mock or gemini")
    if task not in ("document", "query"):
        raise bad_request("task must be document or query")
    te = now_ns()
    vectors = await service.get_embedder(embedder).embed(texts, task=task) if texts else []
    embed_ns = now_ns() - te
    return ORJSONResponse(
        {"dim": 768, "vectors": vectors, "timings": {"embed_ms": ms(embed_ns), "total_ms": ms(now_ns() - t0)}}
    )


@router.get("/search")
async def rag_search_endpoint(request: Request):
    t0 = now_ns()
    qp = request.query_params
    preset = qp.get("preset")
    if preset is not None and preset != "random":
        raise bad_request("preset must be 'random'")
    q = rag_search.random_query() if preset == "random" else qp.get("q")
    if not q:
        raise bad_request("q is required unless preset=random")
    k = int_param(request, "k", 5, 1, 20)
    mode = qp.get("mode") or "hybrid"
    embedder = qp.get("embedder") or "mock"
    if mode not in rag_search.MODES:
        raise bad_request("mode must be hybrid, vector or fts")
    if embedder not in rag_search.EMBEDDERS:
        raise bad_request("embedder must be mock or gemini")
    res = await service.search(q, k, mode, embedder)
    add_server_timing(request, f"db;dur={res.db_ns / 1e6:.3f}")
    return ORJSONResponse(
        {
            "query": q,
            "mode": mode,
            "embedder": embedder,
            "results": [
                {
                    "source": r["source"],
                    "title": r["title"],
                    "heading": r["heading"],
                    "content": r["content"],
                    "score": float(r["score"]),
                }
                for r in res.rows
            ],
            "timings": {"embed_ms": ms(res.embed_ns), "db_ms": ms(res.db_ns), "total_ms": ms(now_ns() - t0)},
        }
    )


@router.get("/stats")
async def rag_stats():
    return ORJSONResponse(await service.stats())


@router.post("/ingest")
async def rag_ingest(request: Request):
    body = await json_object(request)
    out = await service.ingest(body)
    add_server_timing(request, f"db;dur={out['timings']['db_ms']:.3f}")
    return ORJSONResponse(out)


@router.delete("/documents", status_code=204)
async def rag_delete():
    await service.wipe()
    return Response(status_code=204)
