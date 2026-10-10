/**
 * Timing-semantics audit (docs/06 Phase 2). Opt-in: TIMING_AUDIT=1.
 * Assumes the servers run with the default mock env (250 ms first token, 60 × 15 ms).
 * Requests are sequential (no concurrency) so the numbers reflect an idle server.
 */
import { describe, expect, it } from "vitest";
import { ensureKb, expectedModelMs, newSession } from "../lib/chat.js";
import { prompts } from "../lib/fixtures.js";
import { postSse } from "../lib/sse.js";
import { RUN_ID, TIMING_AUDIT, targets } from "../lib/targets.js";

const REPS = Number(process.env.TIMING_AUDIT_REPS ?? 5);
/** relative tolerance on model_ms (Phase 2 gate: 5%) */
const TOL = Number(process.env.TIMING_AUDIT_TOLERANCE ?? 0.05);
const USER = `${RUN_ID}-timing`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

describe.skipIf(!TIMING_AUDIT || targets.length === 0)("timing audit (TIMING_AUDIT=1)", () => {
  for (const t of targets) {
    describe.each(["plain", "inventory", "rag"] as const)(`[${t.name}] %s`, (b) => {
      it(
        `model_ms ≈ expected ± tolerance, overhead_ms < 50 (median of ${REPS}, after 1 warm-up)`,
        async () => {
          await ensureKb(t);
          const samples: { model: number; overhead: number; total: number; tool: number; session: number }[] = [];
          for (let i = 0; i <= REPS; i++) {
            const sid = await newSession(t, USER);
            const s = await postSse(t, "/v1/chat/stream", { user_id: USER, session_id: sid, message: prompts[b], mode: "mock" });
            const done = s.events.at(-1);
            expect(done?.event, `[${t.name}/${b}] stream ended with ${done?.event}`).toBe("done");
            const tm = done!.data.timings;
            if (i > 0) samples.push({ model: tm.model_ms, overhead: tm.overhead_ms, total: tm.server_total_ms, tool: tm.tool_ms, session: tm.session_ms });
          }
          const exp = expectedModelMs(b !== "plain");
          const mModel = median(samples.map((x) => x.model));
          const mOver = median(samples.map((x) => x.overhead));
          const detail = JSON.stringify(samples.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
          console.log(`[timing ${t.name}/${b}] expected model≈${exp} median model=${mModel.toFixed(1)} overhead=${mOver.toFixed(2)} samples=${detail}`);
          expect(Math.abs(mModel - exp) / exp, `[${t.name}/${b}] median model_ms=${mModel.toFixed(1)} vs ${exp} ±${TOL * 100}%; ${detail}`).toBeLessThanOrEqual(TOL);
          expect(mOver, `[${t.name}/${b}] median overhead_ms; ${detail}`).toBeLessThan(50);
        },
        120_000,
      );
    });
  }
});
