// Small JSON-over-HTTP helpers for preflight/housekeeping calls to the target servers.
import { request } from 'undici';

export interface HttpClient {
  getJson<T = unknown>(url: string, timeoutMs?: number): Promise<{ status: number; body: T | null }>;
  postJson<T = unknown>(url: string, body: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<{ status: number; body: T | null }>;
}

async function call<T>(method: 'GET' | 'POST', url: string, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const res = await request(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    signal,
  });
  const text = await res.body.text();
  let parsed: T | null = null;
  try { parsed = text ? (JSON.parse(text) as T) : null; } catch { parsed = null; }
  return { status: res.statusCode, body: parsed };
}

export const undiciHttp: HttpClient = {
  getJson: (url, timeoutMs = 5000) => call('GET', url, undefined, timeoutMs),
  postJson: (url, body, timeoutMs = 30_000, signal) => call('POST', url, body, timeoutMs, signal),
};
