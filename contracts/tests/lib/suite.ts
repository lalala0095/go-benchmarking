import { describe, it } from "vitest";
import { both, targets, type Target } from "./targets.js";

/** Declare one describe block per configured target. */
export function eachTarget(title: string, fn: (t: Target) => void): void {
  if (targets.length === 0) {
    describe.skip(title, () => {
      it("no targets configured (set GO_URL and/or PY_URL)", () => {});
    });
    return;
  }
  for (const t of targets) describe(`${title} [${t.name}]`, () => fn(t));
}

/** describe() that only runs when both GO_URL and PY_URL are set. */
export const crossDescribe: typeof describe = (both ? describe : describe.skip) as typeof describe;

/** Run fn on every target concurrently; results keyed by target name. */
export async function onAll<T>(fn: (t: Target) => Promise<T>): Promise<Partial<Record<"go" | "py", T>>> {
  const out: Partial<Record<"go" | "py", T>> = {};
  await Promise.all(targets.map(async (t) => (out[t.name] = await fn(t))));
  return out;
}
