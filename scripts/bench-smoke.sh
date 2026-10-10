#!/usr/bin/env bash
# Smoke test for the benchmark engine: runs ping, db-read and chat-mock (5 s, 1 s warm-up,
# 1 rep, both targets) sequentially through the dashboard API and prints headline numbers.
# Requires: curl, jq. Usage: DASHBOARD_URL=http://localhost:3000 scripts/bench-smoke.sh
set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"
API="${DASHBOARD_URL%/}/api"
read -r -a SCENARIOS <<<"${BENCH_SMOKE_SCENARIOS:-ping db-read chat-mock}"
TIMEOUT_S="${BENCH_SMOKE_TIMEOUT_S:-180}"

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: $bin is required" >&2; exit 2; }
done

curl -fsS --max-time 5 "${API}/health" >/dev/null || { echo "error: dashboard not reachable at ${DASHBOARD_URL}" >&2; exit 2; }

failures=0

run_scenario() {
  local scenario="$1" body resp code run_id status deadline detail
  body=$(jq -nc --arg s "$scenario" \
    '{scenario: $s, config: {duration_s: 5, warmup_s: 1, cooldown_s: 1, reps: 1}, notes: "bench-smoke"}')
  resp=$(curl -sS --max-time 15 -w '\n%{http_code}' -H 'content-type: application/json' -d "$body" "${API}/runs")
  code=$(tail -n1 <<<"$resp")
  resp=$(sed '$d' <<<"$resp")
  if [[ "$code" != "201" ]]; then
    echo "FAIL ${scenario}: POST /api/runs returned ${code}: ${resp}" >&2
    return 1
  fi
  run_id=$(jq -r '.run_id' <<<"$resp")
  echo "== ${scenario}: run ${run_id}"

  deadline=$(( $(date +%s) + TIMEOUT_S ))
  while :; do
    status=$(curl -fsS --max-time 10 "${API}/runs/${run_id}" | jq -r '.run.status')
    case "$status" in
      complete|failed|cancelled) break ;;
    esac
    if (( $(date +%s) > deadline )); then
      echo "FAIL ${scenario}: timed out after ${TIMEOUT_S}s (status ${status}); cancelling" >&2
      curl -sS -X POST "${API}/runs/${run_id}/cancel" >/dev/null || true
      return 1
    fi
    sleep 1
  done

  detail=$(curl -fsS --max-time 10 "${API}/runs/${run_id}")
  if [[ "$status" != "complete" ]]; then
    echo "FAIL ${scenario}: status ${status}: $(jq -r '.run.error // "-"' <<<"$detail")" >&2
    return 1
  fi
  jq -r '
    .summary | to_entries[] |
    "   \(.key | (. + "      ")[0:7]) rps=\(.value.rps // "-")  p99_ms=\(.value.p99_ms // "-")  errors=\(.value.error_pct // "-")%"
  ' <<<"$detail"
  jq -r 'if .run.suspect then "   suspect: " + (.run.suspect_reasons | join("; ")) else empty end' <<<"$detail"
  if [[ "$(jq '[.results[] | select(.requests_total > 0)] | length' <<<"$detail")" -eq 0 ]]; then
    echo "FAIL ${scenario}: no requests recorded" >&2
    return 1
  fi
}

for s in "${SCENARIOS[@]}"; do
  run_scenario "$s" || failures=$((failures + 1))
done

if (( failures > 0 )); then
  echo "bench-smoke: ${failures} scenario(s) failed" >&2
  exit 1
fi
echo "bench-smoke: all ${#SCENARIOS[@]} scenarios complete"
