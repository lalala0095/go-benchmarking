/** Self-checks (no server needed): openapi.yaml compiles and the fixtures fit it. */
import { describe, expect, it } from "vitest";
import { fixtureJson, fixtureList } from "../lib/fixtures.js";
import { component, expectComponent, openapi, responseSchema } from "../lib/schema.js";

describe("openapi.yaml self-check", () => {
  it("every component schema compiles", () => {
    for (const name of Object.keys(openapi.components.schemas)) expect(() => component(name), name).not.toThrow();
  });

  it("every documented JSON response schema compiles", () => {
    let n = 0;
    for (const [path, item] of Object.entries<any>(openapi.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (method === "parameters") continue;
        for (const status of Object.keys(op.responses ?? {})) {
          expect(() => responseSchema(path, method, status), `${method} ${path} ${status}`).not.toThrow();
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it("chunking fixtures match the Chunk schema; validator rejects bad shapes", () => {
    for (const f of fixtureList("rag-chunking/expected")) {
      for (const c of fixtureJson<any>(`rag-chunking/expected/${f}`).chunks) expectComponent("Chunk", c, f);
    }
    expect(component("Error")({ code: "NOPE", message: "x" })).toBe(false);
    expect(component("Session")({ session_id: "a", user_id: "u", created_at: "not-a-date" })).toBe(false);
    expect(component("Info")({ impl: "go", runtime: "go1", adk_version: "1", framework: "net/http", workers: 1, model: "m", embed_model: "e", started_at: "2026-01-01T00:00:00Z", gomaxprocs: null })).toBe(true);
  });
});
