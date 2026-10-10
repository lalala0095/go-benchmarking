"""Per-request timing accumulator (docs/02 §5.3, contracts/sse-events.md "Timings").

A single mutable `Timings` object is stored in a ContextVar. Child tasks spawned
by the ADK runner copy the context, so they hold a reference to the *same*
object and their additions are visible to the request handler. When no
accumulator is set (e.g. ADK's native /run_sse routes) every hook is a no-op.
"""

from __future__ import annotations

import contextvars
import time
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Optional

from google.adk.events.event import Event
from google.adk.sessions.base_session_service import (
    BaseSessionService,
    GetSessionConfig,
    ListSessionsResponse,
)
from google.adk.sessions.session import Session

now_ns = time.perf_counter_ns


def ms(ns: int) -> float:
    return round(ns / 1e6, 3)


@dataclass
class ToolRecord:
    name: str
    args: dict
    duration_ns: int
    result_summary: dict
    embed_ns: Optional[int] = None
    db_ns: Optional[int] = None

    def to_event(self) -> dict:
        out: dict[str, Any] = {
            "name": self.name,
            "args": self.args,
            "duration_ms": ms(self.duration_ns),
            "result_summary": self.result_summary,
        }
        if self.embed_ns is not None:
            out["embed_ms"] = ms(self.embed_ns)
        if self.db_ns is not None:
            out["db_ms"] = ms(self.db_ns)
        return out


@dataclass
class Timings:
    start_ns: int = field(default_factory=now_ns)
    model_ns: int = 0
    tool_ns: int = 0
    session_ns: int = 0
    db_ns: int = 0  # DB time inside tools (for Server-Timing)
    first_token_ns: Optional[int] = None  # absolute perf_counter_ns of the first token write
    end_ns: Optional[int] = None
    tools: list[ToolRecord] = field(default_factory=list)
    _tools_emitted: int = 0

    def mark_first_token(self) -> None:
        if self.first_token_ns is None:
            self.first_token_ns = now_ns()

    def finish(self) -> None:
        self.end_ns = now_ns()

    def pop_new_tools(self) -> list[ToolRecord]:
        new = self.tools[self._tools_emitted :]
        self._tools_emitted = len(self.tools)
        return new

    def snapshot(self) -> dict:
        end = self.end_ns if self.end_ns is not None else now_ns()
        total = end - self.start_ns
        overhead = max(0, total - self.model_ns - self.tool_ns - self.session_ns)
        first = 0 if self.first_token_ns is None else self.first_token_ns - self.start_ns
        return {
            "server_total_ms": ms(total),
            "first_token_ms": ms(first),
            "model_ms": ms(self.model_ns),
            "tool_ms": ms(self.tool_ns),
            "session_ms": ms(self.session_ns),
            "overhead_ms": ms(overhead),
        }


_current: contextvars.ContextVar[Optional[Timings]] = contextvars.ContextVar("bench_timings", default=None)


def start_request(start_ns: Optional[int] = None) -> Timings:
    t = Timings(start_ns=start_ns if start_ns is not None else now_ns())
    _current.set(t)
    return t


def current() -> Optional[Timings]:
    return _current.get()


def add_model(ns: int) -> None:
    t = _current.get()
    if t is not None:
        t.model_ns += ns


def add_session(ns: int) -> None:
    t = _current.get()
    if t is not None:
        t.session_ns += ns


def record_tool(rec: ToolRecord) -> None:
    t = _current.get()
    if t is not None:
        t.tool_ns += rec.duration_ns
        if rec.db_ns:
            t.db_ns += rec.db_ns
        t.tools.append(rec)


async def timed_model_stream(agen: AsyncGenerator) -> AsyncIterator:
    """Yields from a model generator, adding its wall time to model_ms.

    Contract (sse-events.md): from calling the model until its last chunk is
    yielded, summed over model calls. Time the consumer (ADK flow, SSE writer)
    spends between chunks therefore counts as model time.
    """
    t0 = now_ns()
    last = None
    try:
        async for item in agen:
            last = now_ns()
            yield item
    finally:
        add_model((last if last is not None else now_ns()) - t0)
        await agen.aclose()


class TimedSessionService(BaseSessionService):
    """Delegating session service that adds every call's duration to session_ms."""

    def __init__(self, inner: BaseSessionService):
        self.inner = inner

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: Optional[dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> Session:
        t0 = now_ns()
        try:
            return await self.inner.create_session(
                app_name=app_name, user_id=user_id, state=state, session_id=session_id
            )
        finally:
            add_session(now_ns() - t0)

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: Optional[GetSessionConfig] = None,
    ) -> Optional[Session]:
        t0 = now_ns()
        try:
            return await self.inner.get_session(
                app_name=app_name, user_id=user_id, session_id=session_id, config=config
            )
        finally:
            add_session(now_ns() - t0)

    async def list_sessions(self, *, app_name: str, user_id: Optional[str] = None) -> ListSessionsResponse:
        t0 = now_ns()
        try:
            return await self.inner.list_sessions(app_name=app_name, user_id=user_id)
        finally:
            add_session(now_ns() - t0)

    async def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> None:
        t0 = now_ns()
        try:
            return await self.inner.delete_session(app_name=app_name, user_id=user_id, session_id=session_id)
        finally:
            add_session(now_ns() - t0)

    async def get_user_state(self, *, app_name: str, user_id: str) -> dict[str, Any]:
        t0 = now_ns()
        try:
            return await self.inner.get_user_state(app_name=app_name, user_id=user_id)
        finally:
            add_session(now_ns() - t0)

    async def append_event(self, session: Session, event: Event) -> Event:
        if event.partial:  # the inner service returns immediately for partials
            return await self.inner.append_event(session, event)
        t0 = now_ns()
        try:
            return await self.inner.append_event(session, event)
        finally:
            add_session(now_ns() - t0)

    async def flush(self) -> None:
        t0 = now_ns()
        try:
            return await self.inner.flush()
        finally:
            add_session(now_ns() - t0)

    async def close(self) -> None:
        close = getattr(self.inner, "close", None)
        if close is not None:
            await close()

    def __getattr__(self, name: str) -> Any:
        # Anything not part of the BaseSessionService surface (e.g. prepare_tables,
        # db_engine) is forwarded untimed.
        return getattr(self.inner, name)
