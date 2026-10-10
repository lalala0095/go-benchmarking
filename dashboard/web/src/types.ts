// Type-only re-export of the frozen API contract. Never import runtime values from ../../shared.
export type * from '../../shared/api';
import type { Target } from '../../shared/api';

/** Local copy of TARGETS (the shared module is type-only for the web bundle). Go always first. */
export const TARGET_ORDER: readonly Target[] = ['go', 'python'];
export const TARGET_LABEL: Record<Target, string> = { go: 'Go', python: 'Python' };
export const TARGET_SHORT: Record<Target, string> = { go: 'Go', python: 'Py' };
