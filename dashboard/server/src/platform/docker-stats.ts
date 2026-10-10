// Pure math for Docker Engine /containers/{id}/stats payloads (same formulas as `docker stats`).
import type { ContainerStats } from '../../../shared/api.js';

export interface DockerStatsLike {
  read?: string;
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

/**
 * cpu% where 100 = one full core. `prev` is the previous one-shot sample (one-shot payloads have empty precpu_stats);
 * when absent, precpu_stats of `cur` is used (streamed / non-one-shot payloads).
 */
export function cpuPercent(cur: DockerStatsLike, prev?: DockerStatsLike | null): number | null {
  const c = cur.cpu_stats;
  const p = prev?.cpu_stats ?? cur.precpu_stats;
  const cu = c?.cpu_usage?.total_usage;
  const pu = p?.cpu_usage?.total_usage;
  const cs = c?.system_cpu_usage;
  const ps = p?.system_cpu_usage;
  if (cu === undefined || pu === undefined || cs === undefined || ps === undefined || !pu && !ps) return null;
  const cpuDelta = cu - pu;
  const sysDelta = cs - ps;
  if (sysDelta <= 0 || cpuDelta < 0) return null;
  const online = c?.online_cpus || c?.cpu_usage?.percpu_usage?.length || 1;
  return Math.round((cpuDelta / sysDelta) * online * 100 * 10) / 10;
}

/** Working-set memory like `docker stats`: usage minus inactive file cache (cgroup v2 `inactive_file`, v1 `total_inactive_file`). */
export function memUsedBytes(cur: DockerStatsLike): number | null {
  const m = cur.memory_stats;
  if (!m || m.usage === undefined) return null;
  const st = m.stats ?? {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? 0;
  return Math.max(0, m.usage - (cache < m.usage ? cache : 0));
}

export function toContainerStats(cur: DockerStatsLike, prev?: DockerStatsLike | null): ContainerStats {
  const mb = (b: number | null | undefined) => (b === null || b === undefined ? null : Math.round((b / 1048576) * 10) / 10);
  let rx: number | null = null;
  let tx: number | null = null;
  if (cur.networks) {
    rx = 0;
    tx = 0;
    for (const n of Object.values(cur.networks)) {
      rx += n.rx_bytes ?? 0;
      tx += n.tx_bytes ?? 0;
    }
  }
  return {
    cpu_pct: cpuPercent(cur, prev),
    mem_mb: mb(memUsedBytes(cur)),
    mem_limit_mb: mb(cur.memory_stats?.limit),
    net_rx_bytes: rx,
    net_tx_bytes: tx,
  };
}
