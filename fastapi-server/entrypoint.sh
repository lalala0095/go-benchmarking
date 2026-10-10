#!/bin/sh
# fastapi-server entrypoint: fresh Prometheus multiprocess dir, one-time ADK
# session-table init (before workers fork, avoiding create_all races), then uvicorn.
set -eu

PORT="${PORT:-8080}"
PY_WORKERS="${PY_WORKERS:-1}"
export PROMETHEUS_MULTIPROC_DIR="${PROMETHEUS_MULTIPROC_DIR:-/tmp/prometheus-multiproc}"

# Honour a pre-set dir (k8s mounts an emptyDir there): wipe its contents, keep the dir.
mkdir -p "$PROMETHEUS_MULTIPROC_DIR"
find "$PROMETHEUS_MULTIPROC_DIR" -mindepth 1 -delete

python -m app.init_db

exec uvicorn app.main:app \
  --host 0.0.0.0 --port "$PORT" \
  --workers "$PY_WORKERS" \
  --loop uvloop --http httptools \
  --no-access-log \
  --timeout-keep-alive 120 \
  --timeout-graceful-shutdown 20
