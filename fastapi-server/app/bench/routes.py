"""/bench/* endpoints (docs/02 §5.4, contracts/openapi.yaml)."""

from __future__ import annotations

import asyncio
import hashlib
import random

import orjson
from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from app.agent.tools import round_half_away
from app.api.common import add_server_timing, int_param, json_body, json_object
from app.db import get_pool
from app.errors import ApiError, bad_request
from app.instrument import now_ns
from app.responses import ORJSONResponse

router = APIRouter(prefix="/bench", default_response_class=ORJSONResponse)

_PING = orjson.dumps({"ok": True})
SEED = b"bench-seed"


def cpu_hash(n: int) -> str:
    """h = sha256("bench-seed"); n*1000 times h = sha256(h) over raw digests; hex(h)."""
    sha = hashlib.sha256
    h = sha(SEED).digest()
    for _ in range(n * 1000):
        h = sha(h).digest()
    return h.hex()


def json_summary(body: dict) -> dict:
    items = body.get("items")
    if not isinstance(items, list):
        raise bad_request("items must be an array")
    total = 0.0
    for it in items:
        price = it.get("price", 0) if isinstance(it, dict) else 0
        if isinstance(price, (int, float)) and not isinstance(price, bool):
            total += price
    return {"item_count": len(items), "total": round_half_away(total, 2), "echo": items[:10]}


@router.get("/ping")
async def ping():
    return Response(_PING, media_type="application/json")


@router.post("/json")
async def bench_json(request: Request):
    body = await json_object(request)
    return ORJSONResponse(json_summary(body))


@router.get("/cpu")
async def bench_cpu(request: Request):
    n = int_param(request, "n", 25, 1, 1000)
    offload = int_param(request, "offload", 0, 0, 1)
    if offload:
        h = await run_in_threadpool(cpu_hash, n)
    else:
        h = cpu_hash(n)  # deliberately blocks the event loop (honest default behaviour)
    return ORJSONResponse({"n": n, "hash": h})


@router.get("/sleep")
async def bench_sleep(request: Request):
    ms = int_param(request, "ms", 100, 0, 10000)
    await asyncio.sleep(ms / 1000.0)
    return ORJSONResponse({"slept_ms": ms})


_READ_SQL = (
    "SELECT id, sku, name, category, price::float8 AS price, stock, attributes FROM app.bench_items WHERE id = $1"
)
_QUERY_SQL = (
    "SELECT category, count(*)::int AS count, avg(price)::float8 AS avg_price "
    "FROM app.bench_items GROUP BY category ORDER BY category"
)
_WRITE_SQL = "INSERT INTO app.bench_writes(payload) VALUES ($1::jsonb) RETURNING id"


@router.get("/db/read")
async def db_read(request: Request):
    item_id = int_param(request, "id", None, 1, 100000)
    if item_id is None:
        item_id = random.randint(1, 100000)
    t0 = now_ns()
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(_READ_SQL, item_id)
    add_server_timing(request, f"db;dur={(now_ns() - t0) / 1e6:.3f}")
    if row is None:
        raise ApiError(404, "NOT_FOUND", f"bench item {item_id} not found")
    return ORJSONResponse(dict(row))


@router.get("/db/query")
async def db_query(request: Request):
    t0 = now_ns()
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(_QUERY_SQL)
    add_server_timing(request, f"db;dur={(now_ns() - t0) / 1e6:.3f}")
    return ORJSONResponse({"rows": [dict(r) for r in rows]})


@router.post("/db/write")
async def db_write(request: Request):
    raw = await request.body()
    body = await json_body(request)
    if not isinstance(body, dict):
        raise bad_request("request body must be a JSON object")
    t0 = now_ns()
    async with get_pool().acquire() as conn:
        new_id = await conn.fetchval(_WRITE_SQL, raw.decode("utf-8"))
    add_server_timing(request, f"db;dur={(now_ns() - t0) / 1e6:.3f}")
    return ORJSONResponse({"id": new_id}, status_code=201)
