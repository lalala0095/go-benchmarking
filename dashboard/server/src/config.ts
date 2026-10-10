// Runtime configuration from the environment (docker-compose.yml `dashboard` block / k8s Deployment env).
import type { PlatformMode, Target } from '../../shared/api.js';

export interface Config {
  port: number;
  platform: PlatformMode;
  k8sNamespace: string;
  composeProject: string;
  targets: Record<Target, string>;
  databaseUrl: string;
  appDatabaseUrls: Record<Target, string>;
  contractsDir: string;
  reportsDir: string;
  webDist: string;
  gitSha: string;
  ohaPath: string;
  dockerSocket: string;
  kbBootstrap: boolean;
}

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const v = env[key];
  return v === undefined || v === '' ? def : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const platform = str(env, 'PLATFORM', 'compose');
  if (platform !== 'compose' && platform !== 'k8s') {
    throw new Error(`PLATFORM must be compose|k8s, got ${platform}`);
  }
  const port = Number(str(env, 'PORT', '3000'));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT ${env.PORT}`);
  const pgUser = str(env, 'POSTGRES_USER', 'bench');
  const pgPass = str(env, 'POSTGRES_PASSWORD', 'bench');
  const pgBase = `postgres://${pgUser}:${pgPass}@postgres:5432`;
  return {
    port,
    platform,
    k8sNamespace: str(env, 'K8S_NAMESPACE', 'bench'),
    composeProject: str(env, 'COMPOSE_PROJECT', 'go-benchmarking'),
    targets: {
      go: str(env, 'GO_URL', 'http://go-server:8080').replace(/\/+$/, ''),
      python: str(env, 'PY_URL', 'http://fastapi-server:8080').replace(/\/+$/, ''),
    },
    databaseUrl: str(env, 'DATABASE_URL', `${pgBase}/dashboard`),
    appDatabaseUrls: {
      go: str(env, 'GO_APP_DATABASE_URL', `${pgBase}/go_app`),
      python: str(env, 'PY_APP_DATABASE_URL', `${pgBase}/py_app`),
    },
    contractsDir: str(env, 'CONTRACTS_DIR', '/contracts'),
    reportsDir: str(env, 'REPORTS_DIR', '/reports'),
    webDist: str(env, 'WEB_DIST', '/app/web/dist'),
    gitSha: str(env, 'GIT_SHA', 'dev'),
    ohaPath: str(env, 'OHA_PATH', '/usr/local/bin/oha'),
    dockerSocket: str(env, 'DOCKER_SOCKET', '/var/run/docker.sock'),
    kbBootstrap: str(env, 'KB_BOOTSTRAP', '1') !== '0',
  };
}
