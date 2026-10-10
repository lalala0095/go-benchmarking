"""Timing decorator around ADK's Gemini model (model_ms)."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

from app.instrument import timed_model_stream


class TimedGemini(Gemini):
    """ADK's Gemini model with time spent awaiting chunks added to the request's model_ms."""

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        async for r in timed_model_stream(super().generate_content_async(llm_request, stream)):
            yield r
