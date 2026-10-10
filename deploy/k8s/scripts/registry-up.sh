#!/usr/bin/env bash
# Starts a local image registry (registry:2) on 127.0.0.1:5000 under Docker.
# k3s pulls localhost:5000/* from it (deploy/k8s/host/registries.yaml).
# Idempotent: safe to run any number of times.
set -euo pipefail
# shellcheck source=deploy/k8s/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

NAME="${REGISTRY_CONTAINER:-bench-registry}"
PORT="${REGISTRY_PORT:-5000}"

require_cmd docker
docker info >/dev/null 2>&1 || die "Docker daemon not reachable (is it running? are you in the docker group?)"

state="$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || true)"
case "$state" in
  running)
    log "registry '$NAME' already running" ;;
  "")
    log "starting registry '$NAME' on 127.0.0.1:$PORT"
    # 127.0.0.1 only: Docker-published ports bypass ufw, so never bind 0.0.0.0.
    # Named volume keeps pushed images across container re-creation.
    if ! docker run -d --name "$NAME" --restart unless-stopped \
        -p "127.0.0.1:${PORT}:5000" -v bench-registry-data:/var/lib/registry registry:2 >/dev/null; then
      is_macos && warn "On macOS port 5000 is often taken by AirPlay Receiver (System Settings > General > AirDrop & Handoff), or set REGISTRY_PORT."
      die "could not start the registry"
    fi ;;
  *)
    log "registry '$NAME' exists ($state), starting it"
    docker start "$NAME" >/dev/null ;;
esac

# The registry answers {} on /v2/ when healthy.
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/v2/" >/dev/null 2>&1; then
    log "registry ready: http://127.0.0.1:${PORT}/v2/_catalog"
    exit 0
  fi
  sleep 0.5
done
die "registry did not become ready on 127.0.0.1:$PORT (docker logs $NAME)"
