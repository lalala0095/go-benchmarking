import { computeDelta, describeDelta, formatDeltaLabel, type BetterWhen, type DeltaResult } from '../lib/delta';
import { isNum } from '../lib/format';
import { cx } from './ui';

type Props = {
  betterWhen: BetterWhen;
  metric?: string;
  /** Show which side wins ("Go"/"Py") inside the badge (default true). */
  showWinner?: boolean;
  className?: string;
  /** Names for the two compared sides (default Go / Python). The first side is "go" in DeltaResult terms. */
  names?: [string, string];
} & (
  | { /** Go relative to Python in percent: (go − py)/py × 100 */ value: number | null | undefined; go?: never; py?: never }
  | { go: number | null | undefined; py: number | null | undefined; value?: never }
);

export function deltaFromProps(p: Props): DeltaResult {
  if ('value' in p && p.value !== undefined) {
    const v = p.value;
    if (!isNum(v)) return { pct: null, ratio: null, better: null, label: '—' };
    // Build the same DeltaResult as computeDelta(go=1+v/100, py=1).
    return computeDelta(1 + v / 100, 1, p.betterWhen);
  }
  return computeDelta(p.go, p.py, p.betterWhen);
}

/**
 * Go-vs-Python delta chip. Colour = which side is better (green when Go wins, red when Python wins),
 * text always names the winner so colour is never the only signal.
 */
export function DeltaBadge(props: Props) {
  const d = deltaFromProps(props);
  const { betterWhen, metric, showWinner = true, className, names = ['Go', 'Python'] } = props;
  const short: [string, string] = names[0] === 'Go' && names[1] === 'Python' ? ['Go', 'Py'] : names;
  const tone = d.better === 'go' ? 'better' : d.better === 'python' ? 'worse' : 'neutral';
  const label = d.pct !== null && d.ratio !== null ? formatDeltaLabel(d.pct, d.ratio) : d.label;
  return (
    <span
      className={cx(
        'num inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-semibold',
        tone === 'better' && 'border-better/50 bg-better/10 text-better',
        tone === 'worse' && 'border-worse/50 bg-worse/10 text-worse',
        tone === 'neutral' && 'border-border bg-surface2 text-muted',
        className,
      )}
      data-better={d.better ?? 'none'}
      title={describeDelta(d, betterWhen, metric, names)}
      aria-label={describeDelta(d, betterWhen, metric, names)}
    >
      {label}
      {showWinner && d.better && <span className="font-sans font-medium opacity-90">{d.better === 'go' ? short[0] : short[1]}</span>}
      {showWinner && !d.better && d.pct !== null && <span className="font-sans font-medium">tie</span>}
    </span>
  );
}
