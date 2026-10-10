import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Suspense } from 'react';

// Route every API call through the fixture implementation.
vi.mock('../api', async () => {
  const types = await vi.importActual<typeof import('../api/types')>('../api/types');
  const { mockApi } = await import('../api/mock');
  return { ...types, api: mockApi, IS_MOCK: true, downloadBlob: vi.fn() };
});

import App from '../App';
import { AppProvider } from '../context/AppContext';

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  window.scrollTo = () => {};
  // Recharts warns about 0×0 containers in jsdom (no layout); not a real problem.
  const warn = console.warn;
  console.warn = (...a: unknown[]) => (String(a[0]).includes('width(0) and height(0)') ? undefined : warn(...a));
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppProvider>
        <Suspense fallback={null}>
          <App />
        </Suspense>
      </AppProvider>
    </MemoryRouter>,
  );
}

const T = { timeout: 8000 };

describe('pages render against mock API', { timeout: 20000 }, () => {
  it('/chat restores the seeded conversation, Go pane first', async () => {
    renderAt('/chat?c=5e1d9a3c-0b7f-4c6e-8a21-9f3b2d1c0e11');
    const panes = await screen.findAllByRole('region', { name: /responses$/ }, T);
    expect(panes.map((p) => p.getAttribute('aria-label'))).toEqual(['Go responses', 'Python responses']);
    expect(await screen.findAllByText(/12,412 items/i, undefined, T)).toHaveLength(2);
  });
  it('/live renders paired charts', async () => {
    renderAt('/live');
    expect(await screen.findByText('Live monitor', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Threads / goroutines', undefined, T)).toBeInTheDocument();
  });
  it('/bench groups scenarios by layer', async () => {
    renderAt('/bench');
    expect(await screen.findByText('L1 · Runtime', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Rollout disruption', undefined, T)).toBeInTheDocument();
  });
  it('/bench/:id shows results for a completed run', async () => {
    renderAt('/bench/7c1e2b90-5d3a-4c2e-9a71-0f3e6d1b2a01');
    expect(await screen.findByText('Latency percentiles', undefined, T)).toBeInTheDocument();
    expect(screen.getByText('Go vs Python')).toBeInTheDocument();
  });
  it('/history lists runs', async () => {
    renderAt('/history');
    expect(await screen.findByText('rollout-disruption', undefined, T)).toBeInTheDocument();
  });
  it('/compare renders a comparison', async () => {
    renderAt('/compare?a=7c1e2b90-5d3a-4c2e-9a71-0f3e6d1b2a01&b=19ebf305-82a3-44c5-9067-8b9c0d1e2f09');
    expect(await screen.findByText('B relative to A, per target', undefined, T)).toBeInTheDocument();
  });
  it('/about renders versions and static data', async () => {
    renderAt('/about');
    expect(await screen.findByText('adk-go v2.5.0', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Cold start', undefined, T)).toBeInTheDocument();
  });
});
