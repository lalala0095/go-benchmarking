import { beforeAll, expect, it } from "vitest";
import { fixtureJson, fixtureList, fixtureText } from "../lib/fixtures.js";
import { req, type Res } from "../lib/http.js";
import { expectError, expectResponse } from "../lib/schema.js";
import { crossDescribe, eachTarget, onAll } from "../lib/suite.js";

const cases = fixtureList("rag-chunking/cases");
const embedTexts = fixtureJson<string[]>("rag-embed/texts.json");
const expectedMock = fixtureJson<{ dim: number; tolerance: number; vectors: number[][] }>("rag-embed/expected-mock.json");

function maxAbsDiff(a: number[], b: number[]): { max: number; at: number } {
  let max = 0;
  let at = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = Math.abs((a[i] ?? NaN) - (b[i] ?? NaN));
    if (!(d <= max)) {
      max = Number.isNaN(d) ? Infinity : d;
      at = i;
    }
  }
  return { max, at };
}

eachTarget("rag chunk/embed", (t) => {
  it.each(cases)("POST /v1/rag/chunk %s → byte-equal to expected", async (name) => {
    const content = fixtureText(`rag-chunking/cases/${name}`);
    const expected = fixtureJson<{ chunks: any[] }>(`rag-chunking/expected/${name}.json`).chunks;
    const r = await req(t, "/v1/rag/chunk", { json: { content } });
    expectResponse(r, "/v1/rag/chunk", "post", 200);
    expect(r.body.chunks).toEqual(expected);
    // byte-equality of the serialized chunk list (key order + exact strings)
    const norm = (cs: any[]) => JSON.stringify(cs.map((c) => [c.chunk_index, c.heading, c.content]));
    expect(norm(r.body.chunks)).toBe(norm(expected));
  });

  it("POST /v1/rag/chunk without content → 400 Error", async () => {
    const r = await req(t, "/v1/rag/chunk", { json: {} });
    expectError(r, 400, ["BAD_REQUEST"], "chunk {}");
  });

  it("POST /v1/rag/embed (mock) → expected-mock.json within tolerance", async () => {
    const r = await req(t, "/v1/rag/embed", { json: { texts: embedTexts, embedder: "mock", task: "document" } });
    expectResponse(r, "/v1/rag/embed", "post", 200);
    expect(r.body.dim).toBe(768);
    expect(r.body.vectors).toHaveLength(expectedMock.vectors.length);
    r.body.vectors.forEach((v: number[], i: number) => {
      expect(v, `vector ${i} length`).toHaveLength(768);
      const d = maxAbsDiff(v, expectedMock.vectors[i]!);
      expect(d.max, `vector ${i} (${JSON.stringify(embedTexts[i]).slice(0, 40)}) max |Δ| at dim ${d.at}`).toBeLessThanOrEqual(expectedMock.tolerance);
    });
  });

  it("POST /v1/rag/embed defaults to mock; task=query gives the same mock vectors", async () => {
    const r = await req(t, "/v1/rag/embed", { json: { texts: embedTexts.slice(0, 3), task: "query" } });
    expectResponse(r, "/v1/rag/embed", "post", 200);
    r.body.vectors.forEach((v: number[], i: number) => {
      expect(maxAbsDiff(v, expectedMock.vectors[i]!).max).toBeLessThanOrEqual(expectedMock.tolerance);
    });
  });

  it("POST /v1/rag/embed invalid input → 400 Error", async () => {
    expectError(await req(t, "/v1/rag/embed", { json: {} }), 400, ["BAD_REQUEST"], "embed {}");
    expectError(await req(t, "/v1/rag/embed", { json: { texts: ["a"], embedder: "bogus" } }), 400, ["BAD_REQUEST"], "embed embedder=bogus");
    expectError(await req(t, "/v1/rag/embed", { json: { texts: ["a"], task: "bogus" } }), 400, ["BAD_REQUEST"], "embed task=bogus");
    const tooMany = Array.from({ length: 257 }, (_, i) => `t${i}`);
    expectError(await req(t, "/v1/rag/embed", { json: { texts: tooMany } }), 400, ["BAD_REQUEST"], "embed 257 texts");
  });
});

crossDescribe("rag chunk/embed parity", () => {
  let large: Partial<Record<"go" | "py", Res>>;
  let emb: Partial<Record<"go" | "py", Res>>;
  beforeAll(async () => {
    const content = fixtureText("rag-chunking/large.md");
    [large, emb] = await Promise.all([
      onAll((t) => req(t, "/v1/rag/chunk", { json: { content } })),
      onAll((t) => req(t, "/v1/rag/embed", { json: { texts: embedTexts, embedder: "mock" } })),
    ]);
  });

  it("large.md chunks identical across targets", () => {
    expect(large.go!.status).toBe(200);
    expect(large.py!.status).toBe(200);
    expect(large.go!.body.chunks.length).toBeGreaterThan(1);
    const norm = (cs: any[]) => JSON.stringify(cs.map((c) => [c.chunk_index, c.heading, c.content]));
    expect(norm(large.py!.body.chunks)).toBe(norm(large.go!.body.chunks));
  });

  it("mock vectors agree within 1e-6 across targets", () => {
    const g = emb.go!.body.vectors as number[][];
    const p = emb.py!.body.vectors as number[][];
    expect(p.length).toBe(g.length);
    g.forEach((v, i) => expect(maxAbsDiff(v, p[i]!).max, `vector ${i}`).toBeLessThanOrEqual(1e-6));
  });
});
