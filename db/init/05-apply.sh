#!/bin/bash
# Applies schemas to the three databases. *.psql files are ignored by the
# postgres entrypoint, so they only run from here. Keep this directory flat:
# k8s mounts it from a ConfigMap (no subdirectories).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --no-password)

for db in go_app py_app; do
  echo "applying app schema + seed to $db"
  "${PSQL[@]}" --dbname "$db" -f "$DIR/app-schema.psql"
  "${PSQL[@]}" --dbname "$db" -f "$DIR/seed.psql"
done

echo "applying dashboard schema"
"${PSQL[@]}" --dbname dashboard -f "$DIR/dashboard-schema.psql"
