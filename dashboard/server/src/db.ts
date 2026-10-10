// Postgres pools: dashboard DB (read/write) + the two app DBs (housekeeping for the bench module).
import pg from 'pg';
import type { Target } from '../../shared/api.js';
import type { Config } from './config.js';
import { errMsg, log, sleep } from './log.js';

export interface Pools {
  db: pg.Pool;
  appDbs: Record<Target, pg.Pool>;
}

function pool(url: string, max: number): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  // An idle client error must never crash the process (e.g. Postgres restarted).
  p.on('error', (e) => log.warn('pg pool error', errMsg(e)));
  return p;
}

export function createPools(cfg: Config): Pools {
  return {
    db: pool(cfg.databaseUrl, 10),
    appDbs: { go: pool(cfg.appDatabaseUrls.go, 2), python: pool(cfg.appDatabaseUrls.python, 2) },
  };
}

/** Blocks until the dashboard DB answers `SELECT 1` (exponential backoff, capped). */
export async function waitForDb(p: pg.Pool, opts: { timeoutMs?: number; label?: string } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let delay = 250;
  for (let attempt = 1; ; attempt++) {
    try {
      await p.query('SELECT 1');
      if (attempt > 1) log.info(`${opts.label ?? 'db'} ready after ${attempt} attempts`);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`${opts.label ?? 'db'} not reachable: ${errMsg(e)}`);
      if (attempt === 1 || attempt % 10 === 0) log.warn(`waiting for ${opts.label ?? 'db'}: ${errMsg(e)}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 3_000);
    }
  }
}
