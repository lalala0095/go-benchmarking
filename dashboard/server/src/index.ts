// Dashboard backend entry point: config → DB → platform → bench module → HTTP.
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { createPools, waitForDb } from './db.js';
import { createPlatform } from './platform/index.js';
import { createScraper } from './metrics.js';
import { DashboardStore } from './store.js';
import { LiveSampler } from './live.js';
import { createApp } from './app.js';
import { startKbBootstrap } from './kb-bootstrap.js';
import { errMsg, log } from './log.js';
import type { BenchDeps } from './bench/types.js';

interface BenchModule {
  createBenchRouter: (deps: BenchDeps) => Hono;
  activeRunId?: () => string | null;
}

/** The bench module is developed separately; the dashboard must keep serving everything else if it fails to load. */
async function loadBench(deps: BenchDeps): Promise<{ router: Hono | null; activeRunId: () => string | null }> {
  const spec = './bench/index.js'; // non-literal: keeps tsc from requiring the module at build time
  try {
    const mod = (await import(spec)) as BenchModule;
    if (typeof mod.createBenchRouter !== 'function') throw new Error('createBenchRouter export missing');
    const router = mod.createBenchRouter(deps);
    log.info('bench module loaded');
    return { router, activeRunId: typeof mod.activeRunId === 'function' ? mod.activeRunId : () => null };
  } catch (e) {
    log.warn('bench module unavailable; /api/scenarios, /api/runs* etc. are disabled', errMsg(e));
    return { router: null, activeRunId: () => null };
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info(`dashboard starting: platform=${cfg.platform} go=${cfg.targets.go} python=${cfg.targets.python} sha=${cfg.gitSha}`);
  const pools = createPools(cfg);
  // Don't block listening on Postgres: /api/health (k8s liveness) must answer while the DB is still starting.
  // Pools connect lazily; /api/ready reports DB readiness.
  void waitForDb(pools.db, { label: 'dashboard db', timeoutMs: 600_000 }).catch((e) => log.error('dashboard db unreachable', errMsg(e)));
  const platform = await createPlatform(cfg);
  const scrapeMetrics = createScraper(cfg.targets);

  const bench = await loadBench({
    db: pools.db,
    appDbs: pools.appDbs,
    platform,
    targets: cfg.targets,
    contractsDir: cfg.contractsDir,
    reportsDir: cfg.reportsDir,
    gitSha: cfg.gitSha,
    ohaPath: cfg.ohaPath,
    scrapeMetrics,
  });

  const live = new LiveSampler({ platform, targets: cfg.targets, scrapeMetrics, activeRunId: bench.activeRunId });
  const app = createApp({
    platform,
    targets: cfg.targets,
    store: new DashboardStore(pools.db),
    live,
    webDist: cfg.webDist,
    bench: bench.router,
    ready: async () => {
      await pools.db.query({ text: 'SELECT 1', query_timeout: 2_000 } as never);
      return true;
    },
  });

  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (a) => log.info(`listening on :${a.port}`));
  // Long-lived SSE streams: never time them out at the HTTP layer.
  const http = server as unknown as { requestTimeout?: number; headersTimeout?: number; keepAliveTimeout?: number };
  http.requestTimeout = 0;
  http.keepAliveTimeout = 65_000;

  if (cfg.kbBootstrap) startKbBootstrap(cfg.targets);

  const shutdown = (sig: string) => {
    log.info(`${sig} received, shutting down`);
    server.close();
    void Promise.allSettled([pools.db.end(), pools.appDbs.go.end(), pools.appDbs.python.end()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => log.error('unhandled rejection', errMsg(e)));

main().catch((e) => {
  log.error('fatal startup error', errMsg(e));
  process.exit(1);
});
