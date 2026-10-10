"""FastAPI app: ADK's get_fast_api_app (native routes kept) + the shared /v1 and /bench contract."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from google.adk.cli.fast_api import get_fast_api_app
from google.adk.cli.service_registry import get_service_registry

from app import metrics
from app.agent import get_bundle
from app.api import chat, meta, rag, sessions
from app.bench import routes as bench
from app.config import get_settings
from app.db import close_pool, create_pool
from app.errors import ApiError, api_error_handler
from app.rag import search as rag_search

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("fastapi-server")

AGENTS_DIR = Path(__file__).resolve().parent / "agents_dir"


async def _create_pool_with_retry(settings, attempts: int = 30) -> None:
    for i in range(1, attempts + 1):
        try:
            await create_pool(settings)
            return
        except (OSError, Exception) as e:  # noqa: BLE001
            if i == attempts:
                raise
            log.warning("database not ready (%s), retrying (%d/%d)", e, i, attempts)
            await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    rag_search.load_sql(settings.sql_dir)
    rag_search.load_queries(settings.contracts_dir)
    await _create_pool_with_retry(settings)
    metrics.DB_POOL_MAX.set(settings.pool_max_per_worker)
    sampler = asyncio.create_task(metrics.sampler_loop())
    log.info("fastapi-server worker ready (workers=%d, model=%s)", settings.py_workers, settings.gemini_model)
    try:
        yield
    finally:
        sampler.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sampler
        await close_pool()
        with contextlib.suppress(Exception):
            await get_bundle().session_service.close()
        metrics.mark_dead()


def create_app() -> FastAPI:
    settings = get_settings()
    bundle = get_bundle()
    # Hand ADK's native routes the same (timed) DatabaseSessionService instance the
    # /v1 runners use, instead of letting ADK build a second engine for the URI.
    get_service_registry().register_session_service(
        "postgresql+asyncpg", lambda uri, **kwargs: bundle.session_service
    )
    app = get_fast_api_app(
        agents_dir=str(AGENTS_DIR),
        session_service_uri=settings.session_db_url,
        use_local_storage=False,
        web=False,
        lifespan=lifespan,
    )
    app.add_exception_handler(ApiError, api_error_handler)
    for r in (meta.router, sessions.router, chat.router, rag.router, bench.router):
        app.include_router(r)
    app.add_middleware(metrics.MetricsMiddleware)
    return app


app = create_app()
