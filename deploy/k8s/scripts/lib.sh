#!/usr/bin/env bash
# Shared helpers for deploy/k8s/scripts/*.sh. Sourced, never executed.
# shellcheck disable=SC2034  # variables here are used by the sourcing scripts

if [[ -t 2 ]]; then
  _C_BLUE=$'\033[34m' _C_YELLOW=$'\033[33m' _C_RED=$'\033[31m' _C_OFF=$'\033[0m'
else
  _C_BLUE='' _C_YELLOW='' _C_RED='' _C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$_C_BLUE" "$_C_OFF" "$*" >&2; }
warn() { printf '%swarning:%s %s\n' "$_C_YELLOW" "$_C_OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$_C_RED" "$_C_OFF" "$*" >&2; exit 1; }

# Repo root = three levels above this file (deploy/k8s/scripts).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
K8S_DIR="$REPO_ROOT/deploy/k8s"
NAMESPACE="${NAMESPACE:-bench}"

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' not found in PATH. See docs/08-UBUNTU-SETUP.md (make setup-host)."
  done
}

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

git_sha() {
  if [[ -n "${GIT_SHA:-}" ]]; then
    printf '%s\n' "$GIT_SHA"
  else
    git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'dev\n'
  fi
}

# Fails with a helpful message when kubectl can't reach a cluster.
require_cluster() {
  require_cmd kubectl
  if ! kubectl version --request-timeout=5s >/dev/null 2>&1; then
    if is_macos; then
      die "kubectl can't reach a cluster. k3s runs on the Ubuntu server, not on the Mac: run this there (ssh <user>@<ubuntu-host>)."
    fi
    die "kubectl can't reach a cluster. Is k3s running? (sudo systemctl start k3s; check ~/.kube/config)"
  fi
}

# read_env_file FILE KEY -> prints the value of KEY from a dotenv file without
# sourcing it (sourcing would execute arbitrary shell). Strips one layer of
# matching quotes. Prints nothing if the key is absent.
read_env_file() {
  local file="$1" key="$2" line val=""
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$ ]] || continue
    val="${BASH_REMATCH[2]}"
    val="${val#"${val%%[![:space:]]*}"}"   # trim leading space
    val="${val%"${val##*[![:space:]]}"}"   # trim trailing space
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi
  done <"$file"
  printf '%s' "$val"
}
