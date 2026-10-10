import { Suspense, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Activity, BarChart3, FlaskConical, GitCompare, History, Info, Menu, MessageSquare, Moon, Sun } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { IS_MOCK } from '../api';
import { HealthDot, type HealthStatus } from './HealthDot';
import { PlatformBadge } from './PlatformBadge';
import { PageSkeleton, Segmented, cx } from './ui';

const NAV = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/live', label: 'Live', icon: Activity },
  { to: '/bench', label: 'Benchmarks', icon: FlaskConical },
  { to: '/history', label: 'History', icon: History },
  { to: '/compare', label: 'Compare', icon: GitCompare },
  { to: '/about', label: 'About', icon: Info },
];

export function TopBar() {
  const { targets, targetsError, mode, setMode, geminiAvailable, theme, toggleTheme, platform, dbHealth } = useApp();
  const [menu, setMenu] = useState(false);
  const status = (t: 'go' | 'python'): HealthStatus => (targetsError && !targets ? 'down' : !targets ? 'unknown' : targets[t]?.healthy ? 'ok' : 'down');
  const geminiTitle = geminiAvailable ? 'Real Gemini calls (costs money, rate-limited)' : 'Gemini is not configured on either server (set GEMINI_API_KEY in .env)';
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-3 px-3 sm:px-4">
        <a href="/chat" className="flex items-center gap-2 font-semibold" aria-label="ADK Bench home">
          <BarChart3 className="h-5 w-5 text-go" aria-hidden="true" />
          <span className="hidden sm:inline">ADK Bench</span>
        </a>
        <button type="button" className="btn-ghost lg:hidden" aria-label="Toggle navigation" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
        <nav aria-label="Main" className={cx('lg:flex lg:items-center lg:gap-0.5', menu ? 'absolute left-0 right-0 top-12 flex flex-col border-b border-border bg-surface p-2' : 'hidden')}>
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setMenu(false)}
              className={({ isActive }) =>
                cx('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors', isActive ? 'bg-surface2 text-text' : 'text-muted hover:text-text')
              }
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {IS_MOCK && <span className="chip border-warn/50 text-warn" title="VITE_MOCK=1: fixtures, no backend">mock API</span>}
          <div className="hidden items-center gap-2.5 md:flex" aria-label="Service health">
            <HealthDot status={status('go')} label="go" title={targets?.go?.error ?? targets?.go?.url} />
            <HealthDot status={status('python')} label="py" title={targets?.python?.error ?? targets?.python?.url} />
            <HealthDot status={dbHealth === 'ok' ? 'ok' : dbHealth === 'down' ? 'down' : 'unknown'} label="db" title="Postgres (inferred from RAG stats on each server)" />
          </div>
          <Segmented
            label="Chat mode"
            size="xs"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'mock', label: 'Mock', title: 'Deterministic mock LLM — measures server overhead only' },
              { value: 'gemini', label: 'Gemini', disabled: !geminiAvailable, title: geminiTitle },
            ]}
          />
          <PlatformBadge mode={platform?.mode} />
          <button type="button" className="btn-ghost" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
  );
}

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <TopBar />
      <main id="main" className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-3 py-4 sm:px-4">
        <Suspense fallback={<PageSkeleton />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
