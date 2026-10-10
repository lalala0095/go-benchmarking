#!/usr/bin/env bash
# Deletes the Postgres StatefulSet AND its PersistentVolumeClaim, i.e. all data.
# The next `make k8s-up` recreates both, and the db-init scripts run again on
# the empty volume (the k8s equivalent of `docker compose down -v`).
#   FORCE=1 ./reset-db.sh   # skip the confirmation prompt
set -euo pipefail
# shellcheck source=deploy/k8s/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PVC="data-postgres-0"   # <volumeClaimTemplate name>-<statefulset name>-<ordinal>
require_cluster

if [[ "${FORCE:-0}" != "1" ]]; then
  [[ -t 0 ]] || die "refusing to delete data non-interactively; re-run with FORCE=1"
  read -r -p "Delete ALL Postgres data in namespace '$NAMESPACE' (statefulset + PVC $PVC)? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { log "aborted"; exit 0; }
fi

# Deleting a StatefulSet never deletes its PVCs (data safety by design), so
# both steps are needed. --wait makes sure the pod released the volume first.
kubectl -n "$NAMESPACE" delete statefulset postgres --ignore-not-found --wait=true
kubectl -n "$NAMESPACE" delete pvc "$PVC" --ignore-not-found --wait=true
log "postgres data deleted. Recreate with: make k8s-up OVERLAY=<dev|bench|scale>"
log "the servers/dashboard will fail readiness until postgres is back (that's expected)."
