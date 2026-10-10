import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Mod, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsMod from "ajv-formats";
import { parse } from "yaml";
import { expect } from "vitest";
import type { Res } from "./http.js";

// CJS default-export interop under NodeNext
const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;
const addFormats = (addFormatsMod as any).default ?? addFormatsMod;

const OPENAPI_PATH = fileURLToPath(new URL("../../openapi.yaml", import.meta.url));
export const openapi: any = parse(readFileSync(OPENAPI_PATH, "utf8"));

const COMPONENTS_ID = "openapi-components.json";

/** Rewrite "#/components/schemas/X" refs to the standalone components schema. */
function rewriteRefs(node: any): any {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/schemas/")) {
        out[k] = `${COMPONENTS_ID}#/$defs/${v.slice("#/components/schemas/".length)}`;
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out;
  }
  return node;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: COMPONENTS_ID, $defs: rewriteRefs(openapi.components.schemas) });

const cache = new Map<string, ValidateFunction>();

/** Validator for a named component schema (e.g. "Info", "Error"). */
export function component(name: string): ValidateFunction {
  const key = `c:${name}`;
  let v = cache.get(key);
  if (!v) {
    if (!openapi.components.schemas[name]) throw new Error(`no component schema ${name}`);
    v = ajv.compile({ $ref: `${COMPONENTS_ID}#/$defs/${name}` }) as ValidateFunction;
    cache.set(key, v);
  }
  return v;
}

/** Validator for a documented response body: paths[path][method].responses[status]. */
export function responseSchema(path: string, method: string, status: number | string): ValidateFunction | null {
  const key = `r:${method}:${path}:${status}`;
  if (cache.has(key)) return cache.get(key)!;
  const op = openapi.paths?.[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`openapi has no operation ${method.toUpperCase()} ${path}`);
  const resp = op.responses?.[String(status)];
  if (!resp) throw new Error(`openapi documents no ${status} response for ${method.toUpperCase()} ${path}`);
  const schema = resp.content?.["application/json"]?.schema;
  if (!schema) return null;
  const v = ajv.compile(rewriteRefs(schema)) as ValidateFunction;
  cache.set(key, v);
  return v;
}

function fmtErrors(v: ValidateFunction): string {
  return ajv.errorsText(v.errors, { separator: "\n  " });
}

/** Assert body validates against a component schema. */
export function expectComponent(name: string, body: unknown, ctx = ""): void {
  const v = component(name);
  const ok = v(body);
  expect(ok, `${ctx} body does not match #/components/schemas/${name}:\n  ${ok ? "" : fmtErrors(v)}\nbody: ${JSON.stringify(body)?.slice(0, 500)}`).toBe(true);
}

/**
 * Assert the response has the expected status and (if documented) a JSON body
 * matching the schema declared in openapi.yaml for that path/method/status.
 */
export function expectResponse(r: Res, path: string, method: string, status: number): void {
  const head = `${method.toUpperCase()} ${path}`;
  expect(r.status, `${head}: expected ${status}, got ${r.status}: ${r.text.slice(0, 400)}`).toBe(status);
  const v = responseSchema(path, method, status);
  if (!v) return;
  expect(r.headers.get("content-type") ?? "", `${head}: content-type`).toMatch(/application\/json/);
  const ok = v(r.body);
  expect(ok, `${head} ${status} body does not match openapi schema:\n  ${ok ? "" : fmtErrors(v)}\nbody: ${r.text.slice(0, 500)}`).toBe(true);
}

/** Assert a 4xx/5xx with the shared Error shape (and optionally a code). */
export function expectError(r: Res, status: number, codes?: string[], ctx = ""): void {
  expect(r.status, `${ctx} expected HTTP ${status}, got ${r.status}: ${r.text.slice(0, 400)}`).toBe(status);
  expectComponent("Error", r.body, ctx);
  if (codes) expect(codes, `${ctx} error code ${r.body?.code}`).toContain(r.body.code);
}
