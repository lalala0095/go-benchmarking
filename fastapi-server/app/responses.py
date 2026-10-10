"""orjson-backed JSON response.

Equivalent to fastapi.responses.ORJSONResponse, which FastAPI 0.141 marks as
deprecated (it emits a FastAPIDeprecationWarning on every instantiation).
"""

from __future__ import annotations

from typing import Any

import orjson
from starlette.responses import Response


class ORJSONResponse(Response):
    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, option=orjson.OPT_NON_STR_KEYS)
