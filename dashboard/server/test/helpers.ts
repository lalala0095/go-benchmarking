import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => unknown;

export async function fakeServer(handler: Handler): Promise<{ url: string; close: () => Promise<void>; calls: { method: string; path: string; body: string }[] }> {
  const calls: { method: string; path: string; body: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: req.method ?? '', path: req.url ?? '', body });
    await handler(req, body, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const TIMINGS = { server_total_ms: 300, first_token_ms: 260, model_ms: 290, tool_ms: 3, session_ms: 2, overhead_ms: 5 };

/** A contract-like upstream: sessions + streaming chat (optionally failing). */
export function upstreamHandler(impl: 'go' | 'python', opts: { fail?: 'error-event' | 'http-500' | 'drop' | 'session-404-once' } = {}): Handler {
  let sessionN = 0;
  let sent404 = false;
  return async (req, body, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/v1/sessions') return json(res, 201, { session_id: `${impl}-s${++sessionN}`, user_id: 'dashboard-user', created_at: new Date().toISOString() });
    if (req.method === 'POST' && url === '/v1/chat/stream') {
      const b = JSON.parse(body);
      if (opts.fail === 'http-500') return json(res, 500, { code: 'INTERNAL', message: 'boom' });
      if (opts.fail === 'session-404-once' && !sent404) {
        sent404 = true;
        return json(res, 404, { code: 'SESSION_NOT_FOUND', message: 'gone' });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('meta', { request_id: b.request_id, impl, session_id: b.session_id, mode: b.mode, model: 'mock-llm' }));
      res.write(sse('tool_call', { name: 'get_inventory_stats', args: { category: 'x' }, duration_ms: 3.1, result_summary: { n: 1 }, db_ms: 1.1 }));
      for (let i = 1; i <= 3; i++) {
        await new Promise((r) => setTimeout(r, 5));
        res.write(sse('token', { text: `t${i} `, seq: i }));
      }
      if (opts.fail === 'error-event') res.write(sse('error', { request_id: b.request_id, code: 'UPSTREAM_429', message: 'rate limited' }));
      else if (opts.fail === 'drop') {
        res.destroy();
        return;
      } else res.write(sse('done', { request_id: b.request_id, reply: 't1 t2 t3 ', timings: TIMINGS, usage: { input_tokens: 10, output_tokens: 3 } }));
      res.end();
      return;
    }
    json(res, 404, { code: 'NOT_FOUND', message: url });
  };
}
