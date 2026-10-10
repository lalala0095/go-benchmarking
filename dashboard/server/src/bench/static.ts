// Static characteristics: image size (platform.info) and idle memory (cgroup metric, fallback container stats).
import { TARGETS, type Target } from '../../../shared/api.js';
import type { BenchDeps } from './types.js';
import { median, round } from './analyze.js';

const MiB = 1024 * 1024;

export interface StaticSink { insertStatic(t: Target, metric: string, p: 'compose' | 'k8s', v: number, env: string | null): Promise<void> }

export async function measureStatic(
  deps: Pick<BenchDeps, 'platform' | 'scrapeMetrics'>, sink: StaticSink,
  opts: { samples?: number; intervalMs?: number } = {},
): Promise<{ target: Target; metric: string; value: number }[]> {
  const out: { target: Target; metric: string; value: number }[] = [];
  const mode = deps.platform.mode;
  const info = await deps.platform.info().catch(() => null);
  for (const t of TARGETS) {
    const size = info?.images?.[t]?.size_bytes;
    if (typeof size === 'number' && size > 0) out.push({ target: t, metric: 'image_size_mb', value: round(size / 1e6, 1)! });
    const mem: number[] = [];
    const n = opts.samples ?? 3;
    for (let i = 0; i < n; i++) {
      const m = await deps.scrapeMetrics(t).catch(() => null);
      let v = typeof m?.cgroupMemoryBytes === 'number' ? m.cgroupMemoryBytes / MiB : null;
      if (v === null) {
        const st = await deps.platform.containerStats(t).catch(() => null);
        v = st?.mem_mb ?? null;
      }
      if (v !== null) mem.push(v);
      if (i < n - 1) await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
    }
    const idle = median(mem);
    if (idle !== null) out.push({ target: t, metric: 'idle_mem_mb', value: round(idle, 1)! });
  }
  for (const m of out) await sink.insertStatic(m.target, m.metric, mode, m.value, null);
  return out;
}
