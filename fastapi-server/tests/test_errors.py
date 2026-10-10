from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import errors

from app.agent import AgentBundle
from app.api.chat import ChatRequest, chat_events, map_event_error, map_exception
from app.instrument import start_request


class RaisingLlm(BaseLlm):
    model: str = "raising"
    code: int = 429

    async def generate_content_async(self, llm_request, stream=False):
        if self.code == 0:
            raise KeyError("boom")
        status = "RESOURCE_EXHAUSTED" if self.code == 429 else "UNAVAILABLE"
        cls = errors.ClientError if self.code < 500 else errors.ServerError
        raise cls(self.code, {"error": {"code": self.code, "message": "m", "status": status}})
        yield  # pragma: no cover


def test_map_exception():
    assert map_exception(errors.ClientError(429, {"error": {"code": 429, "message": "m"}}))[0] == "UPSTREAM_429"
    assert map_exception(errors.ServerError(503, {"error": {"code": 503, "message": "m"}}))[0] == "UPSTREAM_ERROR"
    assert map_exception(RuntimeError("x"))[0] == "INTERNAL"
    assert map_event_error("RESOURCE_EXHAUSTED") == "UPSTREAM_429"
    assert map_event_error("ClientError", "429 Too Many Requests") == "UPSTREAM_429"
    assert map_event_error("SAFETY") == "UPSTREAM_ERROR"
    assert map_event_error("ServerError", "500") == "UPSTREAM_ERROR"
    assert map_event_error("KeyError", "boom") == "INTERNAL"


async def _run(code):
    ss = InMemorySessionService()
    agent = LlmAgent(name="bench_agent", model=RaisingLlm(code=code), instruction="x")
    runner = Runner(app_name="bench_agent", agent=agent, session_service=ss)
    bundle = AgentBundle(ss, agent, agent, runner, runner)
    s = await ss.create_session(app_name="bench_agent", user_id="u")
    req = ChatRequest("u", s.id, "hello", "mock", "r1")
    return [x async for x in chat_events(req, bundle, start_request())]


async def test_model_429_becomes_upstream_429_event():
    out = await _run(429)
    assert out[-1][0] == "error" and out[-1][1]["code"] == "UPSTREAM_429" and out[-1][1]["request_id"] == "r1"


async def test_model_500_becomes_upstream_error_event():
    out = await _run(500)
    assert out[-1][0] == "error" and out[-1][1]["code"] == "UPSTREAM_ERROR"


async def test_internal_exception_becomes_internal_event():
    out = await _run(0)
    assert out[-1][0] == "error" and out[-1][1]["code"] == "INTERNAL"
