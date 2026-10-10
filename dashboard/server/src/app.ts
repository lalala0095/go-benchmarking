// Hono app: /api routes per dashboard/shared/api.ts, bench router mount, SPA.
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import type {
  IngestResponse,
  KbIngestRequest,
  RagStats,
  SearchResponse,
  ServerInfo,
  Target,
  TargetStatus,
  TargetsResponse,
} from '../../shared/api.js';
import { TARGETS } from '../../shared/api.js';
import type { Platform } from './platform/types.js';
import { runChat, type ChatStore } from './chat.js';
import type { DashboardStore } from './store.js';
import type { LiveSampler } from './live.js';
import { fanOut, healthz, upstream, upstreamJson } from './targets.js';
import {
  chatRequestSchema,
  createConversationSchema,
  kbIngestSchema,
  kbSearchSchema,
  uploadSource,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  zodMessage,
} from './validation.js';
import { staticHandler } from './static.js';
import { errMsg, log } from './log.js';

export interface AppDeps {
  platform: Platform;
  targets: Record<Target, string>;
  store: (DashboardStore & ChatStore) | null; // null only in tests that don't touch conversations
  live: LiveSampler;
  webDist?: string;
  bench?: Hono | null;
  /** DB-aware readiness (GET /api/ready). /api/health stays dependency-free (k8s liveness). */
  ready?: () => Promise<boolean>;
}

async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('invalid JSON body');
  }
}

class BadRequest extends Error {}

const INGEST_TIMEOUT_MS = 15 * 60_000;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { targets } = deps;

  app.onError((e, c) => {
    if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
    log.error(`${c.req.method} ${c.req.path} failed`, errMsg(e));
    return c.json({ error: errMsg(e) }, 500);
  });

  const store = () => {
    if (!deps.store) throw new Error('dashboard DB not configured');
    return deps.store;
  };

  // ── Misc ────────────────────────────────────────────────────────────
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/ready', async (c) => {
    let ok = true;
    try {
      ok = deps.ready ? await deps.ready() : true;
    } catch {
      ok = false;
    }
    return c.json({ ok }, ok ? 200 : 503);
  });
  app.get('/api/platform', async (c) => c.json(await deps.platform.info()));

  app.get('/api/targets', async (c) => {
    const one = async (t: Target): Promise<TargetStatus> => {
      const url = targets[t];
      const healthy = await healthz(url, 3_000);
      const st: TargetStatus = { healthy, url };
      const [info, rag] = await Promise.allSettled([
        upstreamJson<ServerInfo>(url, '/v1/info', { timeoutMs: 3_000 }),
        upstreamJson<RagStats>(url, '/v1/rag/stats', { timeoutMs: 3_000 }),
      ]);
      if (info.status === 'fulfilled') st.info = info.value;
      if (rag.status === 'fulfilled') st.rag = rag.value;
      const errs = [info, rag].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => errMsg(r.reason));
      if (!healthy || errs.length) st.error = errs.length ? errs.join('; ') : 'healthz failed';
      return st;
    };
    const [go, python] = await Promise.all([one('go'), one('python')]);
    return c.json({ go, python } satisfies TargetsResponse);
  });

  // ── Conversations ───────────────────────────────────────────────────
  app.post('/api/conversations', async (c) => {
    const p = createConversationSchema.safeParse(await jsonBody(c));
    if (!p.success) return c.json({ error: zodMessage(p.error) }, 400);
    const conv = await store().createConversation(p.data.mode, p.data.title || null);
    return c.json(conv, 201);
  });
  app.get('/api/conversations', async (c) => c.json(await store().listConversations(50)));
  app.get('/api/conversations/:id', async (c) => {
    const conv = await store().getConversation(c.req.param('id'));
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    return c.json({ conversation: conv, turns: await store().getTurns(conv.id) });
  });

  // ── Chat fan-out ────────────────────────────────────────────────────
  app.post('/api/chat', async (c) => {
    const t0 = performance.now();
    const p = chatRequestSchema.safeParse(await jsonBody(c));
    if (!p.success) return c.json({ error: zodMessage(p.error) }, 400);
    const conv = await store().getConversation(p.data.conversation_id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      await runChat({
        conversation: conv,
        message: p.data.message,
        mode: p.data.mode,
        targets: TARGETS.filter((t) => p.data.targets.includes(t)),
        urls: targets,
        store: store(),
        signal: ac.signal,
        now: () => performance.now() - t0,
        emit: async (ev) => {
          if (ac.signal.aborted) return;
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        },
      });
    });
  });

  // ── Live monitor ────────────────────────────────────────────────────
  app.get('/api/live', (c) => {
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let unsub: (() => void) | null = null;
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
        unsub = deps.live.subscribe((s) => {
          stream.writeSSE({ event: 'sample', data: JSON.stringify(s) }).catch(() => resolve());
        });
      });
      (unsub as (() => void) | null)?.();
    });
  });

  // ── Knowledge base (fan-out) ────────────────────────────────────────
  app.get('/api/kb/stats', async (c) =>
    c.json(await fanOut(TARGETS, (t) => upstreamJson<RagStats>(targets[t], '/v1/rag/stats', { timeoutMs: 10_000 }))),
  );

  app.post('/api/kb/ingest', async (c) => {
    const p = kbIngestSchema.safeParse(await jsonBody(c));
    if (!p.success) return c.json({ error: zodMessage(p.error) }, 400);
    const req: KbIngestRequest = p.data;
    const body: Record<string, unknown> = { corpus: 'default' };
    if (req.force !== undefined) body.force = req.force;
    if (req.embedders) body.embedders = req.embedders;
    return c.json(
      await fanOut(TARGETS, (t) =>
        upstreamJson<IngestResponse>(targets[t], '/v1/rag/ingest', { method: 'POST', body, timeoutMs: INGEST_TIMEOUT_MS }),
      ),
    );
  });

  app.post(
    '/api/kb/upload',
    bodyLimit({ maxSize: UPLOAD_MAX_FILES * UPLOAD_MAX_BYTES + 1_048_576, onError: (c) => c.json({ error: 'upload too large' }, 413) }),
    async (c) => {
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'expected multipart/form-data' }, 400);
      }
      const raw = form.files;
      const files = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((f): f is File => f instanceof File);
      if (files.length === 0) return c.json({ error: 'no files (field "files")' }, 400);
      if (files.length > UPLOAD_MAX_FILES) return c.json({ error: `at most ${UPLOAD_MAX_FILES} files` }, 400);
      const documents: { source: string; content: string }[] = [];
      for (const f of files) {
        const source = uploadSource(f.name);
        if (!source) return c.json({ error: `${f.name}: only .md / .txt files are accepted` }, 400);
        if (f.size > UPLOAD_MAX_BYTES) return c.json({ error: `${f.name}: larger than 2 MB` }, 400);
        documents.push({ source, content: await f.text() });
      }
      return c.json(
        await fanOut(TARGETS, (t) =>
          upstreamJson<IngestResponse>(targets[t], '/v1/rag/ingest', { method: 'POST', body: { documents }, timeoutMs: INGEST_TIMEOUT_MS }),
        ),
      );
    },
  );

  app.get('/api/kb/search', async (c) => {
    const p = kbSearchSchema.safeParse(c.req.query());
    if (!p.success) return c.json({ error: zodMessage(p.error) }, 400);
    const qs = new URLSearchParams({ q: p.data.q, k: String(p.data.k), mode: p.data.mode, embedder: p.data.embedder });
    return c.json(
      await fanOut(TARGETS, (t) => upstreamJson<SearchResponse>(targets[t], `/v1/rag/search?${qs}`, { timeoutMs: 30_000 })),
    );
  });

  app.delete('/api/kb', async (c) =>
    c.json(
      await fanOut(TARGETS, async (t) => {
        const res = await upstream(targets[t], '/v1/rag/documents', { method: 'DELETE', timeoutMs: 60_000 });
        const text = await res.body.text();
        if (res.statusCode >= 300) throw new Error(`DELETE /v1/rag/documents → HTTP ${res.statusCode}${text ? `: ${text.slice(0, 200)}` : ''}`);
        return { ok: true as const };
      }),
    ),
  );

  // ── Bench module (scenarios, runs, compare, static, dx-notes, report) ─
  if (deps.bench) app.route('/api', deps.bench);

  app.all('/api/*', (c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404));

  // ── SPA ─────────────────────────────────────────────────────────────
  if (deps.webDist) {
    const serve = staticHandler(deps.webDist);
    app.get('*', serve);
  }
  return app;
}
