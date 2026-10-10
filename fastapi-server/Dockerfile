# syntax=docker/dockerfile:1.7
# fastapi-server — build context is the repo root:
#   docker build -f fastapi-server/Dockerfile .                 (runtime image)
#   docker build -f fastapi-server/Dockerfile --target test .   (make test-py)
# Multi-arch: python:3.12-slim and the uv image are published for amd64 + arm64.

FROM ghcr.io/astral-sh/uv:0.12.23 AS uv

FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /srv

# ── dependencies (locked) ───────────────────────────────────────────────
FROM base AS deps
COPY fastapi-server/pyproject.toml fastapi-server/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# ── unit tests (make test-py) ───────────────────────────────────────────
FROM deps AS test
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project
COPY contracts /contracts
COPY fastapi-server/pyproject.toml ./
COPY fastapi-server/app ./app
COPY fastapi-server/tests ./tests
ENV CONTRACTS_DIR=/contracts PATH=/opt/venv/bin:$PATH
RUN python -m pytest -q -p no:cacheprovider

# ── runtime ─────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    PORT=8080 \
    PY_WORKERS=1 \
    CONTRACTS_DIR=/contracts \
    CORPUS_DIR=/corpus \
    PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus-multiproc
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
WORKDIR /srv
COPY --from=deps /opt/venv /opt/venv
COPY contracts /contracts
COPY --chmod=0755 fastapi-server/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY fastapi-server/app ./app
RUN python -m compileall -q app
USER app
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
