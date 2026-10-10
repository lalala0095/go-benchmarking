// Upstream client for go-server / fastapi-server (undici, keep-alive pool).
import { Agent, request, type Dispatcher } from 'undici';
import type { Target } from '../../shared/api.js';

export const agent = new Agent({
  connections: 64,
  keepAliveTimeout: 30_000,
  headersTimeout: 60_000,
  bodyTimeout: 0, // SSE / long ingests: callers pass their own AbortSignal timeouts
  connectTimeout: 5_000,
});

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface CallOpts {
  method?: Dispatcher.HttpMethod;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function signalFor(opts: CallOpts): AbortSignal | undefined {
  const sigs: AbortSignal[] = [];
  if (opts.timeoutMs) sigs.push(AbortSignal.timeout(opts.timeoutMs));
  if (opts.signal) sigs.push(opts.signal);
  if (sigs.length === 0) return undefined;
  return sigs.length === 1 ? sigs[0] : AbortSignal.any(sigs);
}

/** Raw request; caller owns the body. */
export async function upstream(baseUrl: string, path: string, opts: CallOpts = {}): Promise<Dispatcher.ResponseData> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return request(baseUrl + path, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    dispatcher: agent,
    signal: signalFor(opts),
  });
}

/** JSON call; non-2xx → UpstreamError carrying the contract Error {code,message} if present. */
export async function upstreamJson<T>(baseUrl: string, path: string, opts: CallOpts = {}): Promise<T> {
  const res = await upstream(baseUrl, path, { timeoutMs: 10_000, ...opts });
  const text = await res.body.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const err = parsed as { code?: string; message?: string } | undefined;
    throw new UpstreamError(
      `${path} → HTTP ${res.statusCode}${err?.message ? `: ${err.message}` : text ? `: ${text.slice(0, 200)}` : ''}`,
      res.statusCode,
      err?.code ?? `HTTP_${res.statusCode}`,
      parsed,
    );
  }
  return parsed as T;
}

export async function upstreamText(baseUrl: string, path: string, opts: CallOpts = {}): Promise<string> {
  const res = await upstream(baseUrl, path, { timeoutMs: 5_000, ...opts });
  const text = await res.body.text();
  if (res.statusCode !== 200) throw new UpstreamError(`${path} → HTTP ${res.statusCode}`, res.statusCode, `HTTP_${res.statusCode}`);
  return text;
}

export async function healthz(baseUrl: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await upstream(baseUrl, '/healthz', { timeoutMs });
    await res.body.dump();
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

/** Run fn for each target concurrently; failures become {error}. */
export async function fanOut<T>(
  targets: Target[],
  fn: (t: Target) => Promise<T>,
): Promise<Partial<Record<Target, T | { error: string }>>> {
  const results = await Promise.all(
    targets.map(async (t): Promise<T | { error: string }> => {
      try {
        return await fn(t);
      } catch (e) {
        return { error: e instanceof Error ? e.message || e.name : String(e) };
      }
    }),
  );
  // Stable key order (targets order), independent of which upstream answered first.
  const out: Partial<Record<Target, T | { error: string }>> = {};
  targets.forEach((t, i) => (out[t] = results[i]));
  return out;
}
