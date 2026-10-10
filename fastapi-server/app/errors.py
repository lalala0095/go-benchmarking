"""Error shape shared by every custom endpoint (contracts/openapi.yaml#/components/schemas/Error)."""

from __future__ import annotations

from fastapi import Request
from app.responses import ORJSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, request_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id

    def body(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.request_id:
            out["request_id"] = self.request_id
        return out


def bad_request(message: str) -> ApiError:
    return ApiError(400, "BAD_REQUEST", message)


async def api_error_handler(_: Request, exc: ApiError) -> ORJSONResponse:
    return ORJSONResponse(exc.body(), status_code=exc.status)
