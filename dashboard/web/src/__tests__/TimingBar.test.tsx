import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimingBar, timingSegments } from '../components/TimingBar';
import type { Timings } from '../types';

const t: Timings = { server_total_ms: 200, first_token_ms: 40, model_ms: 150, tool_ms: 20, session_ms: 20, overhead_ms: 10 };

describe('timingSegments', () => {
  it('computes proportional segments summing to 100%', () => {
    const { segments, total } = timingSegments(t);
    expect(total).toBe(200);
    expect(segments.map((s) => s.key)).toEqual(['model_ms', 'tool_ms', 'session_ms', 'overhead_ms']);
    expect(segments[0].pct).toBeCloseTo(75);
    expect(segments[3].pct).toBeCloseTo(5);
    expect(segments.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100);
  });
  it('ignores negative / missing values', () => {
    const { segments, total } = timingSegments({ ...t, tool_ms: -3, session_ms: Number.NaN });
    expect(total).toBe(160);
    expect(segments.find((s) => s.key === 'tool_ms')!.ms).toBe(0);
  });
});

describe('<TimingBar>', () => {
  it('renders segments with accessible breakdown and legend', () => {
    const { container } = render(<TimingBar timings={t} />);
    expect(screen.getByRole('img', { name: /model 150 ms.*overhead 10.0 ms/ })).toBeInTheDocument();
    const seg = container.querySelector('[data-segment="model_ms"]') as HTMLElement;
    expect(seg.style.width).toBe('75%');
    expect(screen.getByText('overhead')).toBeInTheDocument();
  });
  it('scales to a shared max so both panes are comparable', () => {
    const { container } = render(<TimingBar timings={t} scaleMs={400} showLegend={false} />);
    const inner = container.querySelector('[data-segment="model_ms"]')!.parentElement as HTMLElement;
    expect(inner.style.width).toBe('50%');
  });
  it('renders an empty state without timings', () => {
    render(<TimingBar timings={null} />);
    expect(screen.getByRole('img', { name: 'No timing data' })).toBeInTheDocument();
  });
});
