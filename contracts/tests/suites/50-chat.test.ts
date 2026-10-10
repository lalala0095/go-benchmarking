/** Chat in mock mode: SSE contract, tool calls, deterministic replies, timings, history. */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { checkSseStructure, checkTimings, ensureKb, expectedReply, expectedUsage, newSession, round2 } from "../lib/chat.js";
import { prompts } from "../lib/fixtures.js";
import { qs, req, type Res } from "../lib/http.js";
import { expectComponent, expectError, expectResponse } from "../lib/schema.js";
import { postSse, type SseResult } from "../lib/sse.js";
import { both, RUN_ID, targets, type Target } from "../lib/targets.js";

type Branch = "plain" | "inventory" | "rag";
const BRANCHES: Branch[] = ["plain", "inventory", "rag"];
const USER = `${RUN_ID}-chat`;

interface Run {
  sessionId: string;
  requestId: string;
  stream: SseResult;
  history: Res;
  nonStream: Res;
  nonStreamSession: string;
}
interface Ctx {
  runs: Record<Branch, Run>;
  electronics: { count: number; avg_price: number };
  ragSources: string[];
}
const ctx: Partial<Record<"go" | "py", Ctx>> = {};

async function runBranch(t: Target, b: Branch): Promise<Run> {
  const sessionId = await newSession(t, USER);
  const requestId = randomUUID();
  const stream = await postSse(t, "/v1/chat/stream", { user_id: USER, session_id: sessionId, message: prompts[b], mode: "mock", request_id: requestId });
  const history = await req(t, `/v1/sessions/${encodeURIComponent(sessionId)}?user_id=${USER}`);
  const nonStreamSession = await newSession(t, USER);
  const nonStream = await req(t, "/v1/chat", { json: { user_id: USER, session_id: nonStreamSession, message: prompts[b], mode: "mock" } });
  return { sessionId, requestId, stream, history, nonStream, nonStreamSession };
}

beforeAll(async () => {
  await Promise.all(
    targets.map(async (t) => {
      await ensureKb(t);
      const q = await req(t, "/bench/db/query");
      const row = (q.body?.rows ?? []).find((r: any) => r.category === "electronics");
      const s = await req(t, "/v1/rag/search" + qs({ q: prompts.rag, mode: "hybrid", embedder: "mock", k: 5 }));
      const runs = {} as Record<Branch, Run>;
      // branches sequentially per target, targets concurrently
      for (const b of BRANCHES) runs[b] = await runBranch(t, b);
      ctx[t.name] = {
        runs,
        electronics: { count: row?.count, avg_price: row?.avg_price },
        ragSources: (s.body?.results ?? []).map((r: any) => r.source),
      };
    }),
  );
}, 180_000);

if (targets.length === 0) describe.skip("chat mock", () => it("no targets configured", () => {}));

const ev = (s: SseResult, name: string) => s.events.filter((e) => e.event === name);

for (const t of targets) {
  describe(`chat mock [${t.name}]`, () => {
    describe.each(BRANCHES)("branch %s", (b) => {
      const run = () => ctx[t.name]!.runs[b];
      const c = `[${t.name}/${b}]`;
      const prefix = (): string => {
        if (b === "inventory") {
          const tc = ev(run().stream, "tool_call")[0]?.data?.result_summary ?? {};
          return `Electronics: ${tc.count} items, avg price ${tc.avg_price}. `;
        }
        if (b === "rag") {
          const src = ev(run().stream, "tool_call")[0]?.data?.result_summary?.sources?.[0];
          return `Based on [${src ?? "no results"}]: `;
        }
        return "";
      };

      it("SSE framing and event order meta → (token|tool_call)* → done, seq contiguous", () => {
        checkSseStructure(run().stream, c);
      });

      it("meta event fields", () => {
        const m = run().stream.events[0]!.data;
        expect(m, c).toMatchObject({ request_id: run().requestId, impl: t.impl, session_id: run().sessionId, mode: "mock" });
        expect(typeof m.model, `${c} meta.model`).toBe("string");
      });

      it("tool_call events per agent-spec", () => {
        const calls = ev(run().stream, "tool_call").map((e) => e.data);
        if (b === "plain") {
          expect(calls, c).toEqual([]);
          return;
        }
        expect(calls, `${c} exactly one tool call`).toHaveLength(1);
        const tc = calls[0];
        expectComponent("ToolCall", tc, c);
        expect(tc.duration_ms, c).toBeGreaterThanOrEqual(0);
        if (b === "inventory") {
          expect(tc.name).toBe("get_inventory_stats");
          expect(tc.args).toEqual({ category: "electronics" });
          const r = tc.result_summary;
          expect(Object.keys(r).sort(), `${c} result keys`).toEqual(["avg_price", "category", "count", "max_price", "min_price"]);
          expect(r.category).toBe("electronics");
          expect(r.count, `${c} count vs /bench/db/query`).toBe(ctx[t.name]!.electronics.count);
          expect(r.avg_price, `${c} avg_price rounded 2dp`).toBe(round2(ctx[t.name]!.electronics.avg_price));
          expect(r.min_price).toBeLessThanOrEqual(r.avg_price);
          expect(r.max_price).toBeGreaterThanOrEqual(r.avg_price);
        } else {
          expect(tc.name).toBe("search_knowledge_base");
          expect(tc.args).toEqual({ query: prompts.rag, top_k: 5 });
          const srcs = tc.result_summary?.sources;
          expect(Array.isArray(srcs), `${c} result_summary.sources`).toBe(true);
          expect(srcs.length).toBeGreaterThan(0);
          expect(srcs.length).toBeLessThanOrEqual(5);
          expect(srcs[0], `${c} top source vs /v1/rag/search hybrid mock`).toBe(ctx[t.name]!.ragSources[0]);
          for (const s of srcs) expect(ctx[t.name]!.ragSources, `${c} source ${s}`).toContain(s);
          expect(typeof tc.embed_ms, `${c} embed_ms`).toBe("number");
          expect(typeof tc.db_ms, `${c} db_ms`).toBe("number");
        }
      });

      it("tokens: prefix chunk + MOCK_TOKENS words; reply = concat(tokens) = deterministic mock text", () => {
        const s = run().stream;
        const tokens = ev(s, "token").map((e) => e.data.text as string);
        const done = s.events[s.events.length - 1]!.data;
        const p = prefix();
        expect(done.reply, c).toBe(tokens.join(""));
        expect(done.reply, c).toBe(expectedReply(p));
        expect(tokens.length, `${c} token count`).toBe(expectedUsage(prompts[b], p !== "").output_tokens);
        if (p) expect(tokens[0], `${c} prefix is the first chunk`).toBe(p);
        if (b !== "plain") {
          // tool_call is emitted before the answer tokens
          const names = s.events.map((e) => e.event);
          expect(names.indexOf("tool_call"), c).toBeLessThan(names.indexOf("token"));
        }
      });

      it("done: request_id, usage, timings", () => {
        const s = run().stream;
        const done = s.events[s.events.length - 1]!.data;
        expect(done.request_id, c).toBe(run().requestId);
        expect(done.usage, c).toEqual(expectedUsage(prompts[b], prefix() !== ""));
        const durs = ev(s, "tool_call").map((e) => e.data.duration_ms as number);
        checkTimings(done.timings, c, { clientMs: s.ms, toolBranch: b !== "plain", toolDurations: durs });
      });

      it("non-streaming POST /v1/chat returns the same reply / tool calls", () => {
        const r = run().nonStream;
        expectResponse(r, "/v1/chat", "post", 200);
        const s = run().stream;
        const done = s.events[s.events.length - 1]!.data;
        expect(r.body.session_id, c).toBe(run().nonStreamSession);
        expect(r.body.request_id, `${c} generated request_id`).toMatch(/^[0-9a-f-]{36}$/i);
        expect(r.body.reply, c).toBe(done.reply);
        expect(r.body.usage, c).toEqual(done.usage);
        const strip = (x: any) => ({ name: x.name, args: x.args, result_summary: x.result_summary });
        expect(r.body.tool_calls.map(strip), c).toEqual(ev(s, "tool_call").map((e) => strip(e.data)));
        checkTimings(r.body.timings, `${c} /v1/chat`, {
          clientMs: r.ms,
          toolBranch: b !== "plain",
          toolDurations: r.body.tool_calls.map((x: any) => x.duration_ms),
        });
        expect(r.headers.get("server-timing") ?? "", `${c} Server-Timing on /v1/chat`).toMatch(/total;dur=[\d.]+/);
      });

      it("session history contains the turn", () => {
        const h = run().history;
        expectResponse(h, "/v1/sessions/{session_id}", "get", 200);
        const events = h.body.events as any[];
        const done = run().stream.events.at(-1)!.data;
        expect(events.some((e) => e.role === "user" && e.text === prompts[b]), `${c} user event: ${JSON.stringify(events).slice(0, 400)}`).toBe(true);
        expect(events.some((e) => e.role === "model" && e.text === done.reply), `${c} final model event with full reply`).toBe(true);
        if (b !== "plain") {
          const tool = b === "inventory" ? "get_inventory_stats" : "search_knowledge_base";
          expect(events.filter((e) => e.tool === tool).length, `${c} function call + response events for ${tool}`).toBeGreaterThanOrEqual(2);
        }
        const ts = events.map((e) => Date.parse(e.ts));
        expect(ts, `${c} history ts ascending`).toEqual([...ts].sort((a, b2) => a - b2));
      });
    });

    describe("chat errors", () => {
      it("unknown session → 404 JSON (both endpoints, before streaming)", async () => {
        const body = { user_id: USER, session_id: `nope-${RUN_ID}`, message: "hi", mode: "mock" };
        expectError(await req(t, "/v1/chat", { json: body }), 404, ["SESSION_NOT_FOUND"], "/v1/chat unknown session");
        const s = await postSse(t, "/v1/chat/stream", body);
        expect(s.events, "stream must not start for unknown session").toEqual([]);
        expect(s.status).toBe(404);
        expectComponent("Error", JSON.parse(s.text), "/v1/chat/stream unknown session");
        expect(JSON.parse(s.text).code).toBe("SESSION_NOT_FOUND");
      });

      it("invalid requests → 400 JSON", async () => {
        const sid = await newSession(t, USER);
        const base = { user_id: USER, session_id: sid, message: "hello", mode: "mock" };
        const bad: [string, unknown][] = [
          ["empty message", { ...base, message: "" }],
          ["message > 20000 chars", { ...base, message: "a".repeat(20001) }],
          ["missing user_id", { session_id: sid, message: "hello", mode: "mock" }],
          ["missing session_id", { user_id: USER, message: "hello", mode: "mock" }],
          ["bad mode", { ...base, mode: "bogus" }],
        ];
        for (const [what, body] of bad) {
          expectError(await req(t, "/v1/chat", { json: body }), 400, ["BAD_REQUEST"], `/v1/chat ${what}`);
          const s = await postSse(t, "/v1/chat/stream", body);
          expect(s.status, `/v1/chat/stream ${what}: ${s.text.slice(0, 200)}`).toBe(400);
          expectComponent("Error", JSON.parse(s.text || "null"), `/v1/chat/stream ${what}`);
        }
        expectError(await req(t, "/v1/chat", { raw: "{nope" }), 400, ["BAD_REQUEST"], "/v1/chat malformed JSON");
      });
    });
  });
}

describe.runIf(both)("chat parity (go vs py)", () => {
  describe.each(BRANCHES)("branch %s", (b) => {
    const g = () => ctx.go!.runs[b];
    const p = () => ctx.py!.runs[b];
    const done = (r: Run) => r.stream.events.at(-1)?.data;

    it("event-type sequence identical", () => {
      expect(p().stream.events.map((e) => e.event)).toEqual(g().stream.events.map((e) => e.event));
    });
    it("token texts identical", () => {
      const tk = (r: Run) => ev(r.stream, "token").map((e) => [e.data.seq, e.data.text]);
      expect(tk(p())).toEqual(tk(g()));
    });
    it("reply identical (stream and non-stream)", () => {
      expect(done(p()).reply).toBe(done(g()).reply);
      expect(p().nonStream.body.reply).toBe(g().nonStream.body.reply);
    });
    it("tool calls identical (name, args, result_summary)", () => {
      const strip = (r: Run) => ev(r.stream, "tool_call").map((e) => ({ name: e.data.name, args: e.data.args, result_summary: e.data.result_summary }));
      expect(strip(p())).toEqual(strip(g()));
    });
    it("usage identical", () => {
      expect(done(p()).usage).toEqual(done(g()).usage);
    });
    it("meta.model identical; meta key set identical", () => {
      const m = (r: Run) => r.stream.events[0]!.data;
      expect(m(p()).model).toBe(m(g()).model);
      expect(Object.keys(m(p())).sort()).toEqual(Object.keys(m(g())).sort());
    });
    it("session history shape identical (role/tool/text sequence)", () => {
      const shape = (r: Run) => (r.history.body?.events ?? []).map((e: any) => ({ role: e.role, tool: e.tool ?? null, text: e.text ?? "" }));
      expect(shape(p())).toEqual(shape(g()));
    });
  });
});
