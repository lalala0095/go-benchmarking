import { describe, expect, it } from 'vitest';
import { GEMINI_MAX_REQUESTS, SCENARIOS, publicScenarios, resolveConfig, targetOrder } from './scenarios.js';

const EXPECTED = [
  'ping', 'json', 'cpu', 'sleep-io', 'db-read', 'db-query', 'db-write', 'rag-chunk', 'rag-embed-mock', 'rag-search',
  'rag-search-vector', 'rag-search-fts', 'rag-ingest', 'chat-mock', 'chat-mock-tool', 'chat-mock-rag', 'chat-mock-burst',
  'chat-gemini', 'rag-ingest-gemini', 'cold-start', 'scale-out', 'rollout-disruption',
];

describe('scenario catalogue', () => {
  it('covers every scenario id from TRD §6 and 09-RAG §8 exactly once', () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual([...EXPECTED].sort());
  });

  it('public shape has no internal fields', () => {
    for (const s of publicScenarios()) expect(s).not.toHaveProperty('run');
  });

  it('matches TRD default loads', () => {
    const c = (id: string) => SCENARIOS.find((s) => s.id === id)!.defaults;
    expect(c('ping')).toMatchObject({ concurrency: 64, duration_s: 20, warmup_s: 5, cooldown_s: 5, reps: 3 });
    expect(c('cpu').concurrency).toBe(16);
    expect(c('sleep-io').concurrency).toBe(500);
    expect(c('db-query').concurrency).toBe(32);
    expect(c('chat-mock')).toMatchObject({ concurrency: 50, duration_s: 30, mode: 'mock' });
    expect(c('rag-ingest').reps).toBe(5);
    expect(c('cold-start').reps).toBe(5);
    expect(c('chat-mock-burst').params).toMatchObject({ ramp: { from: 1, to: 500, over_s: 60 } });
    expect(c('scale-out').params).toMatchObject({ ramp: { from: 1, to: 400, over_s: 120 }, hpa: { min: 1, max: 4, cpu: 70 } });
  });

  it('k8s-only scenarios are flagged', () => {
    for (const s of SCENARIOS) {
      const k8sOnly = s.id === 'scale-out' || s.id === 'rollout-disruption';
      expect(s.platforms).toEqual(k8sOnly ? ['k8s'] : ['compose', 'k8s']);
    }
  });

  it('every scenario default config validates on each of its platforms', () => {
    for (const s of SCENARIOS) {
      for (const p of s.platforms) {
        const r = resolveConfig({ scenario: s.id, confirm_gemini: s.requires_gemini }, p);
        expect(r.ok, `${s.id}@${p}: ${!r.ok ? r.error : ''}`).toBe(true);
      }
    }
  });

  it('Gemini scenarios carry caps', () => {
    for (const s of SCENARIOS.filter((x) => x.requires_gemini)) {
      expect(s.limits?.max_concurrency).toBeLessThanOrEqual(5);
      expect(s.limits?.max_requests).toBeLessThanOrEqual(GEMINI_MAX_REQUESTS);
      expect(s.defaults.warmup_s).toBe(0);
    }
  });
});

describe('resolveConfig', () => {
  it('rejects unknown scenarios and k8s-only on compose', () => {
    expect(resolveConfig({ scenario: 'nope' }, 'compose')).toMatchObject({ ok: false });
    const r = resolveConfig({ scenario: 'scale-out' }, 'compose');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only available on: k8s/);
  });

  it('merges overrides and normalises target order', () => {
    const r = resolveConfig({ scenario: 'ping', config: { targets: ['python', 'go'], duration_s: 5, warmup_s: 1, reps: 1 } }, 'compose');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject({ targets: ['go', 'python'], duration_s: 5, warmup_s: 1, reps: 1, concurrency: 64 });
  });

  it('validates numbers and targets', () => {
    expect(resolveConfig({ scenario: 'ping', config: { concurrency: 0 } }, 'compose').ok).toBe(false);
    expect(resolveConfig({ scenario: 'ping', config: { reps: 1.5 } }, 'compose').ok).toBe(false);
    expect(resolveConfig({ scenario: 'ping', config: { targets: [] } }, 'compose').ok).toBe(false);
    expect(resolveConfig({ scenario: 'ping', config: { targets: ['rust' as 'go'] } }, 'compose').ok).toBe(false);
  });

  it('requires confirm_gemini and enforces Gemini caps', () => {
    expect(resolveConfig({ scenario: 'chat-gemini' }, 'compose')).toMatchObject({ ok: false });
    expect(resolveConfig({ scenario: 'chat-gemini', confirm_gemini: true, config: { concurrency: 6 } }, 'compose').ok).toBe(false);
    expect(resolveConfig({ scenario: 'chat-gemini', confirm_gemini: true, config: { requests: 26 } }, 'compose').ok).toBe(false); // 26×1×2 = 52
    const ok = resolveConfig({ scenario: 'chat-gemini', confirm_gemini: true, config: { requests: 25, warmup_s: 10, duration_s: 30 } }, 'compose');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.warmup_s).toBe(0);
      expect(ok.config.duration_s).toBeUndefined();
      expect(ok.config.mode).toBe('gemini');
    }
    expect(resolveConfig({ scenario: 'rag-ingest-gemini', confirm_gemini: true, config: { reps: 2 } }, 'compose').ok).toBe(false);
  });

  it('forces chat mode per scenario', () => {
    const r = resolveConfig({ scenario: 'chat-mock', config: { mode: 'gemini' } }, 'compose');
    expect(r.ok && r.config.mode).toBe('mock');
  });

  it('ramp scenarios set concurrency to the ramp peak', () => {
    const r = resolveConfig({ scenario: 'chat-mock-burst', config: { params: { ramp: { from: 1, to: 50, over_s: 10 } } } }, 'compose');
    expect(r.ok && r.config.concurrency).toBe(50);
  });
});

describe('A/B alternation', () => {
  it('alternates order every rep (FR-12)', () => {
    expect(targetOrder(['go', 'python'], 1)).toEqual(['go', 'python']);
    expect(targetOrder(['go', 'python'], 2)).toEqual(['python', 'go']);
    expect(targetOrder(['go', 'python'], 3)).toEqual(['go', 'python']);
    expect(targetOrder(['python'], 2)).toEqual(['python']);
  });
});
