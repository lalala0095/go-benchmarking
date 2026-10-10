#!/usr/bin/env bash
# One-time setup of the Ubuntu 24.04 benchmark server (docs/08-UBUNTU-SETUP.md §2):
# base tools, Docker Engine (official apt repo), k3s (+ our host config),
# kubeconfig, k9s/helm/kustomize, then the §2.5 checks. Idempotent.
#
# Usage: ./scripts/ubuntu-setup.sh [--no-k3s] [--no-extras] [--with-adk-samples]
#   --no-k3s            skip k3s (Compose-only machine)
#   --no-extras         skip k9s / helm / kustomize snaps
#   --with-adk-samples  clone google/adk-{samples,go,python} into ../adk_samples
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_K3S=1 WITH_EXTRAS=1 WITH_ADK=0
for arg in "$@"; do
  case "$arg" in
    --no-k3s) WITH_K3S=0 ;;
    --no-extras) WITH_EXTRAS=0 ;;
    --with-adk-samples) WITH_ADK=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
[[ "$(uname -s)" == "Linux" ]] || die "this script sets up the Ubuntu server; on macOS use Docker Desktop (see README)."
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "expected Ubuntu, found ${PRETTY_NAME:-unknown}"
[[ "${VERSION_ID:-}" == "24.04" ]] || warn "tested on Ubuntu 24.04, this is $VERSION_ID"
(( EUID != 0 )) || die "run as your normal user (it uses sudo where needed), so the docker group and ~/.kube go to you"
sudo -v || die "sudo is required"

# --- 2.1 base tools ----------------------------------------------------------
log "installing base tools"
sudo apt-get update -q
# linux-tools-$(uname -r) may not exist for every kernel flavour: install best-effort.
sudo apt-get install -y -q git make curl jq ca-certificates gnupg htop linux-tools-common
sudo apt-get install -y -q "linux-tools-$(uname -r)" || warn "linux-tools-$(uname -r) not available (perf is optional)"

# --- 2.2 Docker Engine (not Desktop, not snap) -------------------------------
if snap list docker >/dev/null 2>&1; then
  warn "the docker SNAP is installed; it has confinement quirks. Consider: sudo snap remove docker"
fi
if ! dpkg -s docker-ce >/dev/null 2>&1; then
  log "installing Docker Engine from download.docker.com"
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -q
  sudo apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker Engine already installed ($(docker --version 2>/dev/null || echo '?'))"
fi
sudo systemctl enable --now docker
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  warn "added $USER to the docker group: log out and back in (or 'newgrp docker') before using docker without sudo"
fi
ctx="$(docker context show 2>/dev/null || echo default)"
[[ "$ctx" == "default" ]] || warn "active docker context is '$ctx'; benchmarks need Docker Engine: docker context use default"
sudo docker run --rm hello-world >/dev/null && log "docker hello-world OK"

# --- 2.3 k3s -----------------------------------------------------------------
if (( WITH_K3S )); then
  # Config files FIRST: k3s reads them on start (servicelb disabled, local registry).
  log "installing k3s host config into /etc/rancher/k3s/"
  sudo mkdir -p /etc/rancher/k3s
  changed=0
  for f in k3s-config.yaml:config.yaml registries.yaml:registries.yaml; do
    src="$REPO_ROOT/deploy/k8s/host/${f%%:*}" dst="/etc/rancher/k3s/${f##*:}"
    if ! sudo cmp -s "$src" "$dst" 2>/dev/null; then
      sudo install -m 0644 "$src" "$dst"
      changed=1
    fi
  done
  if ! command -v k3s >/dev/null 2>&1; then
    log "installing k3s (stable channel)"
    curl -sfL https://get.k3s.io | sh -
  elif (( changed )); then
    log "k3s config changed, restarting k3s"
    sudo systemctl restart k3s
  else
    log "k3s already installed ($(k3s --version | head -1))"
  fi
  log "copying kubeconfig to ~/.kube/config"
  for _ in $(seq 1 30); do sudo test -f /etc/rancher/k3s/k3s.yaml && break; sleep 2; done
  mkdir -p "$HOME/.kube"
  sudo cp /etc/rancher/k3s/k3s.yaml "$HOME/.kube/config"
  sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
  chmod 600 "$HOME/.kube/config"
  kubectl wait --for=condition=Ready node --all --timeout=180s || warn "node not Ready yet: kubectl get nodes"
fi

# --- extras --------------------------------------------------------------------
if (( WITH_EXTRAS )); then
  log "installing k9s, helm, kustomize (snaps)"
  snap list k9s >/dev/null 2>&1 || sudo snap install k9s --devmode || warn "k9s install failed (optional)"
  snap list helm >/dev/null 2>&1 || sudo snap install helm --classic || warn "helm install failed (optional)"
  snap list kustomize >/dev/null 2>&1 || sudo snap install kustomize || warn "kustomize install failed (optional)"
fi

# --- optional: ADK reference repos -------------------------------------------
if (( WITH_ADK )); then
  adk_dir="$(dirname "$REPO_ROOT")/adk_samples"
  mkdir -p "$adk_dir"
  for r in adk-samples adk-go adk-python; do
    if [[ -d "$adk_dir/$r/.git" ]]; then
      log "$r already cloned"
    else
      git clone --depth 1 "https://github.com/google/$r.git" "$adk_dir/$r"
    fi
  done
fi

# --- 2.5 checks ----------------------------------------------------------------
log "checks"
fs="$(stat -fc %T /sys/fs/cgroup)"
if [[ "$fs" == "cgroup2fs" ]]; then echo "  cgroup v2: OK"; else warn "cgroup fs is '$fs', expected cgroup2fs (servers read cgroup v2 stats)"; fi
sudo docker info 2>/dev/null | grep -E "Cgroup (Driver|Version)" | sed 's/^ */  /'
echo "  CPUs: $(nproc)   RAM: $(free -g | awk '/^Mem:/{print $2}') GiB"
(( $(nproc) >= 12 )) || warn "fewer than 12 threads: lower SERVER_CPUS/DASH_CPUS in .env (docs/08 §1)"
log "done. Next: make tune-host (before benchmarks), make up-bench or make mode-k8s OVERLAY=bench"
