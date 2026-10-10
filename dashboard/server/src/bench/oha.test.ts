// Fixtures are real `oha 1.16.0 --output-format json` outputs captured against a local mock server.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOhaArgs, embedTexts, parseOhaJson } from './oha.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fixture = (n: string) => readFileSync(path.join(dir, n), 'utf8');

describe('parseOhaJson', () => {
  it('parses a mixed 201/500 run and excludes deadline-aborted requests', () => {
    const p = parseOhaJson(fixture('oha-v1.16.0-mixed.json'));
    expect(p.status_counts).toEqual({ '201': 1022, '500': 24 });
    expect(p.requests_total).toBe(1046);
    expect(p.errors_total).toBe(24);
    expect(p.aborted_at_deadline).toBe(8);
    expect(p.duration_s).toBeCloseTo(2.004, 3);
    expect(p.rps).toBeCloseTo(1046 / 2.004059875, 2);
    expect(p.lat_p50_ms).toBeCloseTo(15.375, 3);
    expect(p.lat_p90_ms).toBeCloseTo(23.164, 3);
    expect(p.lat_p95_ms).toBeCloseTo(24.335, 3);
    expect(p.lat_p99_ms).toBeCloseTo(25.774, 3);
    expect(p.lat_max_ms).toBeCloseTo(28.655, 3);
    expect(p.lat_mean_ms).toBeCloseTo(15.253, 3);
    const h = p.latency_histogram!;
    expect(h).toHaveLength(11);
    expect(h[0]!.le_ms).toBeCloseTo(4.387, 3);
    expect(h.every((b, i) => i === 0 || b.le_ms > h[i - 1]!.le_ms)).toBe(true);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(1046);
  });

  it('handles a run where every connection failed (null stats, NaN histogram key)', () => {
    const p = parseOhaJson(fixture('oha-v1.16.0-conn-refused.json'));
    expect(p.status_counts).toEqual({ conn_error: 66680 });
    expect(p.requests_total).toBe(66680);
    expect(p.errors_total).toBe(66680);
    expect(p.lat_p50_ms).toBeNull();
    expect(p.lat_max_ms).toBeNull();
    expect(p.latency_histogram).toBeNull();
  });

  it('rejects non-summary output', () => {
    expect(() => parseOhaJson('{"foo":1}')).toThrow();
  });
});

describe('buildOhaArgs', () => {
  it('GET', () => {
    expect(buildOhaArgs({ url: 'http://go:8080/bench/ping', method: 'GET', concurrency: 64, durationS: 20 }))
      .toEqual(['-z', '20s', '-c', '64', '--no-tui', '--output-format', 'json', '-m', 'GET', 'http://go:8080/bench/ping']);
  });
  it('POST with a body file', () => {
    const a = buildOhaArgs({ url: 'http://go:8080/bench/json', method: 'POST', concurrency: 8, durationS: 5, body: '{}' }, '/tmp/b');
    expect(a.slice(-6)).toEqual(['POST', '-D', '/tmp/b', '-T', 'application/json', 'http://go:8080/bench/json']);
  });
});

describe('request bodies', () => {
  it('64 deterministic embed texts', () => {
    const a = embedTexts(64);
    expect(a).toHaveLength(64);
    expect(embedTexts(64)).toEqual(a);
    expect(new Set(a).size).toBe(64);
  });
});
