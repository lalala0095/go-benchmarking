/** /metrics exposes every docs/02 §7 metric name on every target (after some traffic). */
import { beforeAll, expect, it } from "vitest";
import { newSession } from "../lib/chat.js";
import { req } from "../lib/http.js";
import { postSse } from "../lib/sse.js";
import { crossDescribe, eachTarget, onAll } from "../lib/suite.js";
import { RUN_ID, targets } from "../lib/targets.js";

/** [metric family, sample name that must appear] */
const METRICS: [string, string][] = [
  ["bench_http_requests_total", "bench_http_requests_total"],
  ["bench_http_request_duration_seconds", "bench_http_request_duration_seconds_bucket"],
  ["bench_chat_overhead_seconds", "bench_chat_overhead_seconds_bucket"],
  ["bench_chat_model_seconds", "bench_chat_model_seconds_bucket"],
  ["bench_db_pool_in_use", "bench_db_pool_in_use"],
  ["bench_db_pool_max", "bench_db_pool_max"],
  ["bench_runtime_threads", "bench_runtime_threads"],
  ["process_resident_memory_bytes", "process_resident_memory_bytes"],
  ["process_cpu_seconds_total", "process_cpu_seconds_total"],
  ["bench_cgroup_cpu_usage_seconds_total", "bench_cgroup_cpu_usage_seconds_total"],
  ["bench_cgroup_cpu_throttled_seconds_total", "bench_cgroup_cpu_throttled_seconds_total"],
  ["bench_cgroup_memory_bytes", "bench_cgroup_memory_bytes"],
];

/** sample lines: name{labels} value */
function samples(text: string, name: string): { labels: Record<string, string>; value: number }[] {
  const out: { labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const labels: Record<string, string> = {};
    for (const kv of (m[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[kv[1]!] = kv[2]!;
    out.push({ labels, value: Number(m[4]) });
  }
  return out;
}

const texts: Partial<Record<"go" | "py", string>> = {};

beforeAll(async () => {
  await Promise.all(
    targets.map(async (t) => {
      // traffic: bench, db, and a mock chat so the chat histograms have samples
      await req(t, "/bench/ping");
      await req(t, "/bench/db/read?id=1");
      const sid = await newSession(t, `${RUN_ID}-metrics`);
      await postSse(t, "/v1/chat/stream", { user_id: `${RUN_ID}-metrics`, session_id: sid, message: "metrics warmup", mode: "mock" });
      const r = await req(t, "/metrics", { headers: { accept: "text/plain" } });
      texts[t.name] = r.status === 200 ? r.text : "";
    }),
  );
}, 60_000);

eachTarget("metrics", (t) => {
  it("GET /metrics → 200 text/plain", async () => {
    const r = await req(t, "/metrics", { headers: { accept: "text/plain" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/^text\/plain/);
  });

  it.each(METRICS)("exposes %s", (family, sample) => {
    const s = samples(texts[t.name]!, sample);
    expect(s.length, `[${t.name}] no '${sample}' samples in /metrics`).toBeGreaterThan(0);
    for (const x of s) expect(Number.isNaN(x.value), `[${t.name}] ${family} value`).toBe(false);
  });

  it("label sets: requests_total{route,status}, duration{route}, chat histograms{mode=mock}", () => {
    const txt = texts[t.name]!;
    const req = samples(txt, "bench_http_requests_total");
    expect(req.some((x) => "route" in x.labels && "status" in x.labels), `[${t.name}] requests_total labels`).toBe(true);
    const dur = samples(txt, "bench_http_request_duration_seconds_bucket");
    expect(dur.some((x) => "route" in x.labels), `[${t.name}] duration labels`).toBe(true);
    for (const h of ["bench_chat_overhead_seconds_bucket", "bench_chat_model_seconds_bucket"]) {
      expect(samples(txt, h).some((x) => x.labels.mode === "mock"), `[${t.name}] ${h}{mode="mock"}`).toBe(true);
    }
  });

  it("gauges are sane", () => {
    const txt = texts[t.name]!;
    const v = (n: string) => samples(txt, n).reduce((a, x) => a + x.value, 0);
    expect(v("bench_db_pool_max"), `[${t.name}] pool max`).toBeGreaterThan(0);
    expect(v("bench_runtime_threads"), `[${t.name}] threads`).toBeGreaterThan(0);
    expect(v("bench_cgroup_memory_bytes"), `[${t.name}] cgroup memory`).toBeGreaterThan(0);
    expect(v("bench_cgroup_cpu_usage_seconds_total"), `[${t.name}] cgroup cpu`).toBeGreaterThan(0);
  });
});

crossDescribe("metrics parity", () => {
  it("same set of bench_* metric names on both targets", async () => {
    const names = (txt: string) =>
      [...new Set(txt.split("\n").filter((l) => /^bench_/.test(l)).map((l) => l.split(/[{\s]/)[0]!).filter((n) => !n.endsWith("_created")))].sort();
    const all = await onAll(async (t) => names(texts[t.name] ?? ""));
    expect(all.py).toEqual(all.go);
  });

  it("route label values agree for the shared routes", () => {
    const routes = (txt: string) => new Set(samples(txt, "bench_http_requests_total").map((x) => x.labels.route));
    const g = routes(texts.go!);
    const p = routes(texts.py!);
    for (const r of ["/bench/ping", "/bench/db/read", "/v1/chat/stream", "/v1/sessions"]) {
      expect(g.has(r), `go route label ${r} (have: ${[...g].join(", ")})`).toBe(true);
      expect(p.has(r), `py route label ${r} (have: ${[...p].join(", ")})`).toBe(true);
    }
  });
});
