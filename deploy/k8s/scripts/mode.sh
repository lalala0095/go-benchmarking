#!/usr/bin/env bash
# Switches the Ubuntu server between the two stacks. Never run both while
# benchmarking: they compete for the same CPUs.
#   ./mode.sh compose   stop k3s (all pods), then docker compose up -d
#   ./mode.sh k8s       docker compose down (volumes kept), start k3s, deploy OVERLAY
# Env: OVERLAY (k8s, default dev), BENCH=1 (compose: add docker-compose.bench.yml pinning),
#      REGISTRY, TAG (k8s images; default localhost:5000 / git sha).
set -euo pipefail
# shellcheck source=deploy/k8s/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="${1:-}"
[[ "$MODE" == "compose" || "$MODE" == "k8s" ]] || die "usage: $0 compose|k8s"

if is_macos; then
  die "mode switching is for the Ubuntu server (k3s runs there via systemd). On the Mac just use 'make up' / 'make down'."
fi
require_cmd docker sudo

compose_files=(-f "$REPO_ROOT/docker-compose.yml")
[[ "${BENCH:-0}" != "1" ]] || compose_files+=(-f "$REPO_ROOT/docker-compose.bench.yml")

k3s_active() { systemctl is-active --quiet k3s; }

case "$MODE" in
  compose)
    if [[ -x /usr/local/bin/k3s-killall.sh ]]; then
      if k3s_active; then
        log "stopping k3s"
        sudo systemctl stop k3s
      fi
      # Stopping the service leaves pods (containerd shims) running on purpose,
      # so k3s upgrades don't kill workloads. killall stops them and frees the
      # CPUs. Idempotent: safe when nothing is running.
      log "stopping remaining k3s pods (k3s-killall.sh)"
      sudo /usr/local/bin/k3s-killall.sh >/dev/null
    else
      log "k3s not installed, nothing to stop"
    fi
    log "starting compose stack"
    (cd "$REPO_ROOT" && docker compose "${compose_files[@]}" up -d)
    log "compose mode: http://localhost:3000"
    ;;
  k8s)
    log "stopping compose stack (volumes kept)"
    (cd "$REPO_ROOT" && docker compose down)   # NOT -v: keep the compose DB
    command -v k3s >/dev/null 2>&1 || die "k3s not installed. Run: make setup-host"
    log "starting k3s"
    sudo systemctl start k3s
    require_cmd kubectl
    for _ in $(seq 1 60); do
      kubectl get nodes >/dev/null 2>&1 && break
      sleep 2
    done
    kubectl wait --for=condition=Ready node --all --timeout=120s
    # The registry is a plain Docker container, unaffected by compose down.
    "$K8S_DIR/scripts/registry-up.sh"
    REGISTRY="${REGISTRY:-localhost:5000}"
    TAG="${TAG:-$(git_sha)}"
    tags="$(curl -fsS "http://$REGISTRY/v2/go-server/tags/list" 2>/dev/null || true)"
    if [[ "$tags" != *"\"$TAG\""* ]]; then
      warn "image $REGISTRY/go-server:$TAG not in the registry; building + pushing images first"
      REGISTRY="$REGISTRY" TAG="$TAG" "$K8S_DIR/scripts/images.sh"
    fi
    "$K8S_DIR/scripts/sync.sh"
    "$K8S_DIR/scripts/secrets.sh"
    OVERLAY="${OVERLAY:-dev}" REGISTRY="$REGISTRY" TAG="$TAG" "$K8S_DIR/scripts/apply.sh"
    ;;
esac
