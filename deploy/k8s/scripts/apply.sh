#!/usr/bin/env bash
# Renders an overlay with the image tag pinned and applies it, then waits for
# every rollout. Never edits files in the repo: the tag and .env overrides go
# into a throwaway wrapper kustomization in a temp dir.
#   OVERLAY=dev|bench|scale REGISTRY=localhost:5000 TAG=<git sha> ./apply.sh
#   RENDER_ONLY=1 ...   # print the final YAML instead of applying (no cluster needed)
set -euo pipefail
# shellcheck source=deploy/k8s/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OVERLAY="${OVERLAY:-dev}"
REGISTRY="${REGISTRY:-localhost:5000}"
TAG="${TAG:-$(git_sha)}"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
RENDER_ONLY="${RENDER_ONLY:-0}"
TIMEOUT="${ROLLOUT_TIMEOUT:-5m}"
OVERLAY_DIR="$K8S_DIR/overlays/$OVERLAY"

[[ -d "$OVERLAY_DIR" ]] || die "unknown OVERLAY '$OVERLAY' (use dev, bench or scale)"
[[ -f "$K8S_DIR/base/generated/kustomization.yaml" ]] || "$K8S_DIR/scripts/sync.sh"
require_cmd kubectl

# Server settings that may be tuned in .env (same names as docker-compose.yml).
# Merged into the server-env ConfigMap; a change rolls the servers (hash suffix).
ENV_KEYS=(GEMINI_MODEL GEMINI_EMBED_MODEL DB_POOL_MAX MOCK_FIRST_TOKEN_DELAY_MS
  MOCK_TOKEN_DELAY_MS MOCK_TOKENS MOCK_EMBED_DELAY_MS EMBED_BATCH_SIZE)

yaml_str() {  # double-quoted YAML scalar
  local s="${1//\\/\\\\}"
  printf '"%s"' "${s//\"/\\\"}"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"
# Kustomize rejects absolute resource paths, so build "../../<abs path>" from
# the temp dir up to / and back down to the overlay.
up=""
IFS=/ read -r -a parts <<<"${tmp#/}"
for _ in "${parts[@]}"; do up+="../"; done
overlay_rel="${up}$(cd "$OVERLAY_DIR" && pwd -P | sed 's|^/||')"
{
  echo "apiVersion: kustomize.config.k8s.io/v1beta1"
  echo "kind: Kustomization"
  echo "namespace: $NAMESPACE"
  echo "resources:"
  echo "  - $overlay_rel"
  echo "images:"
  for svc in go-server fastapi-server dashboard; do
    echo "  - name: localhost:5000/$svc"
    echo "    newName: $REGISTRY/$svc"
    echo "    newTag: $(yaml_str "$TAG")"
  done
  echo "configMapGenerator:"
  echo "  - name: build-info"
  echo "    behavior: merge"
  echo "    literals:"
  echo "      - $(yaml_str "GIT_SHA=$TAG")"
  overrides=()
  for k in "${ENV_KEYS[@]}"; do
    v="$(read_env_file "$ENV_FILE" "$k")"
    [[ -z "$v" ]] || overrides+=("$k=$v")
  done
  if (( ${#overrides[@]} > 0 )); then
    echo "  - name: server-env"
    echo "    behavior: merge"
    echo "    literals:"
    for kv in "${overrides[@]}"; do echo "      - $(yaml_str "$kv")"; done
  fi
} >"$tmp/kustomization.yaml"

if [[ "$RENDER_ONLY" == "1" ]]; then
  kubectl kustomize "$tmp"
  exit 0
fi

require_cluster
log "applying overlay '$OVERLAY' with images $REGISTRY/*:$TAG"
# Server-side apply: the API server tracks field ownership. It also avoids the
# 256 KiB last-applied annotation limit that client-side apply hits with large
# ConfigMaps (the RAG corpus). --force-conflicts: we are the source of truth.
kubectl apply --server-side --force-conflicts --field-manager=go-benchmarking -k "$tmp"

# Leaving an overlay with HPAs (scale) for one without: apply never deletes
# objects that are no longer in the YAML, so remove stale HPAs explicitly.
if [[ "$OVERLAY" != "scale" ]]; then
  kubectl -n "$NAMESPACE" delete hpa go-server fastapi-server --ignore-not-found
fi

log "waiting for rollouts (timeout $TIMEOUT each)"
kubectl -n "$NAMESPACE" rollout status statefulset/postgres --timeout="$TIMEOUT"
for d in go-server fastapi-server dashboard; do
  if ! kubectl -n "$NAMESPACE" rollout status "deployment/$d" --timeout="$TIMEOUT"; then
    warn "deployment/$d not ready. Debug with:"
    warn "  kubectl -n $NAMESPACE get pods -l app.kubernetes.io/name=$d"
    warn "  kubectl -n $NAMESPACE describe pod -l app.kubernetes.io/name=$d   # ImagePullBackOff? run 'make images TAG=$TAG'"
    warn "  kubectl -n $NAMESPACE logs deploy/$d --all-containers"
    exit 1
  fi
done

kubectl -n "$NAMESPACE" get pods -o wide
log "ready. Dashboard: make k8s-open, then http://localhost:8080"
