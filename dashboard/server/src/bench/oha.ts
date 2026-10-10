// oha driver. Targets oha v1.16.0 (github.com/hatoo/oha); the flags and JSON shape used here
// (-z, -c, -m, -D, -T, --no-tui, --output-format json; summary/latencyPercentiles/
// responseTimeHistogram/statusCodeDistribution/errorDistribution) are stable since v1.5.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { round } from './analyze.js';

export interface OhaJson {
  summary: {
    successRate: number | null; total: number | null; slowest: number | null; fastest: number | null;
    average: number | null; requestsPerSec: number | null; totalData?: number; sizePerRequest?: number | null; sizePerSec?: number | null;
  };
  latencyPercentiles: Record<string, number | null>;
  responseTimeHistogram: Record<string, number>;
  statusCodeDistribution: Record<string, number>;
  errorDistribution: Record<string, number>;
  [k: string]: unknown;
}

export interface OhaParsed {
  requests_total: number;
  errors_total: number;
  status_counts: Record<string, number>;
  duration_s: number;
  rps: number;
  lat_p50_ms: number | null; lat_p90_ms: number | null; lat_p95_ms: number | null; lat_p99_ms: number | null;
  lat_max_ms: number | null; lat_mean_ms: number | null;
  latency_histogram: { le_ms: number; count: number }[] | null;
  aborted_at_deadline: number;
}

/** oha's error message for requests cut off by -z (not a server failure). */
export const DEADLINE_ERROR = 'aborted due to deadline';

const ms = (s: number | null | undefined): number | null =>
  typeof s === 'number' && Number.isFinite(s) ? round(s * 1000, 4) : null;

function isErrorStatus(code: string): boolean {
  const n = Number(code);
  return !Number.isFinite(n) || n < 200 || n >= 400;
}

/** Convert oha --output-format json into RunResult fields. Requests aborted by the -z deadline are excluded. */
export function parseOhaJson(raw: string | OhaJson): OhaParsed {
  const j: OhaJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!j || typeof j !== 'object' || !j.summary) throw new Error('oha output is not a JSON summary');
  const status_counts: Record<string, number> = { ...(j.statusCodeDistribution ?? {}) };
  let responses = 0;
  let httpErrors = 0;
  for (const [code, n] of Object.entries(status_counts)) {
    responses += n;
    if (isErrorStatus(code)) httpErrors += n;
  }
  let aborted = 0;
  let connErrors = 0;
  for (const [msg, n] of Object.entries(j.errorDistribution ?? {})) {
    if (msg === DEADLINE_ERROR) aborted += n;
    else connErrors += n;
  }
  if (connErrors > 0) status_counts.conn_error = connErrors;
  const requests_total = responses + connErrors;
  const duration_s = typeof j.summary.total === 'number' && j.summary.total > 0 ? j.summary.total : 0;
  const lp = j.latencyPercentiles ?? {};
  // Keys are bucket upper bounds in seconds ("NaN" when there were no responses).
  const hist = Object.entries(j.responseTimeHistogram ?? {})
    .filter(([k]) => Number.isFinite(Number(k)))
    .map(([k, v]) => ({ le_ms: ms(Number(k))!, count: v }))
    .sort((a, b) => a.le_ms - b.le_ms);
  return {
    requests_total,
    errors_total: httpErrors + connErrors,
    status_counts,
    duration_s,
    rps: duration_s > 0 ? round(requests_total / duration_s, 3)! : 0,
    lat_p50_ms: ms(lp.p50),
    lat_p90_ms: ms(lp.p90),
    lat_p95_ms: ms(lp.p95),
    lat_p99_ms: ms(lp.p99),
    lat_max_ms: ms(j.summary.slowest),
    lat_mean_ms: ms(j.summary.average),
    latency_histogram: hist.length ? hist : null,
    aborted_at_deadline: aborted,
  };
}

export interface OhaRequest {
  url: string;
  method: 'GET' | 'POST';
  concurrency: number;
  durationS: number;
  body?: string;                 // written to a temp file and passed with -D
  contentType?: string;
}

export function buildOhaArgs(r: OhaRequest, bodyPath?: string): string[] {
  const args = ['-z', `${r.durationS}s`, '-c', String(r.concurrency), '--no-tui', '--output-format', 'json', '-m', r.method];
  if (bodyPath) args.push('-D', bodyPath, '-T', r.contentType ?? 'application/json');
  args.push(r.url);
  return args;
}

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

/** Run oha once and return the parsed summary plus the raw JSON. Kills oha on abort. */
export async function runOha(ohaPath: string, r: OhaRequest, signal?: AbortSignal): Promise<{ parsed: OhaParsed; raw: OhaJson }> {
  if (signal?.aborted) throw new CancelledError();
  let dir: string | null = null;
  let bodyPath: string | undefined;
  try {
    if (r.body !== undefined) {
      dir = await mkdtemp(path.join(tmpdir(), 'oha-'));
      bodyPath = path.join(dir, 'body');
      await writeFile(bodyPath, r.body);
    }
    const args = buildOhaArgs(r, bodyPath);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(ohaPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let killed = false;
      const onAbort = () => { killed = true; child.kill('SIGKILL'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      // Hard stop if oha hangs well past its deadline.
      const guard = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, (r.durationS + 60) * 1000);
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e) => { clearTimeout(guard); signal?.removeEventListener('abort', onAbort); reject(new Error(`failed to start oha (${ohaPath}): ${e.message}`)); });
      child.on('close', (code) => {
        clearTimeout(guard);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(new CancelledError());
        if (killed) return reject(new Error('oha timed out'));
        if (code !== 0) return reject(new Error(`oha exited with ${code}: ${Buffer.concat(err).toString().trim().slice(0, 500)}`));
        resolve(Buffer.concat(out).toString());
      });
    });
    const raw = JSON.parse(stdout) as OhaJson;
    return { parsed: parseOhaJson(raw), raw };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Request bodies ───────────────────────────────────────────────────────
export type BodyKind = 'json-10kb' | 'rag-chunk' | 'rag-embed' | 'db-write';

export async function loadBody(kind: BodyKind, contractsDir: string): Promise<string> {
  const fx = path.join(contractsDir, 'fixtures');
  switch (kind) {
    case 'json-10kb':
      return readFile(path.join(fx, 'json-10kb.json'), 'utf8');
    case 'rag-chunk':
      return JSON.stringify({ content: await readFile(path.join(fx, 'rag-chunking', 'large.md'), 'utf8') });
    case 'rag-embed':
      return JSON.stringify({ texts: embedTexts(64), embedder: 'mock', task: 'document' });
    case 'db-write':
      return JSON.stringify({ source: 'bench', kind: 'db-write', value: 42, tags: ['a', 'b', 'c'], nested: { ok: true, n: 3.14 } });
  }
}

/** 64 deterministic, paragraph-sized texts for the mock embedder. */
export function embedTexts(n: number): string[] {
  const words = ['benchmark', 'latency', 'throughput', 'goroutine', 'event loop', 'postgres', 'vector', 'session', 'agent', 'stream', 'token', 'overhead'];
  return Array.from({ length: n }, (_, i) =>
    `Text ${i + 1}: ` + Array.from({ length: 40 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ') + '.');
}
