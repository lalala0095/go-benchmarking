// Kubernetes platform adapter (docs/07 §3–4): in-cluster ServiceAccount, namespace-scoped Role only.
import fs from 'node:fs';
import os from 'node:os';
import * as k8s from '@kubernetes/client-node';
import type { ContainerStats, PlatformInfo, PodInfo, ResourceLimits, Target } from '../../../shared/api.js';
import type { HpaConfig, Platform, RolloutResult, Workload } from './types.js';
import { parseQuantity } from './quantity.js';
import { sleep } from '../log.js';

const NAME: Record<Workload, string> = { go: 'go-server', python: 'fastapi-server', postgres: 'postgres', dashboard: 'dashboard' };
const WORKLOADS: Workload[] = ['go', 'python', 'postgres', 'dashboard'];
const mergePatch = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch);

const isNotFound = (e: unknown) => (e as { code?: number }).code === 404;

function podReady(p: k8s.V1Pod): boolean {
  return !p.metadata?.deletionTimestamp && p.status?.phase === 'Running' && !!p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
}

function podReason(p: k8s.V1Pod): string | undefined {
  for (const cs of p.status?.containerStatuses ?? []) {
    if (cs.state?.waiting?.reason) return cs.state.waiting.reason;
    if (cs.state?.terminated?.reason) return cs.state.terminated.reason;
    if (cs.lastState?.terminated?.reason === 'OOMKilled') return 'OOMKilled (last)';
  }
  if (p.metadata?.deletionTimestamp) return 'Terminating';
  return p.status?.reason ?? undefined;
}

function limitsOf(spec: k8s.V1PodSpec | undefined): ResourceLimits {
  const c = spec?.containers?.[0];
  const l = c?.resources?.limits ?? {};
  const mem = parseQuantity(l.memory);
  return { cpus: parseQuantity(l.cpu), memory_bytes: mem === null ? null : Math.round(mem), cpuset: null };
}

export class K8sPlatform implements Platform {
  readonly mode = 'k8s' as const;
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly hpa: k8s.AutoscalingV2Api;
  private readonly metrics: k8s.Metrics;
  private readonly selectors = new Map<Workload, string>();

  constructor(private readonly ns: string, kc?: k8s.KubeConfig) {
    if (!kc) {
      kc = new k8s.KubeConfig();
      if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
      else kc.loadFromDefault();
    }
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.hpa = kc.makeApiClient(k8s.AutoscalingV2Api);
    this.metrics = new k8s.Metrics(kc);
  }

  private async workloadObj(w: Workload): Promise<k8s.V1Deployment | k8s.V1StatefulSet> {
    return w === 'postgres'
      ? this.apps.readNamespacedStatefulSet({ name: NAME[w], namespace: this.ns })
      : this.apps.readNamespacedDeployment({ name: NAME[w], namespace: this.ns });
  }

  private async selector(w: Workload): Promise<string> {
    const cached = this.selectors.get(w);
    if (cached) return cached;
    let sel: string;
    try {
      const obj = await this.workloadObj(w);
      const ml = obj.spec?.selector?.matchLabels ?? {};
      sel = Object.entries(ml).map(([k, v]) => `${k}=${v}`).join(',');
    } catch {
      sel = '';
    }
    if (!sel) sel = w === 'go' || w === 'python' ? `bench/target=${w}` : `app.kubernetes.io/name=${NAME[w]}`;
    this.selectors.set(w, sel);
    return sel;
  }

  private async pods(w: Workload): Promise<k8s.V1Pod[]> {
    const res = await this.core.listNamespacedPod({ namespace: this.ns, labelSelector: await this.selector(w) });
    return res.items;
  }

  async containerStats(w: Workload): Promise<ContainerStats | null> {
    try {
      const [pods, pm] = await Promise.all([this.pods(w), this.metrics.getPodMetrics(this.ns)]);
      const names = new Set(pods.map((p) => p.metadata?.name));
      let cpu = 0;
      let mem = 0;
      let found = false;
      for (const item of pm.items) {
        if (!names.has(item.metadata.name)) continue;
        found = true;
        for (const c of item.containers) {
          cpu += parseQuantity(c.usage.cpu) ?? 0;
          mem += parseQuantity(c.usage.memory) ?? 0;
        }
      }
      let memLimit = 0;
      for (const p of pods) {
        if (!p.metadata?.deletionTimestamp) memLimit += parseQuantity(p.spec?.containers?.[0]?.resources?.limits?.memory) ?? 0;
      }
      if (!found) return null;
      return {
        cpu_pct: Math.round(cpu * 1000) / 10,
        mem_mb: Math.round((mem / 1048576) * 10) / 10,
        mem_limit_mb: memLimit ? Math.round((memLimit / 1048576) * 10) / 10 : null,
        net_rx_bytes: null,
        net_tx_bytes: null,
      };
    } catch {
      return null;
    }
  }

  async info(): Promise<PlatformInfo> {
    const out: PlatformInfo = {
      mode: 'k8s',
      host: { arch: os.arch(), kernel: os.release(), os: os.type(), ncpu: os.cpus().length, mem_bytes: os.totalmem() },
      limits: {},
      images: {},
      k8s: { pods: [], hpa: {}, overlay: process.env.K8S_OVERLAY || undefined },
    };
    await Promise.all(
      WORKLOADS.map(async (w) => {
        try {
          const obj = await this.workloadObj(w);
          out.limits[w] = limitsOf(obj.spec?.template?.spec);
          const pods = await this.pods(w);
          for (const p of pods) {
            const info: PodInfo = {
              name: p.metadata?.name ?? '',
              target: w,
              phase: p.metadata?.deletionTimestamp ? 'Terminating' : (p.status?.phase ?? 'Unknown'),
              ready: podReady(p),
              restarts: (p.status?.containerStatuses ?? []).reduce((a, c) => a + (c.restartCount ?? 0), 0),
              qos_class: p.status?.qosClass,
              node: p.spec?.nodeName,
              reason: podReason(p),
            };
            out.k8s!.pods.push(info);
            if (!out.k8s!.node && p.spec?.nodeName) out.k8s!.node = p.spec.nodeName;
          }
          if (w === 'go' || w === 'python') {
            const ref = obj.spec?.template?.spec?.containers?.[0]?.image ?? '';
            const imageID = pods.flatMap((p) => p.status?.containerStatuses ?? []).find((c) => c.imageID)?.imageID;
            out.images![w] = { ref, digest: imageID?.includes('@') ? imageID.split('@')[1] : imageID };
          }
        } catch {
          /* best effort */
        }
      }),
    );
    out.k8s!.pods.sort((a, b) => a.name.localeCompare(b.name));
    try {
      const list = await this.hpa.listNamespacedHorizontalPodAutoscaler({ namespace: this.ns });
      for (const h of list.items) {
        const tgt = h.spec?.scaleTargetRef?.name;
        const t: Target | null = tgt === NAME.go ? 'go' : tgt === NAME.python ? 'python' : null;
        if (!t) continue;
        out.k8s!.hpa![t] = {
          min: h.spec?.minReplicas ?? 1,
          max: h.spec?.maxReplicas ?? 1,
          current: h.status?.currentReplicas ?? 0,
          desired: h.status?.desiredReplicas ?? 0,
        };
      }
    } catch {
      /* RBAC or API absent */
    }
    // Node is cluster-scoped; the Role doesn't grant it, so this is best effort.
    if (out.k8s!.node) {
      try {
        const node = await this.core.readNode({ name: out.k8s!.node });
        const ni = node.status?.nodeInfo;
        out.k8s!.k3s_version = ni?.kubeletVersion;
        out.host = {
          arch: ni?.architecture ?? out.host.arch,
          kernel: ni?.kernelVersion ?? out.host.kernel,
          os: ni?.osImage ?? out.host.os,
          ncpu: parseQuantity(node.status?.capacity?.cpu) ?? out.host.ncpu,
          mem_bytes: parseQuantity(node.status?.capacity?.memory) ?? out.host.mem_bytes,
        };
      } catch {
        /* forbidden: keep os.* values (the pod sees the node's kernel/cpus/memory) */
      }
    }
    return out;
  }

  private async waitReady(w: Target, exclude: Set<string>, want: number, timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pods = await this.pods(w);
      const fresh = pods.filter((p) => !exclude.has(p.metadata?.name ?? '') && podReady(p));
      if (fresh.length >= want) return fresh.map((p) => p.metadata!.name!);
      await sleep(200);
    }
    throw new Error(`${NAME[w]}: new pods not Ready within ${timeoutMs} ms`);
  }

  async restart(t: Target): Promise<{ readyMs: number }> {
    const before = await this.pods(t);
    const old = new Set(before.map((p) => p.metadata?.name ?? ''));
    const want = Math.max(1, before.filter((p) => !p.metadata?.deletionTimestamp).length);
    const t0 = performance.now();
    await Promise.all(
      [...old].map((name) =>
        this.core.deleteNamespacedPod({ name, namespace: this.ns, gracePeriodSeconds: 0 }).catch((e) => {
          if (!isNotFound(e)) throw e;
        }),
      ),
    );
    await this.waitReady(t, old, want, 300_000);
    return { readyMs: Math.round(performance.now() - t0) };
  }

  async replicas(t: Target): Promise<number> {
    try {
      const d = await this.apps.readNamespacedDeployment({ name: NAME[t], namespace: this.ns });
      return d.status?.readyReplicas ?? 0;
    } catch {
      return 0;
    }
  }

  async scale(t: Target, replicas: number): Promise<void> {
    await this.apps.patchNamespacedDeploymentScale(
      { name: NAME[t], namespace: this.ns, body: { spec: { replicas } } },
      mergePatch,
    );
  }

  async setHpa(t: Target, cfg: HpaConfig | null): Promise<void> {
    const name = NAME[t];
    if (cfg === null) {
      await this.hpa.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: this.ns }).catch((e) => {
        if (!isNotFound(e)) throw e;
      });
      return;
    }
    const spec: k8s.V2HorizontalPodAutoscalerSpec = {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name },
      minReplicas: cfg.minReplicas,
      maxReplicas: cfg.maxReplicas,
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: cfg.cpuUtilization } } }],
    };
    try {
      await this.hpa.readNamespacedHorizontalPodAutoscaler({ name, namespace: this.ns });
      await this.hpa.patchNamespacedHorizontalPodAutoscaler({ name, namespace: this.ns, body: { spec } }, mergePatch);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      await this.hpa.createNamespacedHorizontalPodAutoscaler({
        namespace: this.ns,
        body: {
          apiVersion: 'autoscaling/v2',
          kind: 'HorizontalPodAutoscaler',
          metadata: { name, labels: { 'app.kubernetes.io/part-of': 'go-benchmarking', 'bench/target': t } },
          spec,
        },
      });
    }
  }

  async rollout(t: Target): Promise<RolloutResult> {
    const name = NAME[t];
    const before = new Set((await this.pods(t)).map((p) => p.metadata?.name ?? ''));
    const startedAt = new Date();
    const t0 = performance.now();
    const patched = await this.apps.patchNamespacedDeployment(
      {
        name,
        namespace: this.ns,
        body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': startedAt.toISOString() } } } } },
      },
      mergePatch,
    );
    const gen = patched.metadata?.generation ?? 0;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const d = await this.apps.readNamespacedDeployment({ name, namespace: this.ns });
      const want = d.spec?.replicas ?? 1;
      const s = d.status ?? {};
      const complete =
        (s.observedGeneration ?? 0) >= gen &&
        (s.updatedReplicas ?? 0) === want &&
        (s.replicas ?? 0) === want &&
        (s.availableReplicas ?? 0) === want;
      if (complete) {
        const pods = await this.pods(t);
        const newPods = pods.filter((p) => !before.has(p.metadata?.name ?? '') && !p.metadata?.deletionTimestamp).map((p) => p.metadata!.name!);
        const completedAt = new Date();
        return { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: Math.round(performance.now() - t0), newPods };
      }
      await sleep(250);
    }
    throw new Error(`${name}: rollout did not complete within 600 s`);
  }

  /** Compose running alongside k3s: only detectable if the Docker socket is visible (normally it isn't). */
  async isOtherStackActive(): Promise<boolean> {
    try {
      return fs.statSync('/var/run/docker.sock').isSocket();
    } catch {
      return false;
    }
  }
}
