#!/usr/bin/env bash
# Builds the three app images, tags them $REGISTRY/<svc>:$TAG and pushes them
# to the local registry (make registry-up). Postgres comes from Docker Hub.
#   REGISTRY=localhost:5000 TAG=<git sha> ./deploy/k8s/scripts/images.sh
#   SERVICES="go-server" ...   # build a subset
set -euo pipefail
# shellcheck source=deploy/k8s/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REGISTRY="${REGISTRY:-localhost:5000}"
TAG="${TAG:-$(git_sha)}"
read -r -a SERVICES <<<"${SERVICES:-go-server fastapi-server dashboard}"

require_cmd docker
[[ "$TAG" != "latest" ]] || die "refusing TAG=latest: tags must be immutable (use the git sha)"

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)" ]]; then
  warn "working tree has uncommitted changes: tag '$TAG' won't fully describe these images."
  warn "commit first, or use TAG=$TAG-dirty-\$(date +%s) to keep tags immutable."
fi
if is_macos; then
  warn "building on macOS produces $(uname -m) images; the Ubuntu server needs amd64. Build there instead."
fi
curl -fsS "http://${REGISTRY}/v2/" >/dev/null 2>&1 || die "registry $REGISTRY not reachable. Run: make registry-up"

cd "$REPO_ROOT"
for svc in "${SERVICES[@]}"; do
  [[ -f "$svc/Dockerfile" ]] || die "$svc/Dockerfile not found"
  ref="$REGISTRY/$svc:$TAG"
  log "building $ref"
  # Build context = repo root (the Dockerfiles copy contracts/ etc.).
  docker build -f "$svc/Dockerfile" -t "$ref" .
  log "pushing $ref"
  docker push "$ref"
done
log "done. Deploy with: make k8s-up OVERLAY=<dev|bench|scale> TAG=$TAG"
