"""bench_agent wiring (contracts/agent-spec.md).

Per worker process: ONE DatabaseSessionService (wrapped for timing) shared by
two LlmAgents/Runners — Gemini and the mock LLM — and by ADK's native routes
(registered in ADK's service registry for the postgresql+asyncpg scheme).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions.base_session_service import BaseSessionService
from google.genai import types

from app.agent.models import TimedGemini
from app.agent.tools import get_current_time, get_inventory_stats, make_search_tool
from app.config import APP_NAME, Settings, get_settings
from app.instrument import TimedSessionService
from app.mockllm import MockLlm

log = logging.getLogger(__name__)

RUN_CONFIG = RunConfig(streaming_mode=StreamingMode.SSE)


def load_instruction(settings: Settings) -> str:
    return (settings.contracts_dir / "agent-instruction.txt").read_text(encoding="utf-8")


def build_agent(model, embedder_mode: str, instruction: str) -> LlmAgent:
    return LlmAgent(
        name=APP_NAME,
        model=model,
        instruction=instruction,
        tools=[make_search_tool(embedder_mode), get_inventory_stats, get_current_time],
        generate_content_config=types.GenerateContentConfig(max_output_tokens=512),
    )


def build_mock_model(settings: Settings) -> MockLlm:
    return MockLlm(
        model="mock",
        first_token_delay_ms=settings.mock_first_token_delay_ms,
        token_delay_ms=settings.mock_token_delay_ms,
        tokens=settings.mock_tokens,
    )


def create_session_service(settings: Settings) -> BaseSessionService:
    from google.adk.sessions.database_session_service import DatabaseSessionService

    inner = DatabaseSessionService(
        db_url=settings.session_db_url,
        pool_size=settings.session_pool_size,
        max_overflow=settings.session_max_overflow,
    )
    return TimedSessionService(inner)


@dataclass
class AgentBundle:
    session_service: BaseSessionService
    gemini_agent: LlmAgent
    mock_agent: LlmAgent
    gemini_runner: Runner
    mock_runner: Runner

    def runner_for(self, mode: str) -> Runner:
        return self.gemini_runner if mode == "gemini" else self.mock_runner

    def model_name(self, mode: str) -> str:
        return get_settings().gemini_model if mode == "gemini" else "mock"


def build_bundle(settings: Settings, session_service: Optional[BaseSessionService] = None) -> AgentBundle:
    instruction = load_instruction(settings)
    ss = session_service or create_session_service(settings)
    gemini_agent = build_agent(TimedGemini(model=settings.gemini_model), "gemini", instruction)
    mock_agent = build_agent(build_mock_model(settings), "mock", instruction)
    return AgentBundle(
        session_service=ss,
        gemini_agent=gemini_agent,
        mock_agent=mock_agent,
        gemini_runner=Runner(app_name=APP_NAME, agent=gemini_agent, session_service=ss),
        mock_runner=Runner(app_name=APP_NAME, agent=mock_agent, session_service=ss),
    )


_bundle: Optional[AgentBundle] = None


def get_bundle() -> AgentBundle:
    global _bundle
    if _bundle is None:
        _bundle = build_bundle(get_settings())
    return _bundle


def set_bundle(b: Optional[AgentBundle]) -> None:
    """Test hook."""
    global _bundle
    _bundle = b
