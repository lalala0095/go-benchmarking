import json
import math

import pytest

from app.config import Settings
from app.errors import ApiError
from app.rag.embed import GeminiEmbedder, MockEmbedder, l2_normalize, mock_embed
from tests.conftest import CONTRACTS


def test_mock_embed_matches_fixture():
    fx = CONTRACTS / "fixtures" / "rag-embed"
    texts = json.loads((fx / "texts.json").read_text(encoding="utf-8"))
    expected = json.loads((fx / "expected-mock.json").read_text(encoding="utf-8"))
    assert expected["dim"] == 768
    tol = expected.get("tolerance", 1e-6)
    for text, exp in zip(texts, expected["vectors"], strict=True):
        got = mock_embed(text)
        assert len(got) == 768
        assert max(abs(a - b) for a, b in zip(got, exp)) <= tol


def test_mock_embed_zero_vector():
    assert mock_embed("ÄÖÜ !!") == [0.0] * 768


async def test_mock_embedder_batches():
    e = MockEmbedder(Settings(mock_embed_delay_ms=0, embed_batch_size=2))
    out = await e.embed(["a b", "c", "d"])
    assert len(out) == 3 and out[0] == mock_embed("a b")


class _Emb:
    def __init__(self, values):
        self.values = values


class _Resp:
    def __init__(self, n, dim=768):
        self.embeddings = [_Emb([3.0, 4.0] + [0.0] * (dim - 2)) for _ in range(n)]


class FakeModels:
    def __init__(self, fail_times=0, code=429):
        self.calls = []
        self.fail_times = fail_times
        self.code = code

    async def embed_content(self, *, model, contents, config):
        from google.genai import errors

        self.calls.append((model, contents, config))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise errors.ClientError(self.code, {"error": {"code": self.code, "message": "x", "status": "X"}})
        return _Resp(len(contents))


class FakeClient:
    def __init__(self, models):
        self.aio = type("Aio", (), {"models": models})()


async def test_gemini_embedder_batches_normalises_and_retries():
    models = FakeModels(fail_times=2)
    s = Settings(google_api_key="k", embed_batch_size=2, gemini_embed_model="gemini-embedding-2")
    e = GeminiEmbedder(s, client=FakeClient(models))
    e.backoff_base = 0
    out = await e.embed(["a", "b", "c"], task="query")
    assert len(out) == 3
    assert math.isclose(out[0][0], 0.6) and math.isclose(out[0][1], 0.8)
    # 2 failures + 2 batches
    assert len(models.calls) == 4
    _, contents, config = models.calls[-1]
    assert len(contents) == 1 and contents[0].parts[0].text == "c"
    assert config.output_dimensionality == 768
    assert config.task_type is None  # omitted for gemini-embedding-2 (auto)


async def test_gemini_embedder_task_type_for_other_models():
    models = FakeModels()
    s = Settings(google_api_key="k", gemini_embed_model="gemini-embedding-001")
    e = GeminiEmbedder(s, client=FakeClient(models))
    await e.embed(["a"], task="query")
    assert models.calls[0][2].task_type == "RETRIEVAL_QUERY"


async def test_gemini_embedder_gives_up_with_upstream_429():
    models = FakeModels(fail_times=10)
    e = GeminiEmbedder(Settings(google_api_key="k"), client=FakeClient(models))
    e.backoff_base = 0
    with pytest.raises(ApiError) as ei:
        await e.embed(["a"])
    assert ei.value.code == "UPSTREAM_429"
    assert len(models.calls) == 5


async def test_gemini_embedder_no_retry_on_400():
    models = FakeModels(fail_times=1, code=400)
    e = GeminiEmbedder(Settings(google_api_key="k"), client=FakeClient(models))
    with pytest.raises(ApiError) as ei:
        await e.embed(["a"])
    assert ei.value.code == "UPSTREAM_ERROR" and len(models.calls) == 1


async def test_gemini_embedder_without_key():
    e = GeminiEmbedder(Settings(google_api_key=""))
    with pytest.raises(ApiError) as ei:
        await e.embed(["a"])
    assert ei.value.message == "GOOGLE_API_KEY not configured"


def test_l2_normalize():
    assert l2_normalize([0.0, 0.0]) == [0.0, 0.0]
    assert l2_normalize([3.0, 4.0]) == [0.6, 0.8]
