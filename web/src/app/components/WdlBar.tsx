/**
 * Win/draw/loss bar in the style of lila's explorer `resultBar()`
 * (ui/analyse/src/explorer/explorerView.ts): widths rounded to 0.1%. Every label is a percentage
 * with its `%` sign (lila drops the sign under 20%, which reads like a game count next to W/D/L
 * numbers); a label shows only where its segment has room for it (a container query in
 * components.css), so narrow table bars stay clean and wide ones label every share.
 */

/** One segment of the bar. */
export interface WdlSegment {
  key: 'w' | 'd' | 'l';
  count: number;
  /** CSS width in percent (one decimal). */
  width: number;
  /** Label text ('' when the segment is too narrow). */
  label: string;
}

/** The three segments for counts w/d/l (empty array when there are no games). */
export function wdlSegments(w: number, d: number, l: number): WdlSegment[] {
  const sum = w + d + l;
  if (sum <= 0) return [];
  return (
    [
      ['w', w],
      ['d', d],
      ['l', l],
    ] as const
  ).map(([key, count]) => {
    const percent = (count * 100) / sum;
    return {
      key,
      count,
      width: Math.round((count * 1000) / sum) / 10,
      label: Math.round(percent) >= 1 ? `${Math.round(percent)}%` : '',
    };
  });
}

/** Props of `WdlBar`. */
export interface WdlBarProps {
  w: number;
  d: number;
  l: number;
  /**
   * `player` (default): W/D/L from the profile player's side, coloured good/neutral/bad.
   * `color`: White wins / draws / Black wins in lila's explorer colours.
   */
  mode?: 'player' | 'color';
  className?: string;
}

const CLASSES = {
  player: { w: 'win', d: 'draw', l: 'loss' },
  color: { w: 'white', d: 'draws', l: 'black' },
} as const;

const NAMES = {
  player: { w: 'wins', d: 'draws', l: 'losses' },
  color: { w: 'White wins', d: 'draws', l: 'Black wins' },
} as const;

/** One game: `1 win`, `1 White win`, `1 draw`, `1 loss`. */
const NAMES_ONE = {
  player: { w: 'win', d: 'draw', l: 'loss' },
  color: { w: 'White win', d: 'draw', l: 'Black win' },
} as const;

/** The `winratePerspective` preference: the player's results, or White / Black results. */
export type WdlPerspective = 'player' | 'white';

/**
 * Bar props for a player's W/D/L under the viewer's `winratePerspective`. With `white`, a bar
 * whose games the player all played with one colour (`color` known: an opening line, a colour
 * row, a prep line, any bar under a colour filter) shows White wins / draws / Black wins in the
 * explorer's colours; a bar mixing both colours can't be split and keeps the player's results.
 */
export function perspectiveWdl(
  x: { w: number; d: number; l: number },
  color: 'white' | 'black' | null | undefined,
  perspective: WdlPerspective,
): Pick<WdlBarProps, 'w' | 'd' | 'l' | 'mode'> {
  if (perspective !== 'white' || !color) return { w: x.w, d: x.d, l: x.l, mode: 'player' };
  return color === 'white' ? { w: x.w, d: x.d, l: x.l, mode: 'color' } : { w: x.l, d: x.d, l: x.w, mode: 'color' };
}

/** A horizontal W/D/L bar. */
export function WdlBar({ w, d, l, mode = 'player', className }: WdlBarProps) {
  const segments = wdlSegments(w, d, l);
  const total = w + d + l;
  const title =
    total === 0
      ? 'No games'
      : segments.map(s => `${s.count} ${(s.count === 1 ? NAMES_ONE : NAMES)[mode][s.key]} (${((s.count * 100) / total).toFixed(1)}%)`).join(', ');
  return (
    <div className={['wdl-bar', total === 0 && 'wdl-bar--empty', className].filter(Boolean).join(' ')} title={title} role="img" aria-label={title}>
      {segments.map(s =>
        s.count === 0 ? null : (
          <span key={s.key} className={CLASSES[mode][s.key]} style={{ width: `${s.width}%` }}>
            {s.label && <span className="wdl-bar__label">{s.label}</span>}
          </span>
        ),
      )}
    </div>
  );
}
