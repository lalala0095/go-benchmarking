"""In-process fakes so the API/agent tests run without Postgres."""

from __future__ import annotations

from contextlib import asynccontextmanager


class FakeConn:
    def __init__(self, inventory=(1000, 500.52, 1.08, 1000.99), search_rows=None):
        self.inventory = inventory
        self.search_rows = search_rows if search_rows is not None else [
            {"id": 1, "source": "docs/09-RAG.md", "title": "RAG", "heading": "Chunking", "content": "x" * 900, "score": 0.5},
            {"id": 2, "source": "docs/02-TECHNICAL-REQUIREMENTS.md", "title": "TRD", "heading": "", "content": "y", "score": 0.4},
        ]
        self.queries = []

    async def fetchrow(self, sql, *args):
        self.queries.append((sql, args))
        return self.inventory

    async def fetch(self, sql, *args):
        self.queries.append((sql, args))
        return self.search_rows

    async def fetchval(self, sql, *args):
        self.queries.append((sql, args))
        if "EXISTS" in sql:
            return False
        return 1


class FakePool:
    def __init__(self, conn=None):
        self.conn = conn or FakeConn()

    @asynccontextmanager
    async def acquire(self):
        yield self.conn

    def get_size(self):
        return 2

    def get_idle_size(self):
        return 2


def install_fakes():
    """Fresh settings + in-memory session service + fake pool; returns (bundle, pool)."""
    from google.adk.sessions.in_memory_session_service import InMemorySessionService

    from app import agent as agent_mod
    from app import config, db
    from app.instrument import TimedSessionService
    from app.rag import search as rag_search
    from app.rag import service

    config.set_settings(config.Settings.from_env())
    s = config.get_settings()
    service.reset_embedders()
    bundle = agent_mod.build_bundle(s, session_service=TimedSessionService(InMemorySessionService()))
    agent_mod.set_bundle(bundle)
    pool = FakePool()
    db.set_pool(pool)
    rag_search.load_sql(s.sql_dir)
    rag_search.load_queries(s.contracts_dir)
    return bundle, pool
