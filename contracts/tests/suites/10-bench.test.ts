import { createHash } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { expectedBench, fixtureJson } from "../lib/fixtures.js";
import { req, type Res } from "../lib/http.js";
import { expectResponse } from "../lib/schema.js";
import { crossDescribe, eachTarget, onAll } from "../lib/suite.js";

const json10kb = fixtureJson<{ items: any[] }>("json-10kb.json");

function cpuHash(n: number): string {
  let h = createHash("sha256").update("bench-seed").digest();
  for (let i = 0; i < n * 1000; i++) h = createHash("sha256").update(h).digest();
  return h.toString("hex");
}

eachTarget("bench", (t) => {
  it("GET /bench/cpu?n=25 → hash from expected-bench.json", async () => {
    const r = await req(t, "/bench/cpu?n=25");
    expectResponse(r, "/bench/cpu", "get", 200);
    expect(r.body).toMatchObject({ n: 25, hash: expectedBench.cpu_n25.hash });
  });

  it("GET /bench/cpu?n=25&offload=1 → same hash", async () => {
    const r = await req(t, "/bench/cpu?n=25&offload=1");
    expectResponse(r, "/bench/cpu", "get", 200);
    expect(r.body.hash).toBe(expectedBench.cpu_n25.hash);
  });

  it("GET /bench/cpu?n=3 → matches local reference computation", async () => {
    const r = await req(t, "/bench/cpu?n=3");
    expectResponse(r, "/bench/cpu", "get", 200);
    expect(r.body).toMatchObject({ n: 3, hash: cpuHash(3) });
  });

  it("POST /bench/json (json-10kb.json) → item_count, total, echo", async () => {
    const r = await req(t, "/bench/json", { json: json10kb });
    expectResponse(r, "/bench/json", "post", 200);
    expect(r.body.item_count).toBe(expectedBench.json.item_count);
    expect(r.body.total).toBeCloseTo(expectedBench.json.total, 2);
    expect(r.body.total).toBe(expectedBench.json.total);
    expect(r.body.echo).toHaveLength(expectedBench.json.echo_len);
    expect(r.body.echo).toEqual(json10kb.items.slice(0, 10));
  });

  it("GET /bench/db/read?id=42 → BenchItem with id 42", async () => {
    const r = await req(t, "/bench/db/read?id=42");
    expectResponse(r, "/bench/db/read", "get", 200);
    expect(r.body.id).toBe(42);
    for (const k of ["sku", "name", "category", "price", "stock", "attributes"]) expect(r.body, `field ${k}`).toHaveProperty(k);
  });

  it("GET /bench/db/read (no id) → random row in 1..100000", async () => {
    const r = await req(t, "/bench/db/read");
    expectResponse(r, "/bench/db/read", "get", 200);
    expect(r.body.id).toBeGreaterThanOrEqual(1);
    expect(r.body.id).toBeLessThanOrEqual(100000);
  });

  it("GET /bench/db/query → per-category aggregate ordered by category", async () => {
    const r = await req(t, "/bench/db/query");
    expectResponse(r, "/bench/db/query", "get", 200);
    const rows = r.body.rows as any[];
    expect(rows.length).toBeGreaterThan(0);
    const cats = rows.map((x) => x.category);
    expect(cats).toEqual([...cats].sort());
    expect(rows.reduce((s, x) => s + x.count, 0)).toBe(100000);
  });

  it("POST /bench/db/write → 201 {id}", async () => {
    const a = await req(t, "/bench/db/write", { json: { contract: true, n: 1 } });
    expectResponse(a, "/bench/db/write", "post", 201);
    expect(Number.isInteger(a.body.id) && a.body.id > 0).toBe(true);
    const b = await req(t, "/bench/db/write", { json: { contract: true, n: 2 } });
    expectResponse(b, "/bench/db/write", "post", 201);
    expect(b.body.id).toBeGreaterThan(a.body.id);
  });

  it("GET /bench/sleep?ms=50 takes ≥ 50 ms", async () => {
    const r = await req(t, "/bench/sleep?ms=50");
    expectResponse(r, "/bench/sleep", "get", 200);
    expect(r.ms).toBeGreaterThanOrEqual(50);
    expect(r.ms).toBeLessThan(2000);
    if (r.body?.slept_ms !== undefined) expect(r.body.slept_ms).toBe(50);
  });
});

crossDescribe("bench parity", () => {
  let read: Partial<Record<"go" | "py", Res>>;
  let query: Partial<Record<"go" | "py", Res>>;
  let json: Partial<Record<"go" | "py", Res>>;
  beforeAll(async () => {
    [read, query, json] = await Promise.all([
      onAll((t) => req(t, "/bench/db/read?id=42")),
      onAll((t) => req(t, "/bench/db/query")),
      onAll((t) => req(t, "/bench/json", { json: json10kb })),
    ]);
  });

  it("/bench/db/read?id=42 rows identical", () => {
    expect(read.py!.body).toEqual(read.go!.body);
  });
  it("/bench/db/query rows identical", () => {
    expect(query.py!.body).toEqual(query.go!.body);
  });
  it("/bench/json responses identical", () => {
    expect(json.py!.body).toEqual(json.go!.body);
  });
});
