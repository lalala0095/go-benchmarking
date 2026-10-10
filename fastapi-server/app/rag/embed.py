"""Embedders (docs/09-RAG.md §3): deterministic mock + Gemini (google-genai)."""

from __future__ import annotations

import asyncio
import logging
import math
import re
from array import array

from app.config import Settings
from app.errors import ApiError

log = logging.getLogger(__name__)

EMBED_DIM = 768
_TOKEN = re.compile(r"[A-Za-z0-9]+")


def fnv1a32(data: bytes) -> int:
    h = 2166136261
    for b in data:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def mock_embed(text: str) -> list[float]:
    """Hashing-trick bag of words, L2-normalised, rounded to float32 (as stored in pgvector)."""
    v = [0.0] * EMBED_DIM
    for tok in _TOKEN.findall(text):
        h = fnv1a32(tok.lower().encode("ascii"))
        v[h % EMBED_DIM] += 1.0 if (h >> 31) == 0 else -1.0
    norm = math.sqrt(sum(x * x for x in v))
    if norm == 0:
        return v
    return array("f", [x / norm for x in v]).tolist()


def l2_normalize(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in values))
    if norm == 0:
        return list(values)
    return [x / norm for x in values]


class MockEmbedder:
    name = "mock"

    def __init__(self, settings: Settings):
        self._delay = settings.mock_embed_delay_ms / 1000.0
        self._batch = settings.embed_batch_size

    async def embed(self, texts: list[str], task: str = "document") -> list[list[float]]:
        """One simulated network round trip (MOCK_EMBED_DELAY_MS) per batch call."""
        out: list[list[float]] = []
        for i in range(0, len(texts), self._batch):
            batch = texts[i : i + self._batch]
            if self._delay > 0:
                await asyncio.sleep(self._delay)
            out.extend(mock_embed(t) for t in batch)
        return out


def _task_type_enabled(settings: Settings) -> bool:
    mode = settings.gemini_embed_task_type
    if mode in ("on", "true", "1"):
        return True
    if mode in ("off", "false", "0"):
        return False
    # auto: gemini-embedding-2 takes the task as part of the content instead of a
    # task_type field, so it is omitted for that family and kept for older models.
    return "gemini-embedding-2" not in settings.gemini_embed_model


class GeminiEmbedder:
    name = "gemini"
    max_tries = 5

    def __init__(self, settings: Settings, client=None):
        self._settings = settings
        self._client = client
        self._batch = settings.embed_batch_size
        self._use_task_type = _task_type_enabled(settings)
        self.backoff_base = 1.0

    @property
    def client(self):
        if self._client is None:
            if not self._settings.google_api_key:
                raise ApiError(502, "UPSTREAM_ERROR", "GOOGLE_API_KEY not configured")
            from google import genai

            self._client = genai.Client(api_key=self._settings.google_api_key)
        return self._client

    async def embed(self, texts: list[str], task: str = "document") -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), self._batch):
            out.extend(await self._embed_batch(texts[i : i + self._batch], task))
        return out

    async def _embed_batch(self, texts: list[str], task: str) -> list[list[float]]:
        from google.genai import errors as genai_errors
        from google.genai import types

        config = types.EmbedContentConfig(output_dimensionality=EMBED_DIM)
        if self._use_task_type:
            config.task_type = "RETRIEVAL_QUERY" if task == "query" else "RETRIEVAL_DOCUMENT"
        # One Content per text: a list of plain strings is merged into a single
        # multi-part Content (one combined embedding) for gemini-embedding-2.
        contents = [types.Content(parts=[types.Part(text=t)]) for t in texts]
        delay = self.backoff_base
        for attempt in range(1, self.max_tries + 1):
            try:
                resp = await self.client.aio.models.embed_content(
                    model=self._settings.gemini_embed_model, contents=contents, config=config
                )
                embeddings = resp.embeddings or []
                if len(embeddings) != len(texts):
                    raise ApiError(
                        502,
                        "UPSTREAM_ERROR",
                        f"embedding count mismatch: got {len(embeddings)} for {len(texts)} texts",
                    )
                return [l2_normalize(list(e.values or [])) for e in embeddings]
            except genai_errors.APIError as e:
                code = getattr(e, "code", None) or 0
                retryable = code == 429 or code >= 500
                if retryable and attempt < self.max_tries:
                    log.warning("gemini embed attempt %d failed (%s), retrying in %.1fs", attempt, code, delay)
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise ApiError(
                    502, "UPSTREAM_429" if code == 429 else "UPSTREAM_ERROR", f"gemini embed failed: {e}"
                ) from e
        raise AssertionError("unreachable")
