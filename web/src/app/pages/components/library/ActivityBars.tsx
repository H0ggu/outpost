/**
 * Small React-rendered SVG bar charts of when a player plays (prep report cards): games per hour
 * of the day and per weekday, with the score as the tooltip. Scales with its container and prints.
 */
import type { ActivityCell } from '@outpost/shared/api';
import { percent } from './format.ts';

/** Monday-first weekday names (ActivityStats indexing: Monday = 0). */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** Index of the busiest bucket, or -1 when there are no games. */
export function peakIndex(cells: readonly ActivityCell[]): number {
  let best = -1;
  let max = 0;
  cells.forEach((c, i) => {
    if (c.games > max) {
      max = c.games;
      best = i;
    }
  });
  return best;
}

/**
 * The busiest window of `width` consecutive hours (wrapping past midnight), e.g. "18:00–22:00",
 * or null when there are no games.
 */
export function busiestHours(byHour: readonly ActivityCell[], width = 4): string | null {
  if (byHour.length !== 24 || byHour.every(c => c.games === 0)) return null;
  let bestStart = 0;
  let best = -1;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let k = 0; k < width; k++) sum += byHour[(start + k) % 24]!.games;
    if (sum > best) {
      best = sum;
      bestStart = start;
    }
  }
  const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return `${pad(bestStart)}–${pad(bestStart + width)}`;
}

/** Vertical bars, one per cell; `labels[i]` under bar i when set. */
export function ActivityBars({
  cells,
  labels,
  names,
  title,
  className,
}: {
  cells: readonly ActivityCell[];
  /** Axis labels (sparse: empty strings are skipped). */
  labels: readonly string[];
  /** Full bucket names for tooltips. */
  names: readonly string[];
  title: string;
  className?: string;
}) {
  const max = Math.max(1, ...cells.map(c => c.games));
  const n = cells.length;
  const W = 100;
  const H = 40;
  const gap = n > 12 ? 0.6 : 2;
  const bw = (W - gap * (n - 1)) / n;
  const peak = peakIndex(cells);
  const total = cells.reduce((s, c) => s + c.games, 0);
  return (
    <figure className={['lib-bars', className].filter(Boolean).join(' ')}>
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 7}`} preserveAspectRatio="none" role="img" aria-label={`${title}: ${total} games`}>
        <line x1={0} x2={W} y1={H + 0.25} y2={H + 0.25} className="lib-bars__axis" />
        {cells.map((c, i) => {
          const h = c.games === 0 ? 0 : Math.max(1, (c.games / max) * H);
          const x = i * (bw + gap);
          return (
            <g key={i}>
              <title>{`${names[i] ?? i}: ${c.games} games${c.games ? `, score ${percent(c.score)}` : ''}`}</title>
              <rect x={x} y={0} width={bw} height={H} className="lib-bars__hit" />
              <rect x={x} y={H - h} width={bw} height={h} className={i === peak ? 'lib-bars__bar lib-bars__bar--peak' : 'lib-bars__bar'} />
            </g>
          );
        })}
      </svg>
      <div className="lib-bars__labels" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }} aria-hidden>
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </figure>
  );
}
