// docs/09-RAG.md §9: after startup, ingest the default corpus into any healthy target with an empty KB.
import type { RagStats, Target } from '../../shared/api.js';
import { TARGETS } from '../../shared/api.js';
import { healthz, upstreamJson } from './targets.js';
import { errMsg, log, sleep } from './log.js';

export async function bootstrapTarget(t: Target, url: string, opts: { maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<'ingested' | 'present' | 'gave-up'> {
  const deadline = Date.now() + (opts.maxWaitMs ?? 30 * 60_000);
  let delay = 1_000;
  let ingestFailures = 0;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    if (await healthz(url, 3_000)) {
      try {
        const stats = await upstreamJson<RagStats>(url, '/v1/rag/stats', { timeoutMs: 10_000 });
        if (stats.documents > 0) {
          log.info(`kb bootstrap: ${t} already has ${stats.documents} documents / ${stats.chunks} chunks`);
          return 'present';
        }
        log.info(`kb bootstrap: ${t} has an empty knowledge base, ingesting default corpus`);
        const r = await upstreamJson<{ documents: number; chunks: number; timings?: { total_ms?: number } }>(url, '/v1/rag/ingest', {
          method: 'POST',
          body: { corpus: 'default' },
          timeoutMs: 15 * 60_000,
        });
        log.info(`kb bootstrap: ${t} ingested ${r.documents} documents / ${r.chunks} chunks in ${r.timings?.total_ms ?? '?'} ms`);
        return 'ingested';
      } catch (e) {
        ingestFailures++;
        log.warn(`kb bootstrap: ${t} failed (attempt ${ingestFailures})`, errMsg(e));
        if (ingestFailures >= 5) return 'gave-up';
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 30_000);
  }
  return 'gave-up';
}

/** Fire-and-forget; each target is independent. */
export function startKbBootstrap(targets: Record<Target, string>): void {
  for (const t of TARGETS) {
    void bootstrapTarget(t, targets[t]).catch((e) => log.warn(`kb bootstrap: ${t} crashed`, errMsg(e)));
  }
}
