# 07 — Kubernetes (k3s) Deployment and Learning Path

This doc has two goals:
1. Run the **same four images** on Kubernetes, so we can benchmark Go vs FastAPI where Kubernetes changes the picture: density, scale-out, and rollouts.
2. **Teach Kubernetes** through labs that build this project step by step, with no throwaway tutorials.

Docker Compose stays the fast dev loop and the baseline. Kubernetes comes in at Phase 4 ([06](06-IMPLEMENTATION-PLAN.md)), after the app works in Compose.

---

## 1. Why k3s (on Ubuntu 24.04 desktop)

| Option | Verdict |
|---|---|
| **k3s** ✅ | A real, CNCF-conformant Kubernetes in one binary and systemd service, light enough to share a desktop. It bundles containerd, CoreDNS, Traefik (Ingress), local-path storage, metrics-server, and NetworkPolicy enforcement. |
| MicroK8s | Also good on Ubuntu (Canonical, snap). Strict snap confinement and add-on management add friction. |
| kind / minikube | Great for CI and tutorials, but Kubernetes-inside-Docker (or a VM) adds a network/virtualization layer that skews benchmarks. |
| kubeadm | Best for learning internals, but heavy for day one. Optional lab K13. |

Single node. Multi-node is out of scope.

## 2. Cluster configuration

`deploy/k8s/host/k3s-config.yaml` (copied to `/etc/rancher/k3s/config.yaml` before install, see [08](08-UBUNTU-SETUP.md)):

```yaml
write-kubeconfig-mode: "0600"
disable:
  - servicelb          # don't open :80/:443 to the LAN; we use port-forward
kubelet-arg:
  - "max-pods=110"
  # K12 (advanced) adds: cpu-manager-policy=static, reserved-cpus=0-1
```

`deploy/k8s/host/registries.yaml` lets k3s pull from the local registry:

```yaml
mirrors:
  "localhost:5000":
    endpoint: ["http://localhost:5000"]
```

**Image flow:** `make registry-up` runs `registry:2` on `127.0.0.1:5000` under Docker. Then `make images` builds each image, tags it `localhost:5000/<svc>:<git-sha>`, and pushes it. Overlays pin that tag through `kustomize edit set image`. Tags are immutable, so no `:latest`.

## 3. Cluster architecture

```
namespace: bench
┌───────────────────────────────────────────────────────────────────────────┐
│  Ingress (Traefik, kube-system) ── path / ──▶ Service dashboard :3000     │
│                                                                           │
│  Deployment dashboard (1)  SA: dashboard + Role (pods, deployments/scale, │
│        │                    pods metrics) ── load generator runs here     │
│        ├──▶ Service go-server      :8080 ──▶ Deployment go-server (1..4)   │
│        └──▶ Service fastapi-server :8080 ──▶ Deployment fastapi-server(1..4)│
│                                        │                                  │
│                         Service postgres (headless) ──▶ StatefulSet postgres│
│                                                         PVC 10Gi local-path│
│  Secret gemini (GOOGLE_API_KEY) · Secret postgres-credentials             │
│  ConfigMap db-init (db/init/*) · ConfigMap agent-spec (contracts/…)       │
│  HPA go-server / fastapi-server (scale overlay only)                      │
│  NetworkPolicies (lab K10)                                                │
└───────────────────────────────────────────────────────────────────────────┘
Access: make k8s-open → kubectl -n kube-system port-forward svc/traefik 8080:80 → http://localhost:8080
```

The app code doesn't change between Compose and Kubernetes. Only env values and the dashboard's **platform adapter** (`PLATFORM=k8s`, TRD §8.1) differ. Service DNS names deliberately match the Compose service names (`go-server`, `fastapi-server`, `postgres`), so `DATABASE_URL` and target URLs stay identical.

## 4. Manifest layout (Kustomize)

```
deploy/k8s/
├── host/                       # k3s-config.yaml, registries.yaml (host files, not applied)
├── base/
│   ├── kustomization.yaml      # namespace: bench; configMapGenerator / secretGenerator
│   ├── namespace.yaml
│   ├── generated/              # git-ignored; `make k8s-sync` copies db/init/* + contracts/agent-spec.md here
│   ├── postgres/   statefulset.yaml  service.yaml
│   ├── go-server/  deployment.yaml   service.yaml
│   ├── fastapi-server/ deployment.yaml service.yaml
│   └── dashboard/  deployment.yaml service.yaml serviceaccount.yaml role.yaml rolebinding.yaml ingress.yaml
└── overlays/
    ├── dev/        # small limits, 1 replica each, fast iteration
    ├── bench/      # Guaranteed QoS (requests == limits) matching Compose limits; used for numbers
    └── scale/      # bench + HPA (min 1, max 4, CPU 70%) for go-server and fastapi-server
```

Why `generated/`: Kustomize refuses to load files outside its directory, so `make k8s-sync` copies them in. It runs automatically before `make k8s-up`.

### 4.1 Key manifest rules (for the implementing agent)

| Concern | Rule |
|---|---|
| Probes | `startupProbe` on `/healthz` (generous, covers ADK migrations). `readinessProbe` on `/healthz` (checks the DB). `livenessProbe` on **`/bench/ping`**: liveness must not depend on the DB, or a DB blip restarts every pod (a lesson in K3). |
| Startup order | An initContainer (`pgvector/pgvector:pg17`, the same image as Postgres, already pulled, `pg_isready` loop) on both servers. Kubernetes has no `depends_on`. |
| Resources | Base sets requests and limits. The `bench` overlay sets requests == limits (`cpu: 2`, `memory: 1Gi`), giving the **Guaranteed** QoS class. |
| Python workers | `PY_WORKERS` comes from the downward API: `resourceFieldRef: {resource: limits.cpu, divisor: "1"}`. Workers track the CPU limit automatically. Go needs nothing, because the runtime reads the cgroup limit. |
| Secrets | `make k8s-secrets` creates Secret `gemini` from `.env`. It's never committed. (Secrets are only base64. Sealed Secrets / SOPS is an optional extra.) |
| Postgres | StatefulSet with 1 replica, `volumeClaimTemplates` 10Gi on `local-path`, and ConfigMap `db-init` mounted at `/docker-entrypoint-initdb.d`. These are the same scripts Compose uses. |
| Dashboard RBAC | Role in `bench`: `pods` get/list/watch/delete. `deployments`, `deployments/scale` get/patch. `horizontalpodautoscalers` get/list/patch. `pods.metrics.k8s.io` get/list. Nothing cluster-scoped. |
| Rollouts | `strategy: RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0`, and a `preStop` sleep of 5 s so endpoints are removed before SIGTERM. Both servers must handle SIGTERM gracefully (drain in-flight SSE, with a 20 s grace period). |
| Labels | `app.kubernetes.io/name`, `app.kubernetes.io/part-of: go-benchmarking`, and `bench/target: go|python`. |

### 4.2 Make targets

`registry-up`, `images`, `k8s-sync`, `k8s-secrets`, `k8s-up` (`OVERLAY=dev|bench|scale`, default `dev`), `k8s-down`, `k8s-status`, `k8s-open`, `k8s-logs SVC=…`, `k8s-reset-db` (deletes the PVC), `mode-compose`, `mode-k8s`.

## 5. What Kubernetes adds to the benchmark

| Scenario / dimension | Question it answers |
|---|---|
| **Platform dimension** (any scenario run with `PLATFORM=k8s`) | How much do Service routing (iptables DNAT), the CNI bridge, and CFS limits cost, and does that cost differ between Go and Python? |
| `scale-out` | Under ramping chat-mock load with HPA, how many pods does each need for the same RPS? How fast do they scale, and how fast is a new pod Ready (Go's static binary vs Python's import time)? |
| `rollout-disruption` | During a rolling restart under constant load, how many errors and how big a p99 spike? (This tests graceful shutdown quality.) |
| `cold-start` (k8s variant) | Pod delete → new pod Ready, including image pull from the local registry. |
| Density | Memory requests needed per pod, so how many replicas fit on a node. Uses idle and under-load memory from cgroup metrics. |
| Python process model | Compare `py-1w × N pods` with `py-Nw × 1 pod` for the same total CPU. This is a classic Kubernetes design question for Python. |

## 6. Learning path (labs)

Each lab builds a real piece of this project. In **learning mode** (the default), main Claude runs the k8s agent one lab group at a time and then **stops so you can do the lab yourself**. Read the manifests, run the commands, and do the "break it" exercise. Each lab's notes go in `deploy/k8s/labs/Kn.md`, written by the agent: the commands, expected output, and answers to the check-yourself questions, hidden in `<details>`.

| Lab | You build | Concepts | Try it | Break it on purpose | Check yourself |
|---|---|---|---|---|---|
| **K0 Cluster up** | k3s installed, kubeconfig | Node, control plane, kubelet, namespaces, kubeconfig contexts | `kubectl get nodes -o wide`, `kubectl get pods -A`, `k9s` | `sudo systemctl stop k3s`, then run kubectl. What fails, and what keeps running? | What runs in `kube-system`, and why? |
| **K1 Images** | local registry + `make images` | Image refs, tags vs digests, `imagePullPolicy`, containerd | `sudo k3s crictl images` | Deploy a typo'd tag → `ImagePullBackOff` → `kubectl describe pod` | Why are immutable tags safer than `:latest`? |
| **K2 Postgres** | Secret, ConfigMap, StatefulSet, PVC, headless Service | Stateful vs stateless, PV/PVC/StorageClass, stable pod identity | `kubectl exec -it postgres-0 -- psql -U bench -l` | Delete `postgres-0`. Does the data survive? Then delete the PVC. | Why a StatefulSet, not a Deployment? When would you use an operator (CloudNativePG)? |
| **K3 go-server** | Deployment, Service, probes, initContainer | ReplicaSets, labels and selectors, Service DNS, probe types | `kubectl port-forward svc/go-server 8081:8080`, `curl localhost:8081/v1/info` | Make readiness hit a 404 path. Watch the endpoints empty out (`kubectl get endpointslices`). | Why must liveness not depend on the DB? |
| **K4 fastapi-server** | Deployment with the downward API and a ConfigMap volume | Env from resources, config as volumes, rollout on ConfigMap change | `kubectl exec … -- env | grep PY_WORKERS` | Set the memory limit to 128Mi → `OOMKilled` → `kubectl describe` | Why does ConfigMap-as-env need a restart, but a volume mount doesn't? |
| **K5 Dashboard** | ServiceAccount, Role, RoleBinding, Ingress | RBAC, least privilege, Ingress controllers, port-forward | `kubectl auth can-i delete pods --as=system:serviceaccount:bench:dashboard -n bench`, `make k8s-open` | Remove `delete` from the Role → the cold-start scenario fails with 403 | Why is the Traefik `LoadBalancer` Service `<pending>` with servicelb disabled? |
| **K6 Kustomize** | dev / bench / scale overlays | Bases, overlays, patches, generators, image overrides | `kubectl diff -k deploy/k8s/overlays/bench` | Break a patch target name and read the error | When would you pick Helm instead? |
| **K7 Resources and QoS** | the `bench` overlay | requests vs limits, QoS classes, CFS throttling, OOM | `kubectl get pod -o jsonpath='{.status.qosClass}'`. Watch `bench_cgroup_cpu_throttled_seconds_total` during the `cpu` scenario. | Set CPU limit `500m` on Go and compare RPS and throttling | Why do many teams drop CPU limits but keep memory limits? |
| **K8 Rollouts** | rollout strategy, preStop, graceful shutdown | Rolling updates, maxSurge/maxUnavailable, rollback | `kubectl rollout restart deploy/go-server`, `kubectl rollout undo …`. Run the `rollout-disruption` scenario. | Set `maxUnavailable: 1`, remove preStop, and compare error counts | What happens to an open SSE stream during a rollout? |
| **K9 Autoscaling** | the `scale` overlay with HPA | metrics-server, the HPA algorithm, stabilization windows | `kubectl get hpa -w` during the `scale-out` scenario | Remove CPU requests. The HPA can't compute utilization, so why? | Is CPU the right scaling signal for an LLM-bound service? What would be better (concurrency, queue depth)? |
| K10 *(opt)* NetworkPolicy | default-deny plus allow rules | Pod isolation and enforcement (k3s's kube-router) | `kubectl exec` curl tests between pods | Forget DNS egress and watch everything break | Why does default-deny need an explicit DNS rule? |
| K11 *(opt)* Helm + observability | `kube-prometheus-stack` | Helm charts and values, ServiceMonitor, Grafana | Dashboard for the `bench_*` metrics | — | Helm vs Kustomize trade-offs? |
| K12 *(opt, advanced)* CPU manager | kubelet `cpu-manager-policy=static` | Exclusive cores, Guaranteed pods with integer CPUs | Compare benchmark variance with K7 | — | Why does the static policy only apply to integer-CPU Guaranteed pods? |
| K13 *(opt)* kubeadm | a cluster from scratch (VM or 2nd machine) | Control-plane components, certificates, CNI choice | — | — | What does k3s hide from you? |

**Suggested pacing:** K0–K2 in a first session, K3–K5 in a second, K6–K9 in a third (with benchmarks), then optional labs whenever.

## 7. Kubernetes "done" criteria (gate G4)

- `make mode-k8s OVERLAY=bench` brings everything up Ready, and `make k8s-open` serves the dashboard.
- The dashboard runs side-by-side chat in k8s, the same as in Compose.
- `make bench-smoke` passes with `PLATFORM=k8s`.
- `scale-out`, `rollout-disruption`, and k8s `cold-start` complete and persist.
- Lab notes K0–K9 exist in `deploy/k8s/labs/`.
