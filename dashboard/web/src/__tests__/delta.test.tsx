import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { computeDelta, formatDeltaLabel } from '../lib/delta';
import { DeltaBadge } from '../components/DeltaBadge';

describe('computeDelta', () => {
  it('lower-is-better: Go lower wins', () => {
    const d = computeDelta(32, 100, 'lower');
    expect(d.pct).toBeCloseTo(-68);
    expect(d.better).toBe('go');
    expect(d.label).toBe('−68%');
  });
  it('higher-is-better: Go higher wins, ratio label ≥ 2×', () => {
    const d = computeDelta(41000, 10000, 'higher');
    expect(d.better).toBe('go');
    expect(d.label).toBe('4.1×');
  });
  it('Python wins when Go is higher on a lower-is-better metric', () => {
    expect(computeDelta(120, 100, 'lower').better).toBe('python');
    expect(computeDelta(120, 100, 'lower').label).toBe('+20%');
  });
  it('treats near-equal as a tie', () => {
    expect(computeDelta(100.2, 100, 'lower').better).toBeNull();
  });
  it('handles nulls and zero', () => {
    expect(computeDelta(null, 5, 'lower')).toMatchObject({ pct: null, better: null, label: '—' });
    expect(computeDelta(5, 0, 'lower').better).toBe('python');
    expect(computeDelta(0, 0, 'higher').better).toBeNull();
  });
  it('formats small deltas with a decimal', () => {
    expect(formatDeltaLabel(-0.3, 0.997)).toBe('−0.3%');
  });
});

describe('<DeltaBadge>', () => {
  it('marks Go as better and names the winner', () => {
    render(<DeltaBadge go={10} py={40} betterWhen="lower" metric="p99" />);
    const el = screen.getByLabelText(/p99: Go is/);
    expect(el).toHaveAttribute('data-better', 'go');
    expect(el).toHaveTextContent('−75%');
    expect(el).toHaveTextContent('Go');
    expect(el.className).toMatch(/text-better/);
  });
  it('marks Python as better on higher-is-better metric', () => {
    render(<DeltaBadge go={100} py={150} betterWhen="higher" metric="RPS" />);
    const el = screen.getByLabelText(/RPS:/);
    expect(el).toHaveAttribute('data-better', 'python');
    expect(el).toHaveTextContent('Py');
    expect(el.className).toMatch(/text-worse/);
  });
  it('accepts a precomputed percentage value', () => {
    render(<DeltaBadge value={312} betterWhen="higher" metric="RPS" />);
    expect(screen.getByLabelText(/RPS:/)).toHaveTextContent('4.1×');
  });
  it('renders neutral dash with no data', () => {
    render(<DeltaBadge go={null} py={3} betterWhen="lower" metric="mem" />);
    const el = screen.getByLabelText(/no comparison/);
    expect(el).toHaveAttribute('data-better', 'none');
    expect(el).toHaveTextContent('—');
  });
  it('supports custom side names (compare B vs A)', () => {
    render(<DeltaBadge go={50} py={100} betterWhen="lower" metric="p99" names={['B', 'A']} />);
    expect(screen.getByLabelText(/B is 50.0% lower than A/)).toHaveTextContent('B');
  });
});
