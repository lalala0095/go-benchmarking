// Compose platform adapter (docs/02 §8.1, §9): Docker Engine API via the mounted socket.
// Allowlist: only list/inspect/stats/info everywhere, and restart ONLY on the two server containers.
import net from 'node:net';
import os from 'node:os';
import Docker from 'dockerode';
import type { ContainerStats, PlatformInfo, ResourceLimits, Target } from '../../../shared/api.js';
import type { Platform, Workload } from './types.js';
import { toContainerStats, type DockerStatsLike } from './docker-stats.js';
import { sleep } from '../log.js';

export const SERVICE: Record<Workload, string> = {
  go: 'go-server',
  python: 'fastapi-server',
  postgres: 'postgres',
  dashboard: 'dashboard',
};
const RESTARTABLE: ReadonlySet<string> = new Set(['go-server', 'fastapi-server']);

export interface ComposeOpts {
  project: string;
  socketPath?: string;
  otherStackProbe?: { host: string; port: number; timeoutMs: number };
  restartTimeoutMs?: number;
}

export function limitsFromHostConfig(hc: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; Memory?: number; CpusetCpus?: string } | undefined): ResourceLimits {
  let cpus: number | null = null;
  if (hc?.NanoCpus) cpus = hc.NanoCpus / 1e9;
  else if (hc?.CpuQuota && hc.CpuQuota > 0) cpus = hc.CpuQuota / (hc.CpuPeriod || 100_000);
  return { cpus, memory_bytes: hc?.Memory ? hc.Memory : null, cpuset: hc?.CpusetCpus || null };
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export class ComposePlatform implements Platform {
  readonly mode = 'compose' as const;
  private readonly docker: Docker;
  private readonly ids = new Map<Workload, string>();
  private readonly prevStats = new Map<Workload, DockerStatsLike>();

  constructor(private readonly opts: ComposeOpts) {
    this.docker = new Docker({ socketPath: opts.socketPath ?? '/var/run/docker.sock' });
  }

  private async containerId(w: Workload, refresh = false): Promise<string | null> {
    if (!refresh) {
      const cached = this.ids.get(w);
      if (cached) return cached;
    }
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${this.opts.project}`, `com.docker.compose.service=${SERVICE[w]}`] },
    });
    const c = list.find((x) => x.State === 'running') ?? list[0];
    if (!c) {
      this.ids.delete(w);
      return null;
    }
    this.ids.set(w, c.Id);
    return c.Id;
  }

  /** Runs fn with the workload's container; re-resolves once if the container was recreated (404). */
  private async withContainer<T>(w: Workload, fn: (c: Docker.Container) => Promise<T>): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await this.containerId(w, attempt > 0);
      if (!id) return null;
      try {
        return await fn(this.docker.getContainer(id));
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404 && attempt === 0) continue;
        throw e;
      }
    }
    return null;
  }

  async containerStats(w: Workload): Promise<ContainerStats | null> {
    try {
      return await this.withContainer(w, async (c) => {
        let cur = (await c.stats({ stream: false, 'one-shot': true })) as unknown as DockerStatsLike;
        let prev = this.prevStats.get(w);
        if (!prev) {
          // First call: take a second one-shot sample so cpu% is defined immediately.
          prev = cur;
          await sleep(250);
          cur = (await c.stats({ stream: false, 'one-shot': true })) as unknown as DockerStatsLike;
        }
        this.prevStats.set(w, cur);
        return toContainerStats(cur, prev);
      });
    } catch {
      return null;
    }
  }

  async info(): Promise<PlatformInfo> {
    const out: PlatformInfo = { mode: 'compose', host: {}, limits: {}, images: {} };
    try {
      const di = await this.docker.info();
      out.host = { arch: di.Architecture, kernel: di.KernelVersion, os: di.OperatingSystem, ncpu: di.NCPU, mem_bytes: di.MemTotal };
    } catch {
      out.host = { arch: os.arch(), kernel: os.release(), os: os.type(), ncpu: os.cpus().length, mem_bytes: os.totalmem() };
    }
    const workloads: Workload[] = ['go', 'python', 'postgres', 'dashboard'];
    await Promise.all(
      workloads.map(async (w) => {
        try {
          const ins = await this.withContainer(w, (c) => c.inspect());
          if (!ins) return;
          out.limits[w] = limitsFromHostConfig(ins.HostConfig as Parameters<typeof limitsFromHostConfig>[0]);
          if (w === 'go' || w === 'python') {
            const img =
              (await this.docker.getImage(ins.Image).inspect().catch(() => null)) ??
              (ins.Config?.Image ? await this.docker.getImage(ins.Config.Image).inspect().catch(() => null) : null);
            out.images![w] = {
              ref: ins.Config?.Image ?? img?.RepoTags?.[0] ?? ins.Image,
              digest: img?.RepoDigests?.[0]?.split('@')[1] ?? img?.Id,
              size_bytes: img?.Size,
            };
          }
        } catch {
          /* best effort */
        }
      }),
    );
    return out;
  }

  async restart(t: Target): Promise<{ readyMs: number }> {
    const svc = SERVICE[t];
    if (!RESTARTABLE.has(svc)) throw new Error(`restart not allowed for ${svc}`);
    const id = await this.containerId(t, true);
    if (!id) throw new Error(`container for ${svc} not found`);
    const c = this.docker.getContainer(id);
    const t0 = performance.now();
    await c.restart({ t: 25 });
    const deadline = Date.now() + (this.opts.restartTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      const ins = await c.inspect();
      const health = ins.State?.Health?.Status;
      if (ins.State?.Running && (health === 'healthy' || (health === undefined && ins.State.Running))) {
        this.prevStats.delete(t);
        return { readyMs: Math.round(performance.now() - t0) };
      }
      await sleep(100);
    }
    throw new Error(`${svc} not healthy within timeout after restart`);
  }

  async replicas(t: Target): Promise<number> {
    try {
      const ins = await this.withContainer(t, (c) => c.inspect());
      if (!ins?.State?.Running) return 0;
      const h = ins.State.Health?.Status;
      return h === undefined || h === 'healthy' ? 1 : 0;
    } catch {
      return 0;
    }
  }

  /** k3s API server reachable from the dashboard container → the k8s stack is running too. */
  async isOtherStackActive(): Promise<boolean> {
    const p = this.opts.otherStackProbe ?? { host: 'host.docker.internal', port: 6443, timeoutMs: 500 };
    try {
      return await tcpProbe(p.host, p.port, p.timeoutMs);
    } catch {
      return false;
    }
  }
}
