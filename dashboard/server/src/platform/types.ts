// Platform adapter interface (docs/02-TECHNICAL-REQUIREMENTS.md §8.1).
// Scenario/orchestrator code must only talk to Docker or Kubernetes through this.
import type { ContainerStats, PlatformInfo, PlatformMode, Target } from '../../../shared/api.js';

export type Workload = Target | 'postgres' | 'dashboard';

export interface HpaConfig { minReplicas: number; maxReplicas: number; cpuUtilization: number }
export interface RolloutResult { startedAt: string; completedAt: string; durationMs: number; newPods: string[] }

export interface Platform {
  readonly mode: PlatformMode;
  info(): Promise<PlatformInfo>;
  /** Container/pod-level stats. For k8s with several replicas, values are summed (cpu, mem). */
  containerStats(w: Workload): Promise<ContainerStats | null>;
  /** Restart a server and resolve once it is Ready again (compose: docker restart + healthy; k8s: delete pod, watch Ready). */
  restart(t: Target): Promise<{ readyMs: number }>;
  /** Number of ready replicas (compose: 0 or 1). */
  replicas(t: Target): Promise<number>;
  scale?(t: Target, replicas: number): Promise<void>;
  setHpa?(t: Target, cfg: HpaConfig | null): Promise<void>;
  rollout?(t: Target): Promise<RolloutResult>;
  /** Preflight guard: true if the *other* stack (k3s when in compose, compose when in k8s) appears active. */
  isOtherStackActive(): Promise<boolean>;
}
