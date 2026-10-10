# Bench module contract (dashboard-server ↔ dashboard-bench)

`dashboard/server/src/bench/` is owned by the **dashboard-bench** agent. The rest of `dashboard/server/` is owned by **dashboard-server**.

The bench module's entry point is `dashboard/server/src/bench/index.ts`:

```ts
import type { Hono } from 'hono';
import type pg from 'pg';
import type { Platform } from '../platform/types.js';
import type { Target } from '../../../shared/api.js';

export interface BenchDeps {
  db: pg.Pool;                                  // dashboard DB
  appDbs: Record<Target, pg.Pool>;              // go_app / py_app (housekeeping: TRUNCATE app.bench_writes)
  platform: Platform;
  targets: Record<Target, string>;              // base URLs, e.g. http://go-server:8080
  contractsDir: string;                         // /contracts (fixtures, rag-queries.json, json-10kb.json)
  reportsDir: string;                           // /reports
  gitSha: string;
  ohaPath: string;                              // /usr/local/bin/oha
  scrapeMetrics: (t: Target) => Promise<MetricsSnapshot | null>;  // provided by dashboard-server (parsed /metrics)
}

export interface MetricsSnapshot {
  ts: number;                                   // Date.now()
  cgroupCpuSeconds: number | null;              // bench_cgroup_cpu_usage_seconds_total
  cgroupThrottledSeconds: number | null;        // bench_cgroup_cpu_throttled_seconds_total
  cgroupMemoryBytes: number | null;             // bench_cgroup_memory_bytes
  requestsTotal: number | null;                 // sum of bench_http_requests_total
  errorsTotal: number | null;                   // sum where status >= 500
  threads: number | null;                       // bench_runtime_threads
  dbPoolInUse: number | null;
  durationBuckets: { le: number; count: number }[] | null;   // bench_http_request_duration_seconds_bucket summed over routes
}

/** Mounted by dashboard-server at /api. It implements every /api/scenarios, /api/runs*, /api/compare,
 *  /api/static*, /api/dx-notes*, /api/report route from dashboard/shared/api.ts. */
export function createBenchRouter(deps: BenchDeps): Hono;

/** Lets /api/live show the active run id. */
export function activeRunId(): string | null;
```

**Dependencies:** dashboard-server owns `dashboard/server/package.json`. The bench module may only use packages already listed there. Any extra package must be listed in the bench agent's final report.

**Type ownership:** `dashboard/server/src/bench/types.ts` (already created by main Claude) exports `BenchDeps` and `MetricsSnapshot`. Neither agent changes it. dashboard-server implements `scrapeMetrics` in `dashboard/server/src/metrics.ts` and mounts the router.
