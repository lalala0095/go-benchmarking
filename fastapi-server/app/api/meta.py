"""/healthz, /v1/info, /metrics (docs/02 §5.1)."""

from __future__ import annotations

import asyncio
import importlib.metadata as md
import platform
from datetime import datetime, timezone

from fastapi import APIRouter
from starlette.responses import Response

from app import metrics
from app.config import get_settings
from app.db import pool_or_none
from app.responses import ORJSONResponse

router = APIRouter(default_response_class=ORJSONResponse)

STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _version(dist: str) -> str:
    try:
        return md.version(dist)
    except md.PackageNotFoundError:
        return "unknown"


@router.get("/healthz")
async def healthz():
    pool = pool_or_none()
    ok = False
    if pool is not None:
        try:
            async with asyncio.timeout(2):
                async with pool.acquire() as conn:
                    ok = (await conn.fetchval("SELECT 1")) == 1
        except Exception:  # noqa: BLE001
            ok = False
    if ok:
        return ORJSONResponse({"status": "ok", "db": "ok"})
    return ORJSONResponse({"status": "degraded", "db": "error"}, status_code=503)


def info_payload() -> dict:
    s = get_settings()
    cpu_limit, mem_limit = metrics.cgroup_limits()
    return {
        "impl": "python",
        "runtime": f"cpython{platform.python_version()}",
        "adk_version": _version("google-adk"),
        "framework": f"fastapi {_version('fastapi')} / uvicorn {_version('uvicorn')}",
        "workers": s.py_workers,
        "gomaxprocs": None,
        "model": s.gemini_model,
        "embed_model": s.gemini_embed_model,
        "gemini_configured": s.gemini_configured,
        "db_pool_max": s.db_pool_max,
        "cgroup_cpu_limit": cpu_limit,
        "cgroup_memory_limit_bytes": mem_limit,
        "started_at": STARTED_AT,
    }


@router.get("/v1/info")
async def info():
    return ORJSONResponse(info_payload())


@router.get("/metrics")
async def prometheus_metrics():
    body, ctype = metrics.render(get_settings().py_workers)
    return Response(body, media_type=ctype)
