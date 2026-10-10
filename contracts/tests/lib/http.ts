import type { Target } from "./targets.js";

export interface Res<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
  ms: number;
}

export interface ReqOpts {
  method?: string;
  json?: unknown;
  /** raw body (sent as-is with content-type application/json) */
  raw?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Fetch a path on a target; parses JSON when possible. Never throws on HTTP errors. */
export async function req<T = any>(t: Target, path: string, opts: ReqOpts = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["content-type"] = "application/json";
  } else if (opts.raw !== undefined) {
    body = opts.raw;
    headers["content-type"] = "application/json";
  }
  const t0 = performance.now();
  const r = await fetch(t.url + path, {
    method: opts.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await r.text();
  const ms = performance.now() - t0;
  let parsed: any = undefined;
  const ct = r.headers.get("content-type") ?? "";
  if (text.length > 0 && (ct.includes("json") || /^[\s]*[\[{]/.test(text))) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: r.status, headers: r.headers, body: parsed as T, text, ms };
}

/** Short excerpt of a response for assertion messages. */
export function excerpt(r: Res, max = 600): string {
  const s = `HTTP ${r.status} ${r.headers.get("content-type") ?? ""} ${r.text}`;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? "?" + s : "";
}
