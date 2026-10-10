"""Agent tools (contracts/agent-spec.md "Tools"). Each call records a ToolRecord for timing/SSE."""

from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.db import get_pool
from app.instrument import ToolRecord, now_ns, record_tool
from app.rag import search as rag_search
from app.rag.service import get_embedder

log = logging.getLogger(__name__)

TOOL_CONTENT_MAX = 800

INVENTORY_SQL = (
    "SELECT count(*)::int, coalesce(avg(price),0)::float8, coalesce(min(price),0)::float8, "
    "coalesce(max(price),0)::float8 FROM app.bench_items WHERE category = $1"
)


def round_half_away(x: float, places: int = 2) -> float:
    """Go's math.Round(x*10^p)/10^p (half away from zero)."""
    scale = 10.0**places
    y = x * scale
    r = math.trunc(y)
    if abs(y - r) >= 0.5:
        r += math.copysign(1.0, y)
    return r / scale


def rfc3339(dt: datetime) -> str:
    """Second precision with offset; UTC renders as 'Z' (Go time.RFC3339)."""
    s = dt.replace(microsecond=0).isoformat()
    return s[:-6] + "Z" if s.endswith("+00:00") else s


async def get_inventory_stats(category: str) -> dict:
    """Get inventory statistics (count, avg/min/max price) for a product category."""
    t0 = now_ns()
    try:
        async with get_pool().acquire() as conn:
            tdb = now_ns()
            row = await conn.fetchrow(INVENTORY_SQL, category)
            db_ns = now_ns() - tdb
        result = {
            "category": category,
            "count": row[0],
            "avg_price": round_half_away(row[1]),
            "min_price": row[2],
            "max_price": row[3],
        }
    except Exception as e:  # report to the model instead of failing the run
        log.exception("get_inventory_stats failed")
        db_ns = None
        result = {"error": f"get_inventory_stats failed: {e}"}
    record_tool(
        ToolRecord(
            name="get_inventory_stats",
            args={"category": category},
            duration_ns=now_ns() - t0,
            result_summary=result,
            db_ns=db_ns,
        )
    )
    return result


async def get_current_time(timezone: str) -> dict:  # noqa: A002 - name fixed by the contract
    """Get the current time in an IANA timezone."""
    t0 = now_ns()
    result: dict[str, Any]
    try:
        tz = ZoneInfo(timezone) if timezone else None
    except (ZoneInfoNotFoundError, ValueError, OSError):
        tz = None
    if tz is None:
        result = {"timezone": "UTC", "iso": rfc3339(datetime.now(_UTC)), "note": "unknown timezone, used UTC"}
    else:
        result = {"timezone": timezone, "iso": rfc3339(datetime.now(tz))}
    record_tool(
        ToolRecord(name="get_current_time", args={"timezone": timezone}, duration_ns=now_ns() - t0, result_summary=result)
    )
    return result


_UTC = timezone.utc


def make_search_tool(embedder_mode: str) -> Callable:
    """search_knowledge_base bound to the chat mode's embedder (gemini → gemini, else mock)."""

    async def search_knowledge_base(query: str, top_k: int = 5) -> dict:
        """Search the project knowledge base and return the most relevant passages."""
        t0 = now_ns()
        try:
            k = max(1, min(20, int(top_k)))
        except (TypeError, ValueError):
            k = 5
        embed_ns = 0
        db_ns = 0
        try:
            pool = get_pool()
            embedder = "mock"
            if embedder_mode == "gemini":
                async with pool.acquire() as conn:
                    tdb = now_ns()
                    if await rag_search.has_gemini_chunks(conn):
                        embedder = "gemini"
                    db_ns += now_ns() - tdb
            te = now_ns()
            vec = (await get_embedder(embedder).embed([query], task="query"))[0]
            embed_ns = now_ns() - te
            async with pool.acquire() as conn:
                rows, q_ns = await rag_search.run_search(conn, "hybrid", embedder, vec, query, k)
            db_ns += q_ns
            results = [
                {"source": r["source"], "heading": r["heading"], "content": r["content"][:TOOL_CONTENT_MAX]}
                for r in rows
            ]
            result: dict = {"results": results}
            summary: dict = {"sources": [r["source"] for r in results]}
        except Exception as e:
            log.exception("search_knowledge_base failed")
            result = {"results": [], "error": f"search failed: {e}"}
            summary = {"sources": []}
        record_tool(
            ToolRecord(
                name="search_knowledge_base",
                args={"query": query, "top_k": top_k},
                duration_ns=now_ns() - t0,
                result_summary=summary,
                embed_ns=embed_ns,
                db_ns=db_ns,
            )
        )
        return result

    return search_knowledge_base
