"""Environment configuration (docs/02-TECHNICAL-REQUIREMENTS.md §4.3)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

APP_NAME = "bench_agent"


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def to_asyncpg_sqlalchemy_url(url: str) -> str:
    """postgresql://… or postgres://… → postgresql+asyncpg://… (query string dropped).

    asyncpg (via SQLAlchemy) rejects libpq-only params such as sslmode, so the
    query string is removed.
    """
    parts = urlsplit(url)
    scheme = parts.scheme
    if scheme in ("postgres", "postgresql"):
        scheme = "postgresql+asyncpg"
    return urlunsplit((scheme, parts.netloc, parts.path, "", ""))


def to_asyncpg_dsn(url: str) -> str:
    """Normalise to a plain postgresql:// DSN accepted by asyncpg.connect/create_pool."""
    parts = urlsplit(url)
    scheme = parts.scheme
    if scheme in ("postgres", "postgresql+asyncpg"):
        scheme = "postgresql"
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, ""))


@dataclass(frozen=True)
class Settings:
    port: int = 8080
    google_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_embed_model: str = "gemini-embedding-2"
    gemini_embed_task_type: str = "auto"  # auto | on | off
    database_url: str = "postgresql://bench:bench@localhost:5432/py_app"
    db_pool_max: int = 10
    py_workers: int = 1
    session_pool_size: int = 10
    session_max_overflow: int = 10
    mock_first_token_delay_ms: int = 250
    mock_token_delay_ms: int = 15
    mock_tokens: int = 60
    mock_embed_delay_ms: int = 40
    embed_batch_size: int = 100
    corpus_dir: Path = field(default_factory=lambda: Path("/corpus"))
    contracts_dir: Path = field(default_factory=lambda: Path("/contracts"))
    sql_dir: Path = field(default_factory=lambda: Path("/contracts/sql"))

    @property
    def gemini_configured(self) -> bool:
        return bool(self.google_api_key)

    @property
    def session_db_url(self) -> str:
        return to_asyncpg_sqlalchemy_url(self.database_url)

    @property
    def asyncpg_dsn(self) -> str:
        return to_asyncpg_dsn(self.database_url)

    @property
    def pool_max_per_worker(self) -> int:
        return max(2, self.db_pool_max // max(1, self.py_workers))

    @classmethod
    def from_env(cls) -> "Settings":
        contracts = Path(os.environ.get("CONTRACTS_DIR", "/contracts"))
        return cls(
            port=_int("PORT", 8080),
            google_api_key=os.environ.get("GOOGLE_API_KEY", "").strip(),
            gemini_model=os.environ.get("GEMINI_MODEL", "").strip() or "gemini-3.5-flash-lite",
            gemini_embed_model=os.environ.get("GEMINI_EMBED_MODEL", "").strip() or "gemini-embedding-2",
            gemini_embed_task_type=(os.environ.get("GEMINI_EMBED_TASK_TYPE", "").strip() or "auto").lower(),
            database_url=os.environ.get("DATABASE_URL", "").strip()
            or "postgresql://bench:bench@localhost:5432/py_app",
            db_pool_max=_int("DB_POOL_MAX", 10),
            py_workers=max(1, _int("PY_WORKERS", 1)),
            session_pool_size=_int("SESSION_DB_POOL_SIZE", 10),
            session_max_overflow=_int("SESSION_DB_MAX_OVERFLOW", 10),
            mock_first_token_delay_ms=_int("MOCK_FIRST_TOKEN_DELAY_MS", 250),
            mock_token_delay_ms=_int("MOCK_TOKEN_DELAY_MS", 15),
            mock_tokens=_int("MOCK_TOKENS", 60),
            mock_embed_delay_ms=_int("MOCK_EMBED_DELAY_MS", 40),
            embed_batch_size=max(1, _int("EMBED_BATCH_SIZE", 100)),
            corpus_dir=Path(os.environ.get("CORPUS_DIR", "/corpus")),
            contracts_dir=contracts,
            sql_dir=Path(os.environ.get("SQL_DIR", "") or (contracts / "sql")),
        )


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings


def set_settings(s: Settings) -> None:
    """Test hook."""
    global _settings
    _settings = s
