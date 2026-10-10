// /api/live sampler: one shared 1 Hz loop while at least one client is subscribed.
import type { ContainerStats, LiveSample, LiveTarget, PlatformMode, Target } from '../../shared/api.js';
import { TARGETS } from '../../shared/api.js';
import type { MetricsSnapshot } from './bench/types.js';
import type { Platform, Workload } from './platform/types.js';
import { deriveMetrics } from './metrics.js';
import { healthz } from './targets.js';
import { log, errMsg } from './log.js';

export interface LiveDeps {
  platform: Platform;
  targets: Record<Target, string>;
  scrapeMetrics: (t: Target) => Promise<MetricsSnapshot | null>;
  activeRunId: () => string | null;
  intervalMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export class LiveSampler {
  private readonly subs = new Set<(s: LiveSample) => void>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly prev = new Map<Target, MetricsSnapshot>();
  private readonly lastStats = new Map<Workload, ContainerStats | null>();
  private readonly pendingStats = new Map<Workload, Promise<ContainerStats | null>>();
  latest: LiveSample | null = null;

  constructor(private readonly deps: LiveDeps) {}

  get mode(): PlatformMode {
    return this.deps.platform.mode;
  }

  subscribe(cb: (s: LiveSample) => void): () => void {
    this.subs.add(cb);
    if (this.latest) cb(this.latest);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 1_000);
      void this.tick();
    }
    return () => {
      this.subs.delete(cb);
      if (this.subs.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.prev.clear();
      }
    };
  }

  /** Container stats with a soft deadline: a slow Docker/metrics-server answer is reused on the next tick. */
  private stats(w: Workload, ms: number): Promise<ContainerStats | null> {
    let p = this.pendingStats.get(w);
    if (!p) {
      p = this.deps.platform.containerStats(w).then(
        (v) => {
          this.lastStats.set(w, v);
          this.pendingStats.delete(w);
          return v;
        },
        () => {
          this.pendingStats.delete(w);
          return null;
        },
      );
      this.pendingStats.set(w, p);
    }
    return withTimeout(p, ms, this.lastStats.get(w) ?? null);
  }

  private async target(t: Target): Promise<LiveTarget> {
    const k8s = this.deps.platform.mode === 'k8s';
    const [healthy, snap, st, replicas] = await Promise.all([
      healthz(this.deps.targets[t], 900),
      this.deps.scrapeMetrics(t),
      this.stats(t, 900),
      k8s ? withTimeout(this.deps.platform.replicas(t), 900, null as number | null) : Promise.resolve(undefined),
    ]);
    const prev = this.prev.get(t) ?? null;
    if (snap) this.prev.set(t, snap);
    else this.prev.delete(t);
    const d = snap ? deriveMetrics(prev, snap) : null;
    // With >1 replica the Service load-balances /metrics scrapes, so cgroup counters are per-pod: use summed pod metrics.
    const multi = typeof replicas === 'number' && replicas > 1;
    const out: LiveTarget = {
      healthy,
      cpu_pct: multi ? (st?.cpu_pct ?? null) : (d?.cpu_pct ?? st?.cpu_pct ?? null),
      mem_mb: multi ? (st?.mem_mb ?? null) : (d?.mem_mb ?? st?.mem_mb ?? null),
      mem_limit_mb: st?.mem_limit_mb ?? null,
      net_rx_bytes: st?.net_rx_bytes ?? null,
      net_tx_bytes: st?.net_tx_bytes ?? null,
      threads: snap?.threads ?? null,
      rps: d?.rps ?? null,
      err_rate: d?.err_rate ?? null,
      p50_ms: d?.p50_ms ?? null,
      p95_ms: d?.p95_ms ?? null,
      p99_ms: d?.p99_ms ?? null,
      throttled_pct: d?.throttled_pct ?? null,
      db_pool_in_use: snap?.dbPoolInUse ?? null,
    };
    if (k8s) out.replicas = replicas ?? null;
    return out;
  }

  async sample(): Promise<LiveSample> {
    const [go, python, postgres, dashboard] = await Promise.all([
      this.target('go'),
      this.target('python'),
      this.stats('postgres', 900),
      this.stats('dashboard', 900),
    ]);
    let active: string | null = null;
    try {
      active = this.deps.activeRunId();
    } catch {
      active = null;
    }
    return {
      ts: new Date().toISOString(),
      platform: this.deps.platform.mode,
      targets: { go, python } satisfies Record<(typeof TARGETS)[number], LiveTarget>,
      postgres,
      dashboard,
      active_run_id: active,
    };
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await this.sample();
      this.latest = s;
      for (const cb of this.subs) {
        try {
          cb(s);
        } catch {
          /* subscriber gone */
        }
      }
    } catch (e) {
      log.warn('live sample failed', errMsg(e));
    } finally {
      this.busy = false;
    }
  }
}
