# deploy/k8s — the stack on k3s

The same four images as Compose, on a single-node k3s cluster (Ubuntu server).
Design and rationale: [docs/07-KUBERNETES.md](../../docs/07-KUBERNETES.md). Lab notes: [labs/](labs/README.md).

```
host/         k3s-config.yaml, registries.yaml   -> /etc/rancher/k3s/ (make setup-host copies them)
base/         namespace bench, postgres StatefulSet, go-server / fastapi-server / dashboard
              Deployments + Services, dashboard RBAC + Ingress, ConfigMap generators
base/generated/  git-ignored; written by `make k8s-sync` (db-init + rag-corpus ConfigMaps)
overlays/dev     small Burstable resources, fast iteration (default)
overlays/bench   Guaranteed QoS, requests == limits == Compose limits (official numbers)
overlays/scale   bench + 1-CPU pods + HPA 1..4 @ 70% CPU (scale-out scenario)
scripts/      called by the Makefile, see below
labs/         K0..K9 learning notes
```

## Quick start (on the Ubuntu server)

```bash
make setup-host                 # once: Docker Engine, k3s (+ host/ config), kubeconfig, k9s
make registry-up                # registry:2 on 127.0.0.1:5000
make images                     # build + push localhost:5000/<svc>:<git sha>
make k8s-up OVERLAY=dev         # sync -> secrets -> apply.sh (waits for rollouts)
make k8s-status
make k8s-open                   # port-forward Traefik -> http://localhost:8080
```

From the Mac: `ssh -L 8080:localhost:8080 <user>@<ubuntu-host>` then open http://localhost:8080.

Switching stacks (never benchmark both at once): `make mode-k8s OVERLAY=bench` / `make mode-compose`.

## Scripts

| Script | Make target | What it does |
|---|---|---|
| `registry-up.sh` | `registry-up` | Runs `registry:2` as `bench-registry` on 127.0.0.1:5000 (restart unless-stopped). Idempotent. |
| `images.sh` | `images` | `docker build -f <svc>/Dockerfile .`, tags `$REGISTRY/<svc>:$TAG`, pushes. `SERVICES="go-server"` builds a subset. Refuses `TAG=latest`. |
| `sync.sh` | `k8s-sync` | Copies `db/init/*` and `corpus/**/*.{md,txt}` (minus `corpus/private/`) into `base/generated/`, writes the ConfigMap generators and the corpus `items` patch. Fails if the corpus > 900 KB. |
| `secrets.sh` | `k8s-secrets` | Secrets `gemini` and `postgres-credentials` from `.env` (create --dry-run \| apply). |
| `apply.sh` | `k8s-up` | Wraps the overlay in a temp kustomization (image tag, `GIT_SHA`, `.env` server settings), server-side applies it, removes stale HPAs, waits for rollouts. `RENDER_ONLY=1` prints the YAML instead. |
| `reset-db.sh` | `k8s-reset-db` | Deletes the Postgres StatefulSet and PVC `data-postgres-0` (asks first; `FORCE=1` to skip). |
| `mode.sh` | `mode-compose`, `mode-k8s` | Stops one stack (k3s: `systemctl stop` + `k3s-killall.sh`; Compose: `down`, volumes kept), starts the other. `BENCH=1` adds CPU pinning for Compose. |

## Notes and gotchas

- **Settings from `.env`:** secrets go through `secrets.sh`; `GEMINI_MODEL`, `MOCK_*`, `DB_POOL_MAX`, `EMBED_BATCH_SIZE`, `GEMINI_EMBED_MODEL` are merged into the `server-env` ConfigMap by `apply.sh`. CPU/memory come from the overlay, **not** from `SERVER_CPUS` etc.
- **Secret changes** need a pod restart (`kubectl -n bench rollout restart deploy/go-server`): env vars are read once at container start.
- **Old ConfigMaps** (previous hash suffixes) are not pruned by apply. Harmless; clean with `kubectl -n bench get cm` + delete, or `make k8s-down`.
- **Render without a cluster** (e.g. on the Mac): `./deploy/k8s/scripts/sync.sh && kubectl kustomize deploy/k8s/overlays/bench`.
- `ulimit nofile`: Compose sets 65535; k3s's containerd already runs containers with a much higher limit, so nothing to set.
