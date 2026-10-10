# 08 — Ubuntu 24.04 Host Setup

The **deployment server** is **Ubuntu 24.04 LTS** on an **AMD Ryzen 5 4600G (6 cores / 12 threads), 16 GB DDR4**. Development happens on the Mac (Docker Desktop, arm64). The Ubuntu box pulls from GitHub, builds its own amd64 images, and runs the stack. Official benchmark numbers come only from the Ubuntu box.

**Accessing the dashboard from the Mac:** all ports stay bound to `127.0.0.1` on the server. Use an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 -L 8080:localhost:8080 <user>@<ubuntu-host>
# Compose: http://localhost:3000   k8s (after `make k8s-open` on the server): http://localhost:8080
```

**Deploy loop:** `git push` on the Mac, then on the server run `git pull && make up-bench` (or `make mode-k8s OVERLAY=bench`).

`scripts/ubuntu-setup.sh` (one-time) and `scripts/ubuntu-tune.sh` (before benchmark sessions) automate everything below. The foundation agent writes them in Phase 0, and you run them.

---

## 1. Hardware guidance

| | Minimum | Recommended |
|---|---|---|
| CPU | 8 threads | 12+ threads (**this box: 12**) |
| RAM | 16 GB (**this box**) | 32 GB |
| Disk | 30 GB free SSD | 60 GB+ NVMe |

The default limits use 10 CPUs: Postgres 2, go-server 2, fastapi-server 2, dashboard/load generator 4. **On a desktop you must also leave about 2 cores for GNOME and the browser** that renders the live charts. On an 8-thread machine, set `SERVER_CPUS=1` and `DASH_CPUS=2` in `.env`. The UI always shows the effective limits.

On a laptop, keep it **plugged in**, because battery mode throttles the CPU and ruins repeatability.

## 2. Install (one-time, `scripts/ubuntu-setup.sh`)

### 2.1 Base tools
```bash
sudo apt update && sudo apt install -y git make curl jq ca-certificates gnupg htop linux-tools-common linux-tools-$(uname -r)
```

### 2.2 Docker Engine (official apt repo)

Use **Docker Engine**, not Docker Desktop for Linux and not the snap:
- Docker Desktop for Linux runs containers inside a VM. That adds a virtualization layer and its own CPU/memory cap, which distorts benchmarks.
- The snap package has confinement quirks with bind mounts and sockets.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # log out and back in
docker run --rm hello-world
```

If Docker Desktop is already installed, check with `docker context ls`. The active context must be `default` (Engine), **not** `desktop-linux`.

### 2.3 Kubernetes tooling (needed from Phase 4, see [07](07-KUBERNETES.md))
```bash
# k3s: config first, then install
sudo mkdir -p /etc/rancher/k3s
sudo cp deploy/k8s/host/k3s-config.yaml   /etc/rancher/k3s/config.yaml
sudo cp deploy/k8s/host/registries.yaml   /etc/rancher/k3s/registries.yaml
curl -sfL https://get.k3s.io | sh -
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown $USER: ~/.kube/config && chmod 600 ~/.kube/config

# kubectl comes with k3s (also as `k3s kubectl`). Extras for learning:
sudo snap install k9s --devmode     # terminal UI; or download the release binary
sudo snap install helm --classic    # optional labs
sudo snap install kustomize         # for `kustomize edit set image`
```

k3s ships its own containerd, so it coexists with Docker Engine. **Don't benchmark both stacks at once.** Use `make mode-compose` / `make mode-k8s` (see §4).

To stop k3s from starting at boot when you're not using it: `sudo systemctl disable --now k3s`. To start it again: `sudo systemctl start k3s`.

### 2.4 Optional editor tooling
Go, Python, and Node are **not** needed on the host, because everything builds in containers. For editor support (gopls, pyright), `sudo snap install go --classic` and `uv` are optional.

### 2.5 Checks
```bash
stat -fc %T /sys/fs/cgroup        # must print cgroup2fs (Ubuntu 24.04 default). The servers read their own cgroup stats.
docker info | grep -E "Cgroup (Driver|Version)"   # systemd / 2
nproc && free -g
```

## 3. Benchmark "quiet mode" (`scripts/ubuntu-tune.sh`)

A desktop is noisy. Run `make tune-host` before a benchmark session. It does the following, and `make untune-host` reverts it:

| Setting | Command | Why |
|---|---|---|
| Power profile | `powerprofilesctl set performance` | Ubuntu 24.04 defaults to *balanced*, which scales the CPU frequency down. |
| No suspend / screen lock during runs | `gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'` plus `systemd-inhibit` around `make bench-*` | A suspend mid-run kills the run. |
| Pause background jobs | `sudo systemctl stop unattended-upgrades apt-daily.timer apt-daily-upgrade.timer` (`snapd` refresh: `sudo snap refresh --hold=2h`) | Avoids random CPU/disk spikes. |
| Network sysctls | `net.core.somaxconn=65535`, `net.ipv4.ip_local_port_range="1024 65535"`, `net.ipv4.tcp_tw_reuse=1` (persisted in `/etc/sysctl.d/99-bench.conf`) | High-concurrency runs open many sockets. |
| Swap | `sudo swapoff -a` during sessions (optional) | Swapping makes memory results meaningless. |

**Manual checklist (shown in the dashboard's preflight dialog):** close heavy apps (IDE indexing, other browsers, video calls), keep only one dashboard tab open, and don't use the machine during a run. The dashboard's live charts cost some CPU too, so the `bench` profile reserves cores for the desktop (§5).

## 4. Switching between Compose and Kubernetes

| Make target | Does |
|---|---|
| `make mode-compose` | Stops k3s (`sudo systemctl stop k3s` + `k3s-killall.sh`), then `docker compose up -d` |
| `make mode-k8s` | `docker compose down`, starts k3s, `make k8s-up` |

Preflight in every benchmark run (via the dashboard's platform adapter) refuses to start if the *other* stack is active.

### 4600G layout

The 4600G has SMT sibling pairs `(n, n+6)`. Check with `lscpu -e`. The default `scripts/cpu-layout.sh` result gives each server one **full physical core** (both hyperthreads):

| Physical core | CPUs | Owner |
|---|---|---|
| 0 | 0, 6 | OS, sshd, k3s control plane |
| 1 | 1, 7 | postgres |
| 2 | 2, 8 | go-server |
| 3 | 3, 9 | fastapi-server |
| 4–5 | 4, 5, 10, 11 | dashboard / load generator |

Memory budget (16 GB): postgres 2 GB, each server 1 GB, dashboard 2 GB, k3s about 1 GB. The rest goes to the OS and page cache.

## 5. CPU pinning (Linux-only advantage)

On Linux, Docker's `cpuset` gives containers **dedicated cores**. `docker-compose.bench.yml` (used by `make up-bench`) pins them like this on a 12-thread machine:

| Cores | Owner |
|---|---|
| 0–1 | desktop, browser, OS (left unassigned) |
| 2–3 | postgres |
| 4–5 | go-server |
| 6–7 | fastapi-server |
| 8–11 | dashboard / load generator |

`scripts/cpu-layout.sh` generates this from `nproc`, and avoids splitting SMT siblings across owners where possible (it reads `lscpu -e`). The Kubernetes equivalent is the static CPU manager ([07](07-KUBERNETES.md), lab K12).

## 6. Security on a desktop

- Compose ports bind to `127.0.0.1` only. Note that Docker-published ports **bypass `ufw`**, which is why binding to `127.0.0.1` matters.
- In k3s, the bundled `servicelb` is **disabled**, so Traefik doesn't open port 80 to your LAN. You reach the cluster with `make k8s-open` (a `kubectl port-forward` to localhost).
- `.env` holds `GOOGLE_API_KEY`, is git-ignored, and has `chmod 600`.

## 7. Where Claude Code runs

**Decided:** Claude Code runs on the **Mac** for development. The Ubuntu box is deployment-only. On the server:
- Clone this repo to `~/my-projects/go_benchmarking`.
- Clone the ADK reference repos to `~/my-projects/adk_samples` (the docs reference them as `../adk_samples`):
  ```bash
  mkdir -p ~/my-projects/adk_samples && cd ~/my-projects/adk_samples
  for r in adk-samples adk-go adk-python; do git clone --depth 1 https://github.com/google/$r.git; done
  ```
- If you keep developing on the Mac too, sync through a git remote. Images are always rebuilt on Ubuntu (an Apple-Silicon build is arm64, and the Ubuntu box is probably amd64).
