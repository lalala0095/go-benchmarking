# Kubernetes labs (K0–K9)

Each lab builds a real piece of this project ([docs/07 §6](../../../docs/07-KUBERNETES.md#6-learning-path-labs)).
Do them on the Ubuntu server (or over SSH). Read the manifests named in each lab
first — the comments in them are part of the lesson.

| Lab | You build | Key files |
|---|---|---|
| [K0](K0.md) Cluster up | k3s, kubeconfig | `host/k3s-config.yaml`, `scripts/ubuntu-setup.sh` |
| [K1](K1.md) Images | local registry, `make images` | `host/registries.yaml`, `scripts/registry-up.sh`, `scripts/images.sh` |
| [K2](K2.md) Postgres | Secret, ConfigMap, StatefulSet, PVC, headless Service | `base/postgres/`, `scripts/secrets.sh`, `scripts/sync.sh` |
| [K3](K3.md) go-server | Deployment, Service, probes, initContainer | `base/go-server/` |
| [K4](K4.md) fastapi-server | downward API, ConfigMap volumes | `base/fastapi-server/` |
| [K5](K5.md) Dashboard | ServiceAccount, Role, RoleBinding, Ingress | `base/dashboard/` |
| [K6](K6.md) Kustomize | dev / bench / scale overlays | `base/kustomization.yaml`, `overlays/*` |
| [K7](K7.md) Resources & QoS | the bench overlay | `overlays/bench/` |
| [K8](K8.md) Rollouts | strategy, preStop, graceful shutdown | `strategy:` + `lifecycle:` in the Deployments |
| [K9](K9.md) Autoscaling | the scale overlay + HPA | `overlays/scale/` |

Optional K10–K13 (NetworkPolicy, Helm + observability, CPU manager, kubeadm) are described in docs/07 only.

**Pacing:** K0–K2 in a first session, K3–K5 in a second, K6–K9 in a third (with benchmarks).

**Conventions in every lab:** commands assume the repo root as working directory and
`kubectl` pointing at k3s. Most commands need `-n bench`; to make it the default:
`kubectl config set-context --current --namespace=bench`.
Every "break it" step has a **Recover** line — always run it before moving on.
