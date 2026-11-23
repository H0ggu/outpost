/**
 * Win/draw/loss bar in the style of lila's explorer `resultBar()`
 * (ui/analyse/src/explorer/explorerView.ts): widths rounded to 0.1%. Every label is a percentage
 * with its `%` sign (lila drops the sign under 20%, which reads like a game count next to W/D/L
 * numbers); a label shows only where its segment has room for it (a container query in
 * components.css), so narrow table bars stay clean and wide ones label every share.
 *
 * The viewer's `winratePerspective` (`UserPrefs`, provided by the site layout through
 * `WdlPerspectiveContext`) picks the colours: `player` shows the player's wins / draws / losses
 * (green / grey / red); `white` shows White wins / draws / Black wins in lila's explorer colours,
 * which needs the player's colour in those games (`side`), so a bar over both colours keeps the
 * player's results.
 */
import { createContext, useContext } from 'react';
import type { Color, UserPrefs } from '@outpost/shared/api';

/** The viewer's W/D/L perspective (`UserPrefs.winratePerspective`); the player's by default. */
export const WdlPerspectiveContext = createContext<UserPrefs['winratePerspective']>('player');

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
   * Forces the colours: `player` = W/D/L from the profile player's side, coloured good/neutral/bad;
   * `color` = White wins / draws / Black wins in lila's explorer colours (`w` = White's wins).
   * Without it the viewer's `WdlPerspectiveContext` decides (with `side`).
   */
  mode?: 'player' | 'color';
  /**
   * The player's colour in every game of the bar (`w`/`l` are theirs), when it is one colour: with
   * the `white` perspective the bar then shows White / Black results.
   */
  side?: Color | null;
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

/** A horizontal W/D/L bar. */
export function WdlBar({ w: wins, d, l: losses, mode: forced, side, className }: WdlBarProps) {
  const perspective = useContext(WdlPerspectiveContext);
  const mode = forced ?? (perspective === 'white' && side ? 'color' : 'player');
  // As White / Black results: the player's wins are White's when they had White.
  const [w, l] = !forced && mode === 'color' && side === 'black' ? [losses, wins] : [wins, losses];
  const segments = wdlSegments(w, d, l);
  const total = w + d + l;
  const title =
    total === 0
      ? 'No games'
      : segments.map(s => `${s.count} ${NAMES[mode][s.key]} (${((s.count * 100) / total).toFixed(1)}%)`).join(', ');
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
