"""asyncpg pool for bench / tool / RAG queries (docs/02 §4.2)."""

from __future__ import annotations

import logging
from typing import Optional

import asyncpg
import orjson
from pgvector.asyncpg import register_vector

from app.config import Settings

log = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None


def _jsonb_encode(v) -> str:
    # Raw JSON text (already validated) is passed through untouched.
    return v if isinstance(v, str) else orjson.dumps(v).decode()


async def _init_conn(conn: asyncpg.Connection) -> None:
    await register_vector(conn)
    for typ in ("jsonb", "json"):
        await conn.set_type_codec(typ, schema="pg_catalog", encoder=_jsonb_encode, decoder=orjson.loads, format="text")


async def create_pool(settings: Settings) -> asyncpg.Pool:
    global _pool
    size = settings.pool_max_per_worker
    _pool = await asyncpg.create_pool(
        dsn=settings.asyncpg_dsn,
        min_size=min(2, size),
        max_size=size,
        init=_init_conn,
        server_settings={"search_path": "app,public", "application_name": "fastapi-server"},
    )
    log.info("asyncpg pool ready (max_size=%d)", size)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("database pool not initialised")
    return _pool


def pool_or_none() -> Optional[asyncpg.Pool]:
    return _pool


def set_pool(pool: Optional[asyncpg.Pool]) -> None:
    """Test hook."""
    global _pool
    _pool = pool
