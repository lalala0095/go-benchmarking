"""/v1/chat and /v1/chat/stream (docs/02 §5.3, contracts/sse-events.md)."""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass

import orjson
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from google.adk.errors.session_not_found_error import SessionNotFoundError
from google.adk.sessions.base_session_service import GetSessionConfig
from google.genai import types

from app import metrics
from app.agent import RUN_CONFIG, AgentBundle, get_bundle
from app.api.common import json_body, request_start_ns
from app.config import APP_NAME, get_settings
from app.errors import ApiError, bad_request
from app.instrument import Timings, start_request
from app.responses import ORJSONResponse

log = logging.getLogger(__name__)
router = APIRouter(prefix="/v1", default_response_class=ORJSONResponse)

_UPSTREAM_STATUS = re.compile(r"^[A-Z][A-Z_]+$")
_STATUS_FOR_CODE = {
    "BAD_REQUEST": 400,
    "SESSION_NOT_FOUND": 404,
    "NOT_FOUND": 404,
    "UPSTREAM_429": 502,
    "UPSTREAM_ERROR": 502,
    "INTERNAL": 500,
}


@dataclass
class ChatRequest:
    user_id: str
    session_id: str
    message: str
    mode: str
    request_id: str


def parse_chat(body) -> ChatRequest:
    if not isinstance(body, dict):
        raise bad_request("request body must be a JSON object")
    user_id = body.get("user_id")
    session_id = body.get("session_id")
    message = body.get("message")
    mode = body.get("mode") or "mock"
    request_id = body.get("request_id") or str(uuid.uuid4())
    if not isinstance(user_id, str) or not user_id:
        raise bad_request("user_id is required")
    if not isinstance(session_id, str) or not session_id:
        raise bad_request("session_id is required")
    if not isinstance(message, str) or not 1 <= len(message) <= 20000:
        raise bad_request("message must be a string of 1..20000 characters")
    if mode not in ("gemini", "mock"):
        raise bad_request("mode must be 'gemini' or 'mock'")
    if not isinstance(request_id, str):
        raise bad_request("request_id must be a string")
    return ChatRequest(user_id, session_id, message, mode, request_id)


def map_exception(exc: BaseException) -> tuple[str, str]:
    """Exception → (error code, message)."""
    from google.genai import errors as genai_errors

    if isinstance(exc, ApiError):
        return exc.code, exc.message
    if isinstance(exc, SessionNotFoundError):
        return "SESSION_NOT_FOUND", str(exc)
    if isinstance(exc, genai_errors.APIError):
        code = getattr(exc, "code", None)
        return ("UPSTREAM_429" if code == 429 else "UPSTREAM_ERROR"), str(exc)
    return "INTERNAL", f"{type(exc).__name__}: {exc}"


_UPSTREAM_CLASSES = {"ClientError", "ServerError", "APIError", "UnknownApiResponseError", "_ResourceExhaustedError"}


def map_event_error(error_code: str, message: str = "") -> str:
    """ADK 2 turns exceptions raised during a run into an error Event whose
    error_code is the API status (e.g. RESOURCE_EXHAUSTED) or the exception class
    name; model-level failures use finish-reason style codes (SAFETY, …)."""
    c = error_code or ""
    msg = (message or "").lstrip()
    if "RESOURCE_EXHAUSTED" in c.upper() or c == "429" or msg.startswith("429"):
        return "UPSTREAM_429"
    if _UPSTREAM_STATUS.match(c) or c in _UPSTREAM_CLASSES:
        return "UPSTREAM_ERROR"
    return "INTERNAL"


async def ensure_session(bundle: AgentBundle, req: ChatRequest) -> None:
    s = await bundle.session_service.get_session(
        app_name=APP_NAME,
        user_id=req.user_id,
        session_id=req.session_id,
        config=GetSessionConfig(num_recent_events=0),
    )
    if s is None:
        raise ApiError(404, "SESSION_NOT_FOUND", f"session {req.session_id} not found", req.request_id)


def _visible_text(parts) -> str:
    return "".join(p.text for p in parts if p.text and not p.thought)


async def chat_events(req: ChatRequest, bundle: AgentBundle, t: Timings) -> AsyncIterator[tuple[str, dict]]:
    """Drives the ADK runner and yields (event_name, data) per contracts/sse-events.md.

    Never raises: failures become a final ("error", …) item.
    """
    if req.mode == "gemini" and not get_settings().gemini_configured:
        yield "error", {"request_id": req.request_id, "code": "UPSTREAM_ERROR", "message": "GOOGLE_API_KEY not configured"}
        return
    runner = bundle.runner_for(req.mode)
    new_message = types.Content(role="user", parts=[types.Part(text=req.message)])
    seq = 0
    reply: list[str] = []
    input_tokens = output_tokens = 0
    turn_streamed = False
    try:
        async with aclosing(
            runner.run_async(
                user_id=req.user_id, session_id=req.session_id, new_message=new_message, run_config=RUN_CONFIG
            )
        ) as agen:
            async for ev in agen:
                parts = (ev.content.parts or []) if ev.content else []
                if ev.partial:
                    for p in parts:
                        if p.text and not p.thought:
                            seq += 1
                            turn_streamed = True
                            t.mark_first_token()
                            yield "token", {"text": p.text, "seq": seq}
                    continue
                if ev.error_code and not parts:
                    yield "error", {
                        "request_id": req.request_id,
                        "code": map_event_error(ev.error_code, ev.error_message or ""),
                        "message": ev.error_message or ev.error_code,
                    }
                    return
                if ev.usage_metadata is not None:
                    input_tokens += ev.usage_metadata.prompt_token_count or 0
                    output_tokens += ev.usage_metadata.candidates_token_count or 0
                if ev.get_function_responses():
                    for rec in t.pop_new_tools():
                        yield "tool_call", rec.to_event()
                    turn_streamed = False
                    continue
                if ev.author == "user":
                    continue
                text = _visible_text(parts)
                if text:
                    if not turn_streamed:  # model answered without partial chunks
                        seq += 1
                        t.mark_first_token()
                        yield "token", {"text": text, "seq": seq}
                    reply.append(text)
                turn_streamed = False
    except Exception as e:  # noqa: BLE001
        code, message = map_exception(e)
        if code == "INTERNAL":
            log.exception("chat run failed")
        yield "error", {"request_id": req.request_id, "code": code, "message": message}
        return
    for rec in t.pop_new_tools():
        yield "tool_call", rec.to_event()
    t.finish()
    timings = t.snapshot()
    metrics.CHAT_OVERHEAD.labels(req.mode).observe(timings["overhead_ms"] / 1000.0)
    metrics.CHAT_MODEL.labels(req.mode).observe(timings["model_ms"] / 1000.0)
    yield "done", {
        "request_id": req.request_id,
        "reply": "".join(reply),
        "timings": timings,
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
    }


def sse(event: str, data: dict) -> bytes:
    return b"event: " + event.encode() + b"\ndata: " + orjson.dumps(data) + b"\n\n"


async def _prepare(request: Request) -> tuple[ChatRequest, AgentBundle, Timings]:
    t = start_request(request_start_ns(request))
    req = parse_chat(await json_body(request))
    bundle = get_bundle()
    try:
        await ensure_session(bundle, req)
    except ApiError:
        raise
    except Exception as e:  # noqa: BLE001 - DB down etc.
        log.exception("session lookup failed")
        raise ApiError(500, "INTERNAL", f"session lookup failed: {e}", req.request_id) from None
    return req, bundle, t


@router.post("/chat/stream")
async def chat_stream(request: Request):
    req, bundle, t = await _prepare(request)
    settings = get_settings()
    model = settings.gemini_model if req.mode == "gemini" else "mock"

    async def body() -> AsyncIterator[bytes]:
        yield sse(
            "meta",
            {"request_id": req.request_id, "impl": "python", "session_id": req.session_id, "mode": req.mode, "model": model},
        )
        async for name, data in chat_events(req, bundle, t):
            yield sse(name, data)

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/chat")
async def chat(request: Request):
    req, bundle, t = await _prepare(request)
    tool_calls: list[dict] = []
    done: dict | None = None
    async for name, data in chat_events(req, bundle, t):
        if name == "tool_call":
            tool_calls.append(data)
        elif name == "done":
            done = data
        elif name == "error":
            raise ApiError(_STATUS_FOR_CODE.get(data["code"], 500), data["code"], data["message"], req.request_id)
    assert done is not None
    tm = done["timings"]
    header = (
        f"total;dur={tm['server_total_ms']:.3f}, model;dur={tm['model_ms']:.3f}, tool;dur={tm['tool_ms']:.3f}, "
        f"session;dur={tm['session_ms']:.3f}, db;dur={t.db_ns / 1e6:.3f}"
    )
    return ORJSONResponse(
        {
            "request_id": req.request_id,
            "session_id": req.session_id,
            "reply": done["reply"],
            "tool_calls": tool_calls,
            "timings": tm,
            "usage": done["usage"],
        },
        headers={"Server-Timing": header},
    )
