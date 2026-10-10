import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export function fixtureJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(FIXTURES + rel, "utf8")) as T;
}

export function fixtureText(rel: string): string {
  return readFileSync(FIXTURES + rel, "utf8");
}

export function fixtureList(relDir: string): string[] {
  return readdirSync(FIXTURES + relDir).filter((f) => !f.startsWith(".")).sort();
}

export const prompts = fixtureJson<{ plain: string; inventory: string; rag: string; time: string }>("prompts.json");
export const ragQueries = fixtureJson<string[]>("rag-queries.json");
export const expectedBench = fixtureJson<any>("expected-bench.json");

/** Mock LLM word list (contracts/agent-spec.md). */
export const WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do",
  "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua",
];

export function mockBody(tokens: number): string {
  let s = "";
  for (let i = 0; i < tokens; i++) s += WORDS[i % WORDS.length] + " ";
  return s;
}

/** Whitespace-separated word count (usage.input_tokens rule). */
export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
