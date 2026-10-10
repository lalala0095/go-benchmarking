// Bench module entry point (see ./CONTRACT.md). Mounted by dashboard-server at /api.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { RunDetail, RunStreamEvent, StartRunRequest, Target } from '../../../shared/api.js';
import { TARGETS } from '../../../shared/api.js';
import type { BenchDeps } from './types.js';
import { toCsv, toMarkdown } from './export.js';
import { Orchestrator } from './orchestrator.js';
import { renderReport, saveReport } from './report.js';
import { publicScenarios } from './scenarios.js';
import { measureStatic } from './static.js';
import { Store } from './store.js';

export type { BenchDeps, MetricsSnapshot } from './types.js';

let current: Orchestrator | null = null;

/** Lets /api/live show the active run id. */
export function activeRunId(): string | null {
  return current?.activeRunId() ?? null;
}

const TERMINAL = new Set<RunStreamEvent['type']>(['complete', 'failed', 'cancelled']);

function terminalEvent(d: RunDetail): RunStreamEvent | null {
  switch (d.run.status) {
    case 'complete': return { type: 'complete', run: d };
    case 'failed': return { type: 'failed', error: d.run.error ?? 'failed' };
    case 'cancelled': return { type: 'cancelled' };
    default: return null;
  }
}

export function createBenchRouter(deps: BenchDeps): Hono {
  const store = new Store(deps.db);
  const orch = new Orchestrator(deps, { store });
  current = orch;
  let measuring = false;
  const app = new Hono();

  app.get('/scenarios', (c) => c.json(publicScenarios()));

  app.post('/runs', async (c) => {
    const body = (await c.req.json().catch(() => null)) as StartRunRequest | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid JSON body' }, 400);
    if (measuring) return c.json({ error: 'static measurement in progress', active_run_id: null }, 409);
    const r = await orch.start(body);
    return c.json(r.body, r.status);
  });

  app.get('/runs', async (c) => {
    const q = c.req.query();
    const limit = q.limit ? Number(q.limit) : 100;
    return c.json(await store.listRuns({
      scenario: q.scenario || undefined, platform: q.platform || undefined, status: q.status || undefined,
      limit: Number.isFinite(limit) ? limit : 100,
    }));
  });

  app.get('/runs/:id', async (c) => {
    const d = await store.getRunDetail(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'run not found' }, 404);
  });

  app.get('/runs/:id/stream', (c) => {
    const id = c.req.param('id');
    return streamSSE(c, async (stream) => {
      const queue: RunStreamEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const push = (ev: RunStreamEvent) => { queue.push(ev); wake?.(); };
      let unsubscribe = () => {};
      const phase = orch.currentPhase(id);
      if (phase && !['complete', 'failed', 'cancelled'].includes(phase.status)) {
        unsubscribe = orch.subscribe(id, push); // synchronous: no event can slip in between
        queue.push(phase);
      } else {
        const d = await store.getRunDetail(id);
        if (!d) queue.push({ type: 'failed', error: 'run not found' });
        else {
          const ev = terminalEvent(d);
          queue.push(ev ?? { type: 'failed', error: `run is ${d.run.status} but not owned by this dashboard process` });
        }
      }
      stream.onAbort(() => { closed = true; wake?.(); });
      try {
        while (!closed) {
          while (queue.length) {
            const ev = queue.shift()!;
            await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
            if (TERMINAL.has(ev.type)) { closed = true; break; }
          }
          if (closed) break;
          let timer: NodeJS.Timeout | undefined;
          await new Promise<void>((r) => { wake = r; timer = setTimeout(r, 15_000); });
          clearTimeout(timer);
          wake = null;
          if (!queue.length && !closed) await stream.write(': keep-alive\n\n');
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post('/runs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    if (orch.cancel(id)) return c.json({ ok: true }, 202);
    const d = await store.getRunDetail(id);
    return d ? c.json({ error: `run is ${d.run.status}` }, 409) : c.json({ error: 'run not found' }, 404);
  });

  app.delete('/runs/:id', async (c) => {
    const id = c.req.param('id');
    if (orch.activeRunId() === id) return c.json({ error: 'cannot delete the active run; cancel it first' }, 409);
    return (await store.deleteRun(id)) ? c.body(null, 204) : c.json({ error: 'run not found' }, 404);
  });

  app.get('/compare', async (c) => {
    const a = c.req.query('a');
    const b = c.req.query('b');
    if (!a || !b) return c.json({ error: 'query parameters a and b are required' }, 400);
    const [da, db] = await Promise.all([store.getRunDetail(a), store.getRunDetail(b)]);
    if (!da || !db) return c.json({ error: `run not found: ${!da ? a : b}` }, 404);
    return c.json({ a: da, b: db });
  });

  app.get('/runs/:id/export', async (c) => {
    const id = c.req.param('id');
    const format = (c.req.query('format') ?? 'json').toLowerCase();
    if (!['json', 'csv', 'md'].includes(format)) return c.json({ error: 'format must be json, csv or md' }, 400);
    const d = await store.getRunDetail(id);
    if (!d) return c.json({ error: 'run not found' }, 404);
    const base = `run-${d.run.scenario}-${id.slice(0, 8)}`;
    if (format === 'json') {
      const raw = await store.rawSummaries(id);
      return c.body(JSON.stringify({ ...d, raw_summaries: raw }, null, 2), 200, {
        'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${base}.json"`,
      });
    }
    if (format === 'csv') {
      return c.body(toCsv(d), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${base}.csv"` });
    }
    return c.body(toMarkdown(d), 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${base}.md"` });
  });

  app.get('/static', async (c) => c.json(await store.latestStatic()));

  app.post('/static/measure', (c) => {
    const active = orch.activeRunId();
    if (active) return c.json({ error: 'a benchmark run is active; idle memory would be wrong', active_run_id: active }, 409);
    if (measuring) return c.json({ error: 'measurement already in progress' }, 409);
    measuring = true;
    measureStatic(deps, store)
      .then((m) => console.log(`[bench] static measurements recorded: ${m.length}`))
      .catch((e) => console.error('[bench] static measurement failed:', (e as Error).message))
      .finally(() => { measuring = false; });
    return c.json({ ok: true }, 202);
  });

  app.get('/dx-notes', async (c) => c.json(await store.dxNotes()));

  app.put('/dx-notes/:target', async (c) => {
    const t = c.req.param('target') as Target;
    if (!TARGETS.includes(t)) return c.json({ error: `target must be one of ${TARGETS.join(', ')}` }, 400);
    const body = (await c.req.json().catch(() => null)) as { markdown?: unknown } | null;
    if (!body || typeof body.markdown !== 'string') return c.json({ error: 'body must be { markdown: string }' }, 400);
    if (body.markdown.length > 200_000) return c.json({ error: 'markdown too long (max 200k chars)' }, 400);
    await store.putDxNotes(t, body.markdown);
    return c.body(null, 204);
  });

  app.post('/report', async (c) => {
    const ids = await store.latestRunIdsForReport();
    const runs = (await Promise.all(ids.map((id) => store.getRunDetail(id)))).filter((d): d is RunDetail => !!d);
    const md = renderReport({
      generated_at: new Date().toISOString(), git_sha: deps.gitSha || null, platform: deps.platform.mode,
      runs, static: await store.latestStatic(), dx: await store.dxNotes(),
    });
    try {
      const file = await saveReport(deps.reportsDir, md);
      c.header('x-report-path', file);
    } catch (e) {
      console.error('[bench] could not save report:', (e as Error).message);
    }
    return c.body(md, 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="decision-report.md"' });
  });

  app.onError((err, c) => {
    console.error('[bench] route error:', err);
    return c.json({ error: err.message || 'internal error' }, 500);
  });

  return app;
}

