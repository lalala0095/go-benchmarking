import { expect } from "vitest";
import { mockBody, wordCount } from "./fixtures.js";
import { req } from "./http.js";
import { expectComponent } from "./schema.js";
import type { SseResult } from "./sse.js";
import { MOCK_FIRST_TOKEN_DELAY_MS, MOCK_TOKEN_DELAY_MS, MOCK_TOKENS, type Target } from "./targets.js";

export async function newSession(t: Target, user: string): Promise<string> {
  const r = await req(t, "/v1/sessions", { json: { user_id: user } });
  expect(r.status, `[${t.name}] create session: ${r.text}`).toBe(201);
  return r.body.session_id as string;
}

/** Make sure the KB holds something (the RAG chat branch needs results). */
export async function ensureKb(t: Target): Promise<void> {
  const s = await req(t, "/v1/rag/stats");
  if (s.status === 200 && s.body?.documents > 0) return;
  await req(t, "/v1/rag/ingest", { json: { corpus: "default", embedders: ["mock"] }, timeoutMs: 120_000 });
}

/** Expected mock model_ms: 250 + 60×15 for the text answer, + 250 for a tool-calling first turn. */
export function expectedModelMs(toolBranch: boolean): number {
  const text = MOCK_FIRST_TOKEN_DELAY_MS + MOCK_TOKENS * MOCK_TOKEN_DELAY_MS;
  return toolBranch ? text + MOCK_FIRST_TOKEN_DELAY_MS : text;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Shared timing-field assertions (sse-events.md "Timings"). */
export function checkTimings(tm: any, ctx: string, opts: { clientMs?: number; toolBranch: boolean; toolDurations: number[] }): void {
  expectComponent("Timings", tm, ctx);
  for (const k of ["server_total_ms", "first_token_ms", "model_ms", "tool_ms", "session_ms", "overhead_ms"]) {
    expect(Number.isFinite(tm[k]), `${ctx} timings.${k} finite`).toBe(true);
    expect(tm[k], `${ctx} timings.${k} ≥ 0`).toBeGreaterThanOrEqual(0);
  }
  const derived = Math.max(0, tm.server_total_ms - tm.model_ms - tm.tool_ms - tm.session_ms);
  expect(Math.abs(tm.overhead_ms - derived), `${ctx} overhead_ms=${tm.overhead_ms} vs total-model-tool-session=${derived}`).toBeLessThanOrEqual(0.5);
  expect(tm.first_token_ms, `${ctx} first_token_ms > 0`).toBeGreaterThan(0);
  expect(tm.first_token_ms, `${ctx} first_token_ms ≤ server_total_ms`).toBeLessThanOrEqual(tm.server_total_ms);
  expect(tm.model_ms, `${ctx} model_ms ≤ server_total_ms`).toBeLessThanOrEqual(tm.server_total_ms);
  expect(tm.model_ms + tm.tool_ms + tm.session_ms, `${ctx} components ≤ total (+1ms)`).toBeLessThanOrEqual(tm.server_total_ms + 1);
  // lower bounds that hold under any load: the mock sleeps at least this long
  expect(tm.model_ms, `${ctx} model_ms ≥ mock sleep floor`).toBeGreaterThanOrEqual(expectedModelMs(opts.toolBranch) * 0.97);
  expect(tm.first_token_ms, `${ctx} first_token_ms ≥ first-token delay(s)`).toBeGreaterThanOrEqual(
    MOCK_FIRST_TOKEN_DELAY_MS * (opts.toolBranch ? 2 : 1) * 0.97,
  );
  expect(tm.session_ms, `${ctx} session_ms > 0 (ADK session service used)`).toBeGreaterThan(0);
  if (opts.toolBranch) {
    expect(tm.tool_ms, `${ctx} tool_ms > 0`).toBeGreaterThan(0);
    const sum = opts.toolDurations.reduce((a, b) => a + b, 0);
    expect(tm.tool_ms + 0.5, `${ctx} tool_ms ≥ Σ tool_call.duration_ms (${sum})`).toBeGreaterThanOrEqual(sum);
  } else {
    expect(tm.tool_ms, `${ctx} tool_ms = 0 without tools`).toBeLessThan(0.5);
  }
  if (opts.clientMs !== undefined) {
    expect(tm.server_total_ms, `${ctx} server_total_ms ≤ client-observed latency`).toBeLessThanOrEqual(opts.clientMs + 5);
  }
}

export function expectedUsage(message: string, hasPrefix: boolean) {
  return { input_tokens: wordCount(message), output_tokens: MOCK_TOKENS + (hasPrefix ? 1 : 0) };
}

export function expectedReply(prefix: string): string {
  return prefix + mockBody(MOCK_TOKENS);
}

/** Structural SSE assertions: framing, order, seq, terminal event. */
export function checkSseStructure(s: SseResult, ctx: string): void {
  expect(s.status, `${ctx} HTTP status (${s.text.slice(0, 300)})`).toBe(200);
  expect(s.headers.get("content-type") ?? "", `${ctx} content-type`).toMatch(/^text\/event-stream/);
  expect(s.headers.get("server-timing"), `${ctx} streams must not send Server-Timing`).toBeNull();
  expect(s.events.length, `${ctx} events`).toBeGreaterThanOrEqual(3);
  for (const [i, e] of s.events.entries()) {
    expect(e.dataLines, `${ctx} event #${i} (${e.event}) must have a single data line`).toBe(1);
    expect(e.data, `${ctx} event #${i} (${e.event}) data must be JSON: ${e.rawData.slice(0, 200)}`).toBeTypeOf("object");
  }
  const names = s.events.map((e) => e.event);
  expect(names[0], `${ctx} first event`).toBe("meta");
  expect(names[names.length - 1], `${ctx} last event (${names.join(",")})`).toBe("done");
  for (const n of names.slice(1, -1)) expect(["token", "tool_call"], `${ctx} middle events: ${names.join(",")}`).toContain(n);
  expect(s.trailingData, `${ctx} data after done`).toBe(false);
  const seqs = s.events.filter((e) => e.event === "token").map((e) => e.data.seq);
  expect(seqs, `${ctx} token seq contiguous from 1`).toEqual(seqs.map((_, i) => i + 1));
}
