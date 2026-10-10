import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChatMode, PlatformInfo, Target, TargetsResponse } from '../types';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { useLocalStorage } from '../hooks/useLocalStorage';

export type Theme = 'dark' | 'light';
export type DbHealth = 'ok' | 'down' | 'unknown';

interface AppCtx {
  theme: Theme;
  toggleTheme: () => void;
  mode: ChatMode;
  setMode: (m: ChatMode) => void;
  geminiAvailable: boolean;
  targets: TargetsResponse | undefined;
  targetsError: Error | undefined;
  refreshTargets: () => void;
  platform: PlatformInfo | undefined;
  dbHealth: DbHealth;
  isHealthy: (t: Target) => boolean;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useLocalStorage<Theme>('bench.theme.v', 'dark');
  const [storedMode, setStoredMode] = useLocalStorage<ChatMode>('bench.mode', 'mock');
  const t = useAsync(() => api.targets(), [], { pollMs: 5000 });
  const p = useAsync(() => api.platform(), [], { pollMs: 15000 });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('bench.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const geminiAvailable = !!(t.data?.go?.info?.gemini_configured || t.data?.python?.info?.gemini_configured);
  const mode: ChatMode = storedMode === 'gemini' && t.data && !geminiAvailable ? 'mock' : storedMode;

  // TargetsResponse has no explicit DB health: infer it from RAG stats (requires a DB query on each server).
  const dbHealth: DbHealth = useMemo(() => {
    if (!t.data) return 'unknown';
    const sides = [t.data.go, t.data.python].filter((s) => s?.healthy);
    if (!sides.length) return 'unknown';
    if (sides.some((s) => s.rag)) return 'ok';
    if (sides.some((s) => /db|postgres|database/i.test(s.error ?? ''))) return 'down';
    return 'unknown';
  }, [t.data]);

  const isHealthy = useCallback((target: Target) => !!t.data?.[target]?.healthy, [t.data]);
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  const value: AppCtx = {
    theme,
    toggleTheme,
    mode,
    setMode: setStoredMode,
    geminiAvailable,
    targets: t.data,
    targetsError: t.error,
    refreshTargets: t.reload,
    platform: p.data,
    dbHealth,
    isHealthy,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

/** For components that may render outside the provider (tests). */
export function useAppOptional(): AppCtx | null {
  return useContext(Ctx);
}

export function useToggle(initial = false): [boolean, () => void, (v: boolean) => void] {
  const [v, setV] = useState(initial);
  return [v, useCallback(() => setV((x) => !x), []), setV];
}
