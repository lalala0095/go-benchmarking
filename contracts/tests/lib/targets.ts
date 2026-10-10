/** Targets under test, from GO_URL / PY_URL. A target whose env is unset is skipped. */
export type Impl = "go" | "python";

export interface Target {
  name: "go" | "py";
  impl: Impl;
  url: string;
}

function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

export const targets: Target[] = [
  process.env.GO_URL ? { name: "go", impl: "go", url: trim(process.env.GO_URL) } : null,
  process.env.PY_URL ? { name: "py", impl: "python", url: trim(process.env.PY_URL) } : null,
].filter((t): t is Target => t !== null);

/** Cross-target equality tests run only when both targets are configured. */
export const both = targets.length === 2;
export const goT = targets.find((t) => t.name === "go");
export const pyT = targets.find((t) => t.name === "py");

if (targets.length === 0) {
  // eslint-disable-next-line no-console
  console.warn("contract tests: neither GO_URL nor PY_URL is set — every suite will be skipped");
}

/** Env knobs mirrored from the servers' defaults (docs/02 §4.3). */
export const MOCK_TOKENS = Number(process.env.MOCK_TOKENS ?? 60);
export const MOCK_FIRST_TOKEN_DELAY_MS = Number(process.env.MOCK_FIRST_TOKEN_DELAY_MS ?? 250);
export const MOCK_TOKEN_DELAY_MS = Number(process.env.MOCK_TOKEN_DELAY_MS ?? 15);
export const TIMING_AUDIT = process.env.TIMING_AUDIT === "1";

/** Unique id per suite run, used for user_ids and test documents. */
export const RUN_ID = `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
