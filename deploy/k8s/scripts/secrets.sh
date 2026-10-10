#!/usr/bin/env bash
# Creates/updates the Secrets the manifests reference, from .env (git-ignored):
#   gemini                GOOGLE_API_KEY (optional: without it only mock mode works)
#   postgres-credentials  POSTGRES_USER / POSTGRES_PASSWORD (default bench/bench)
# Uses `create --dry-run=client -o yaml | apply` so re-running updates in place.
# Values are never printed. Secrets are only base64-encoded, not encrypted:
# anyone who can `kubectl get secret -n bench` can read them.
set -euo pipefail
# shellcheck source=deploy/k8s/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
require_cluster

if [[ ! -f "$ENV_FILE" ]]; then
  warn "$ENV_FILE not found: using defaults (no Gemini key, postgres bench/bench). Run 'make env' to create it."
fi

google_key="$(read_env_file "$ENV_FILE" GOOGLE_API_KEY)"
pg_user="$(read_env_file "$ENV_FILE" POSTGRES_USER)"
pg_pass="$(read_env_file "$ENV_FILE" POSTGRES_PASSWORD)"
pg_user="${pg_user:-bench}"
pg_pass="${pg_pass:-bench}"

# The namespace must exist before anything can be created in it.
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

gemini_args=()
if [[ -n "$google_key" ]]; then
  gemini_args+=("--from-literal=GOOGLE_API_KEY=$google_key")
else
  warn "GOOGLE_API_KEY is empty: Secret 'gemini' created without it (mock mode only)."
fi
kubectl -n "$NAMESPACE" create secret generic gemini "${gemini_args[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic postgres-credentials \
  --from-literal=POSTGRES_USER="$pg_user" \
  --from-literal=POSTGRES_PASSWORD="$pg_pass" \
  --dry-run=client -o yaml | kubectl apply -f -

log "secrets ready in namespace $NAMESPACE (env vars from Secrets are read at pod start: restart pods to pick up changes)"
