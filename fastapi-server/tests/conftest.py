"""Test setup: point at the contracts dir and use tiny mock delays.

Unit tests need no database; tests marked `db` run only when TEST_DATABASE_URL is set.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _contracts_dir() -> Path:
    env = os.environ.get("CONTRACTS_DIR")
    if env and Path(env).is_dir():
        return Path(env)
    for cand in (Path("/contracts"), ROOT.parent / "contracts"):
        if cand.is_dir():
            return cand
    raise RuntimeError("contracts directory not found; set CONTRACTS_DIR")


CONTRACTS = _contracts_dir()
os.environ["CONTRACTS_DIR"] = str(CONTRACTS)
os.environ.pop("PROMETHEUS_MULTIPROC_DIR", None)
os.environ.setdefault("GOOGLE_API_KEY", "")
os.environ["MOCK_FIRST_TOKEN_DELAY_MS"] = "20"
os.environ["MOCK_TOKEN_DELAY_MS"] = "2"
os.environ["MOCK_TOKENS"] = "10"
os.environ["MOCK_EMBED_DELAY_MS"] = "1"
if os.environ.get("TEST_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]


@pytest.fixture
def contracts() -> Path:
    return CONTRACTS


requires_db = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL not set")
