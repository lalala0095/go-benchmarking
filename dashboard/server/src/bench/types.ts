// Bench module contract types (see ./CONTRACT.md). Owned by main Claude; do not change shapes.
import type pg from 'pg';
import type { Platform } from '../platform/types.js';
import type { Target } from '../../../shared/api.js';

export interface MetricsSnapshot {
  ts: number;
  cgroupCpuSeconds: number | null;
  cgroupThrottledSeconds: number | null;
  cgroupMemoryBytes: number | null;
  requestsTotal: number | null;
  errorsTotal: number | null;
  threads: number | null;
  dbPoolInUse: number | null;
  durationBuckets: { le: number; count: number }[] | null;
}

export interface BenchDeps {
  db: pg.Pool;
  appDbs: Record<Target, pg.Pool>;
  platform: Platform;
  targets: Record<Target, string>;
  contractsDir: string;
  reportsDir: string;
  gitSha: string;
  ohaPath: string;
  scrapeMetrics: (t: Target) => Promise<MetricsSnapshot | null>;
}
