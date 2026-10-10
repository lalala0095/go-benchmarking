// API facade. In mock mode (VITE_MOCK=1) the fixture implementation is lazy-loaded,
// so it never ships in the production bundle's main chunk.
import type { Api, StreamHandlers } from './types';
import { realApi } from './real';

export * from './types';

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';

let mockPromise: Promise<Api> | null = null;
function loadMock(): Promise<Api> {
  mockPromise ??= import('./mock').then((m) => m.mockApi);
  return mockPromise;
}

function wrap(): Api {
  if (!IS_MOCK) return realApi;
  const handler: ProxyHandler<Api> = {
    get(_t, prop: keyof Api) {
      if (prop === 'live' || prop === 'runStream') {
        return (...args: unknown[]) => {
          let unsub: (() => void) | null = null;
          let cancelled = false;
          void loadMock().then((m) => {
            if (cancelled) return;
            unsub = (m[prop] as (...a: unknown[]) => () => void)(...args);
          });
          return () => {
            cancelled = true;
            unsub?.();
          };
        };
      }
      return async (...args: unknown[]) => {
        const m = await loadMock();
        return (m[prop] as (...a: unknown[]) => unknown)(...args);
      };
    },
  };
  return new Proxy({} as Api, handler);
}

export const api: Api = wrap();
export type { StreamHandlers };

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
