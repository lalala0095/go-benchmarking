import { describe, expect, it } from "vitest";
import { req } from "../lib/http.js";
import { expectResponse } from "../lib/schema.js";
import { crossDescribe, eachTarget, onAll } from "../lib/suite.js";

eachTarget("meta", (t) => {
  it("GET /healthz → 200 Health {status:ok, db:ok}", async () => {
    const r = await req(t, "/healthz");
    expectResponse(r, "/healthz", "get", 200);
    expect(r.body).toMatchObject({ status: "ok", db: "ok" });
  });

  it("GET /v1/info → Info schema, impl matches target", async () => {
    const r = await req(t, "/v1/info");
    expectResponse(r, "/v1/info", "get", 200);
    expect(r.body.impl).toBe(t.impl);
    if (t.impl === "go") {
      expect(r.body.runtime).toMatch(/^go\d/);
      expect(r.body.workers).toBe(1);
      expect(typeof r.body.gomaxprocs).toBe("number");
    } else {
      expect(r.body.runtime).toMatch(/^cpython3\./);
      expect(r.body.workers).toBeGreaterThanOrEqual(1);
    }
    expect(Number.isNaN(Date.parse(r.body.started_at))).toBe(false);
  });

  it("GET /bench/ping → {ok:true} with Server-Timing header", async () => {
    const r = await req(t, "/bench/ping");
    expectResponse(r, "/bench/ping", "get", 200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers.get("server-timing") ?? "", "Server-Timing header (sse-events.md)").toMatch(/(^|,\s*)total;dur=[\d.]+/);
  });
});

crossDescribe("meta parity", () => {
  it("both servers report the same model / embed_model and db pool size", async () => {
    const all = await onAll((t) => req(t, "/v1/info"));
    const pick = (b: any) => ({ model: b.model, embed_model: b.embed_model, db_pool_max: b.db_pool_max, gemini_configured: b.gemini_configured });
    expect(pick(all.py!.body)).toEqual(pick(all.go!.body));
  });
});
