"""/v1/sessions* — backed by ADK's DatabaseSessionService (docs/02 §5.2)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from google.adk.sessions.base_session_service import GetSessionConfig
from starlette.responses import Response

from app.agent import get_bundle
from app.api.common import iso_utc, json_object
from app.config import APP_NAME
from app.errors import ApiError, bad_request
from app.responses import ORJSONResponse

router = APIRouter(prefix="/v1/sessions", default_response_class=ORJSONResponse)


def _user_id(request: Request) -> str:
    uid = request.query_params.get("user_id")
    if not uid:
        raise bad_request("user_id query parameter is required")
    return uid


def event_to_history(ev) -> dict:
    parts = (ev.content.parts or []) if ev.content else []
    text = "".join(p.text for p in parts if p.text and not p.thought)
    out: dict = {}
    fresp = next((p.function_response for p in parts if p.function_response), None)
    fcall = next((p.function_call for p in parts if p.function_call), None)
    if fresp is not None:
        out["role"] = "tool"
        out["tool"] = fresp.name
    elif fcall is not None:
        out["role"] = "tool"
        out["tool"] = fcall.name
    elif ev.author == "user" or (ev.content is not None and ev.content.role == "user"):
        out["role"] = "user"
    else:
        out["role"] = "model"
    out["text"] = text
    out["ts"] = iso_utc(ev.timestamp)
    return out


@router.post("", status_code=201)
async def create_session(request: Request):
    body = await json_object(request)
    uid = body.get("user_id")
    if not isinstance(uid, str) or not uid:
        raise bad_request("user_id is required")
    s = await get_bundle().session_service.create_session(app_name=APP_NAME, user_id=uid)
    return ORJSONResponse(
        {"session_id": s.id, "user_id": s.user_id, "created_at": iso_utc(s.last_update_time)}, status_code=201
    )


@router.get("/{session_id}")
async def get_session(session_id: str, request: Request):
    uid = _user_id(request)
    s = await get_bundle().session_service.get_session(app_name=APP_NAME, user_id=uid, session_id=session_id)
    if s is None:
        raise ApiError(404, "SESSION_NOT_FOUND", f"session {session_id} not found")
    return ORJSONResponse({"session_id": s.id, "events": [event_to_history(e) for e in s.events if not e.partial]})


@router.delete("/{session_id}", status_code=204)
async def delete_session(session_id: str, request: Request):
    uid = _user_id(request)
    ss = get_bundle().session_service
    s = await ss.get_session(
        app_name=APP_NAME, user_id=uid, session_id=session_id, config=GetSessionConfig(num_recent_events=0)
    )
    if s is None:
        raise ApiError(404, "SESSION_NOT_FOUND", f"session {session_id} not found")
    await ss.delete_session(app_name=APP_NAME, user_id=uid, session_id=session_id)
    return Response(status_code=204)
