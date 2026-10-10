"""Retrieval using the shared SQL files in contracts/sql (docs/09-RAG.md §6)."""

from __future__ import annotations

import json
import random
from pathlib import Path

from app.instrument import now_ns

MODES = ("hybrid", "vector", "fts")
EMBEDDERS = ("mock", "gemini")
_EMB_COL = {"gemini": "embedding_gemini", "mock": "embedding_mock"}  # fixed whitelist

_statements: dict[tuple[str, str], str] = {}
_queries: list[str] = []


def load_sql(sql_dir: Path) -> dict[tuple[str, str], str]:
    """Loads rag_search_{mode}.sql and expands {{EMB_COL}} → 6 statements."""
    out: dict[tuple[str, str], str] = {}
    for mode in MODES:
        raw = (sql_dir / f"rag_search_{mode}.sql").read_text(encoding="utf-8")
        for embedder, col in _EMB_COL.items():
            out[(mode, embedder)] = raw.replace("{{EMB_COL}}", col)
    _statements.clear()
    _statements.update(out)
    return out


def load_queries(contracts_dir: Path) -> list[str]:
    path = contracts_dir / "fixtures" / "rag-queries.json"
    qs = json.loads(path.read_text(encoding="utf-8"))
    _queries.clear()
    _queries.extend(qs)
    return qs


def random_query() -> str:
    return random.choice(_queries)


def statement(mode: str, embedder: str) -> str:
    return _statements[(mode, embedder)]


async def run_search(conn, mode: str, embedder: str, vector: list[float], query: str, k: int):
    """Returns (rows, db_ns). asyncpg prepares and caches the statement per connection."""
    sql = _statements[(mode, embedder)]
    t0 = now_ns()
    rows = await conn.fetch(sql, vector, query, k)
    return rows, now_ns() - t0


async def has_gemini_chunks(conn) -> bool:
    return bool(
        await conn.fetchval("SELECT EXISTS (SELECT 1 FROM app.rag_chunks WHERE embedding_gemini IS NOT NULL)")
    )
