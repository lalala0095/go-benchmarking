"""Small helpers shared by routers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import orjson
from fastapi import Request

from app.errors import bad_request
from app.instrument import now_ns


async def json_body(request: Request) -> Any:
    raw = await request.body()
    if not raw:
        raise bad_request("request body is required")
    try:
        return orjson.loads(raw)
    except orjson.JSONDecodeError as e:
        raise bad_request(f"invalid JSON: {e}") from None


async def json_object(request: Request) -> dict:
    body = await json_body(request)
    if not isinstance(body, dict):
        raise bad_request("request body must be a JSON object")
    return body


def request_start_ns(request: Request) -> int:
    return request.scope.get("state", {}).get("t0_ns") or now_ns()


def add_server_timing(request: Request, part: str) -> None:
    state = request.scope.setdefault("state", {})
    prev = state.get("server_timing")
    state["server_timing"] = f"{prev}, {part}" if prev else part


def iso_utc(ts: Optional[float]) -> str:
    """Epoch seconds → RFC 3339 UTC with millisecond precision."""
    dt = datetime.fromtimestamp(ts if ts is not None else datetime.now(timezone.utc).timestamp(), tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def int_param(request: Request, name: str, default: Optional[int], lo: int, hi: int) -> Optional[int]:
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        raise bad_request(f"{name} must be an integer") from None
    if not lo <= v <= hi:
        raise bad_request(f"{name} must be in {lo}..{hi}")
    return v
