// Platform factory, selected by PLATFORM=compose|k8s.
import type { Config } from '../config.js';
import type { Platform } from './types.js';
import { ComposePlatform } from './compose.js';

export async function createPlatform(cfg: Config): Promise<Platform> {
  if (cfg.platform === 'k8s') {
    // Loaded lazily so compose mode never initializes the k8s client.
    const { K8sPlatform } = await import('./k8s.js');
    return new K8sPlatform(cfg.k8sNamespace);
  }
  return new ComposePlatform({ project: cfg.composeProject, socketPath: cfg.dockerSocket });
}
