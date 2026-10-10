"""Mock LLM (contracts/agent-spec.md "Mock LLM"). Driven by the ADK runner exactly like Gemini."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from typing import Any, Optional

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.models._capabilities import LlmCapabilities
from google.genai import types

from app.instrument import timed_model_stream

WORDS = [
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do",
    "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua",
]  # fmt: skip

_ASCII_WS = " \t\n\v\f\r"


def _fmt_num(x: Any) -> str:
    """Shortest round-trip formatting matching Go's %v for float64 (500.0 -> "500")."""
    if isinstance(x, bool):
        return str(x).lower()
    if isinstance(x, float):
        if x.is_integer() and abs(x) < 1e21:
            return str(int(x))
        return repr(x)
    return str(x)


async def _sleep_until(loop: asyncio.AbstractEventLoop, deadline: float) -> None:
    delay = deadline - loop.time()
    await asyncio.sleep(delay if delay > 0 else 0)


def _word_count(text: str) -> int:
    return len(text.split())


def _text_of(content: types.Content) -> str:
    return "".join(p.text for p in (content.parts or []) if p.text and not p.thought)


def _last_user_text(contents: list[types.Content]) -> str:
    for c in reversed(contents):
        if c.role == "user" and any(p.text for p in (c.parts or [])):
            if not any(p.function_response for p in (c.parts or [])):
                return _text_of(c)
    return ""


def _last_function_response(contents: list[types.Content]) -> Optional[types.FunctionResponse]:
    if not contents:
        return None
    for p in contents[-1].parts or []:
        if p.function_response is not None:
            return p.function_response
    return None


class MockLlm(BaseLlm):
    """Scripted model. All waits use `await asyncio.sleep` (non-blocking)."""

    model: str = "mock"
    first_token_delay_ms: int = 250
    token_delay_ms: int = 15
    tokens: int = 60

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        async for r in timed_model_stream(self._generate(llm_request, stream)):
            yield r

    async def _generate(self, llm_request: LlmRequest, stream: bool) -> AsyncGenerator[LlmResponse, None]:
        contents = llm_request.contents or []
        user_text = _last_user_text(contents)
        fr = _last_function_response(contents)
        first_delay = self.first_token_delay_ms / 1000.0

        if fr is None:
            m = user_text.lower()
            if "inventory" in m:
                await asyncio.sleep(first_delay)
                yield self._function_call("get_inventory_stats", {"category": "electronics"})
                return
            if "docs" in m or "knowledge" in m:
                await asyncio.sleep(first_delay)
                yield self._function_call("search_knowledge_base", {"query": user_text, "top_k": 5})
                return
            prefix = ""
        else:
            prefix = self._prefix_for(fr)

        async for r in self._stream_text(prefix, user_text, stream):
            yield r

    @staticmethod
    def _prefix_for(fr: types.FunctionResponse) -> str:
        resp = fr.response or {}
        if fr.name == "get_inventory_stats":
            return f"Electronics: {_fmt_num(resp.get('count'))} items, avg price {_fmt_num(resp.get('avg_price'))}. "
        if fr.name == "search_knowledge_base":
            results = resp.get("results") or []
            if results:
                return f"Based on [{results[0].get('source')}]: "
            return "Based on [no results]: "
        return ""

    def _function_call(self, name: str, args: dict) -> LlmResponse:
        return LlmResponse(
            content=types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))]),
            partial=False,
            turn_complete=True,
            finish_reason=types.FinishReason.STOP,
            model_version=self.model,
        )

    async def _stream_text(self, prefix: str, user_text: str, stream: bool) -> AsyncGenerator[LlmResponse, None]:
        # Waits are scheduled against absolute deadlines from the start of the
        # call, so event-loop timer granularity (~1 ms per sleep with uvloop) does
        # not accumulate over 60 tokens; total ≈ FIRST_TOKEN_DELAY + N×TOKEN_DELAY.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.first_token_delay_ms / 1000.0
        await _sleep_until(loop, deadline)
        token_delay = self.token_delay_ms / 1000.0
        pieces: list[str] = []
        if prefix:
            pieces.append(prefix)
            if stream:
                yield self._partial(prefix)
        for i in range(self.tokens):
            deadline += token_delay
            await _sleep_until(loop, deadline)
            chunk = WORDS[i % len(WORDS)] + " "
            pieces.append(chunk)
            if stream:
                yield self._partial(chunk)
        output_tokens = self.tokens + (1 if prefix else 0)
        input_tokens = _word_count(user_text)
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="".join(pieces))]),
            partial=False,
            turn_complete=True,
            finish_reason=types.FinishReason.STOP,
            model_version=self.model,
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=input_tokens,
                candidates_token_count=output_tokens,
                total_token_count=input_tokens + output_tokens,
            ),
        )

    def _partial(self, text: str) -> LlmResponse:
        return LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            partial=True,
            model_version=self.model,
        )
