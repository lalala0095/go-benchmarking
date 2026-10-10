/**
 * Stateful knowledge-base suite. Runs the steps in order on every target and
 * compares targets after each step. Leaves both KBs holding exactly the default
 * corpus ingested with the mock embedder.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ragQueries } from "../lib/fixtures.js";
import { qs, req, type Res } from "../lib/http.js";
import { expectError, expectResponse } from "../lib/schema.js";
import { both, RUN_ID, targets, type Target } from "../lib/targets.js";
import { onAll } from "../lib/suite.js";

type ByT<T> = Partial<Record<"go" | "py", T>>;

const MODES = ["hybrid", "vector", "fts"] as const;
const INLINE_SOURCE = `contract-tests/${RUN_ID}.md`;
const INLINE_CONTENT =
  "# Inline Parity\n\nZebra quokka narwhal parity paragraph for the contract suite.\n\n## Second Section\n\nAnother axolotl paragraph, distinct words only here.\n";

function each(fn: (t: Target) => void | Promise<void>) {
  return Promise.all(targets.map(async (t) => fn(t)));
}

async function search(t: Target, params: Record<string, string | number | undefined>): Promise<Res> {
  return req(t, "/v1/rag/search" + qs(params));
}

function sameResults(a: any[], b: any[], ctx: string) {
  const strip = (rs: any[]) => rs.map((r) => ({ source: r.source, title: r.title, heading: r.heading, content: r.content }));
  expect(strip(b), `${ctx}: ordered result list (source/title/heading/content) differs`).toEqual(strip(a));
  a.forEach((r, i) => {
    expect(Math.abs(r.score - b[i].score), `${ctx}: score[${i}] go=${r.score} py=${b[i].score}`).toBeLessThanOrEqual(1e-6);
  });
}

describe.skipIf(targets.length === 0)("rag knowledge base (stateful)", () => {
  describe("wipe + inline documents", () => {
    let ingest: ByT<Res>;

    it("DELETE /v1/rag/documents → 204, stats all zero", async () => {
      await each(async (t) => {
        const d = await req(t, "/v1/rag/documents", { method: "DELETE" });
        expect(d.status, `[${t.name}] ${d.text}`).toBe(204);
        const s = await req(t, "/v1/rag/stats");
        expectResponse(s, "/v1/rag/stats", "get", 200);
        expect(s.body, `[${t.name}]`).toMatchObject({ documents: 0, chunks: 0, chars: 0, gemini_embedded_chunks: 0 });
        expect(s.body.last_ingested_at ?? null, `[${t.name}] last_ingested_at after wipe`).toBeNull();
      });
    });

    it("POST /v1/rag/ingest inline document → 1 document, 2 chunks", async () => {
      ingest = await onAll((t) =>
        req(t, "/v1/rag/ingest", { json: { documents: [{ source: INLINE_SOURCE, content: INLINE_CONTENT }], embedders: ["mock"] } }),
      );
      for (const t of targets) {
        const r = ingest[t.name]!;
        expectResponse(r, "/v1/rag/ingest", "post", 200);
        expect(r.body, `[${t.name}]`).toMatchObject({ documents: 1, skipped: 0, chunks: 2 });
        expect(r.body.embedders, `[${t.name}]`).toContain("mock");
        expect(r.body.chars, `[${t.name}] chars`).toBeGreaterThan(0);
      }
      if (both) {
        const pick = (b: any) => ({ documents: b.documents, skipped: b.skipped, chunks: b.chunks, chars: b.chars, embedders: [...b.embedders].sort() });
        expect(pick(ingest.py!.body)).toEqual(pick(ingest.go!.body));
      }
    });

    it("fts search finds the inline doc with title from the first '# ' heading", async () => {
      await each(async (t) => {
        const r = await search(t, { q: "quokka narwhal", mode: "fts", embedder: "mock", k: 5 });
        expectResponse(r, "/v1/rag/search", "get", 200);
        expect(r.body.results.length, `[${t.name}] ${r.text}`).toBeGreaterThan(0);
        expect(r.body.results[0], `[${t.name}]`).toMatchObject({ source: INLINE_SOURCE, title: "Inline Parity", heading: "Inline Parity" });
        const r2 = await search(t, { q: "axolotl", mode: "hybrid", embedder: "mock", k: 5 });
        expectResponse(r2, "/v1/rag/search", "get", 200);
        expect(r2.body.results[0], `[${t.name}]`).toMatchObject({ source: INLINE_SOURCE, heading: "Second Section" });
      });
    });

    it("re-ingesting the same inline document is skipped; force + explicit title re-ingests", async () => {
      await each(async (t) => {
        const again = await req(t, "/v1/rag/ingest", { json: { documents: [{ source: INLINE_SOURCE, content: INLINE_CONTENT }], embedders: ["mock"] } });
        expectResponse(again, "/v1/rag/ingest", "post", 200);
        expect(again.body, `[${t.name}]`).toMatchObject({ documents: 0, skipped: 1 });
        const forced = await req(t, "/v1/rag/ingest", {
          json: { documents: [{ source: INLINE_SOURCE, title: "Custom Title", content: INLINE_CONTENT }], embedders: ["mock"], force: true },
        });
        expectResponse(forced, "/v1/rag/ingest", "post", 200);
        expect(forced.body, `[${t.name}]`).toMatchObject({ documents: 1, skipped: 0, chunks: 2 });
        const s = await search(t, { q: "quokka", mode: "fts", k: 1 });
        expect(s.body.results[0]?.title, `[${t.name}]`).toBe("Custom Title");
        const st = await req(t, "/v1/rag/stats");
        expect(st.body, `[${t.name}] stats after force re-ingest`).toMatchObject({ documents: 1, chunks: 2 });
      });
    });

    it("invalid ingest requests → 400 Error", async () => {
      await each(async (t) => {
        expectError(await req(t, "/v1/rag/ingest", { json: { corpus: "nope" } }), 400, ["BAD_REQUEST"], `[${t.name}] corpus=nope`);
        expectError(await req(t, "/v1/rag/ingest", { json: { corpus: "default", embedders: ["bogus"] } }), 400, ["BAD_REQUEST"], `[${t.name}] embedders=[bogus]`);
        expectError(await req(t, "/v1/rag/ingest", { json: { corpus: "default", repeat: 0 } }), 400, ["BAD_REQUEST"], `[${t.name}] repeat=0`);
        expectError(await req(t, "/v1/rag/ingest", { json: { documents: [{ source: "x.md" }] } }), 400, ["BAD_REQUEST"], `[${t.name}] document without content`);
        expectError(await req(t, "/v1/rag/ingest", { raw: "{not json" }), 400, ["BAD_REQUEST"], `[${t.name}] malformed JSON`);
      });
    });
  });

  describe("default corpus (mock)", () => {
    let first: ByT<Res>;

    beforeAll(async () => {
      await each(async (t) => {
        const d = await req(t, "/v1/rag/documents", { method: "DELETE" });
        expect(d.status).toBe(204);
      });
      first = await onAll((t) => req(t, "/v1/rag/ingest", { json: { corpus: "default", embedders: ["mock"] }, timeoutMs: 120_000 }));
    });

    it("POST /v1/rag/ingest {corpus:default, embedders:[mock]} → IngestResponse", () => {
      for (const t of targets) {
        const r = first[t.name]!;
        expectResponse(r, "/v1/rag/ingest", "post", 200);
        expect(r.body.documents, `[${t.name}]`).toBeGreaterThan(0);
        expect(r.body.skipped, `[${t.name}]`).toBe(0);
        expect(r.body.chunks, `[${t.name}]`).toBeGreaterThanOrEqual(r.body.documents);
        expect(r.body.embedders, `[${t.name}]`).toEqual(["mock"]);
      }
    });

    it.runIf(both)("documents / chunks / chars equal across targets", () => {
      const pick = (b: any) => ({ documents: b.documents, skipped: b.skipped, chunks: b.chunks, chars: b.chars });
      expect(pick(first.py!.body)).toEqual(pick(first.go!.body));
    });

    it("re-ingest without force → everything skipped", async () => {
      const again = await onAll((t) => req(t, "/v1/rag/ingest", { json: { corpus: "default", embedders: ["mock"] } }));
      for (const t of targets) {
        const r = again[t.name]!;
        expectResponse(r, "/v1/rag/ingest", "post", 200);
        expect(r.body, `[${t.name}]`).toMatchObject({ documents: 0, skipped: first[t.name]!.body.documents });
      }
      if (both) expect({ ...again.py!.body, timings: 0 }).toEqual({ ...again.go!.body, timings: 0 });
    });

    it("GET /v1/rag/stats matches the ingest totals (and is equal across targets)", async () => {
      const st = await onAll((t) => req(t, "/v1/rag/stats"));
      for (const t of targets) {
        const s = st[t.name]!;
        expectResponse(s, "/v1/rag/stats", "get", 200);
        const ing = first[t.name]!.body;
        expect(s.body, `[${t.name}]`).toMatchObject({ documents: ing.documents, chunks: ing.chunks, chars: ing.chars, gemini_embedded_chunks: 0 });
        expect(typeof s.body.last_ingested_at, `[${t.name}] last_ingested_at`).toBe("string");
      }
      if (both) {
        const pick = (b: any) => ({ documents: b.documents, chunks: b.chunks, chars: b.chars, gemini_embedded_chunks: b.gemini_embedded_chunks });
        expect(pick(st.py!.body)).toEqual(pick(st.go!.body));
      }
    });

    describe.each(MODES)("GET /v1/rag/search mode=%s embedder=mock", (mode) => {
      it.each(ragQueries)("%s", async (q) => {
        const rs = await onAll((t) => search(t, { q, mode, embedder: "mock", k: 5 }));
        for (const t of targets) {
          const r = rs[t.name]!;
          expectResponse(r, "/v1/rag/search", "get", 200);
          expect(r.body, `[${t.name}]`).toMatchObject({ query: q, mode, embedder: "mock" });
          expect(r.body.results.length, `[${t.name}]`).toBeLessThanOrEqual(5);
          if (mode !== "fts") expect(r.body.results.length, `[${t.name}] ${mode} always has candidates`).toBe(5);
          // non-increasing within 1e-6: the vector arm orders by the HNSW index distance (float4),
          // while the score column recomputes it, so near-ties can be off by ~1e-8
          const scores: number[] = r.body.results.map((x: any) => x.score);
          scores.slice(1).forEach((s, i) => expect(s, `[${t.name}] scores non-increasing at ${i + 1}: ${scores.join(", ")}`).toBeLessThanOrEqual(scores[i]! + 1e-6));
        }
        if (both) sameResults(rs.go!.body.results, rs.py!.body.results, `${mode} "${q}"`);
      });
    });

    it("defaults: mode=hybrid, embedder=mock, k=5", async () => {
      const rs = await onAll((t) => search(t, { q: ragQueries[0] }));
      for (const t of targets) {
        expectResponse(rs[t.name]!, "/v1/rag/search", "get", 200);
        expect(rs[t.name]!.body, `[${t.name}]`).toMatchObject({ mode: "hybrid", embedder: "mock" });
        expect(rs[t.name]!.body.results, `[${t.name}]`).toHaveLength(5);
      }
      if (both) sameResults(rs.go!.body.results, rs.py!.body.results, "defaults");
    });

    it("k=1 and k=20 bound the result count", async () => {
      await each(async (t) => {
        const one = await search(t, { q: ragQueries[1], k: 1 });
        expectResponse(one, "/v1/rag/search", "get", 200);
        expect(one.body.results).toHaveLength(1);
        const twenty = await search(t, { q: ragQueries[1], k: 20, mode: "vector" });
        expectResponse(twenty, "/v1/rag/search", "get", 200);
        expect(twenty.body.results.length).toBeLessThanOrEqual(20);
        expect(twenty.body.results.length).toBe(Math.min(20, first[t.name]!.body.chunks));
      });
    });

    it("preset=random → a query from rag-queries.json, valid shape", async () => {
      await each(async (t) => {
        for (const mode of MODES) {
          const r = await search(t, { preset: "random", mode });
          expectResponse(r, "/v1/rag/search", "get", 200);
          expect(ragQueries, `[${t.name}] preset query`).toContain(r.body.query);
          expect(r.body.mode).toBe(mode);
        }
      });
    });

    it("invalid search params → 400 Error", async () => {
      const bad: Record<string, string | number>[] = [
        {},
        { q: "x", k: 0 },
        { q: "x", k: 21 },
        { q: "x", k: "abc" },
        { q: "x", mode: "bogus" },
        { q: "x", embedder: "bogus" },
        { preset: "bogus" },
      ];
      await each(async (t) => {
        for (const p of bad) expectError(await search(t, p), 400, ["BAD_REQUEST"], `[${t.name}] search ${JSON.stringify(p)}`);
      });
    });
  });
});
