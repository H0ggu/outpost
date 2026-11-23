/**
 * Games table (Games tab): one row per game from the player's side; a row expands into a
 * pgn-viewer preview (loaded on demand) with Analyse / open-on-site links.
 */
import { Fragment, lazy, Suspense, useState, type KeyboardEvent } from 'react';
import type { GameRow, SourceSummary } from '@outpost/shared/api';
import { Spinner, TIME_CLASS_LABELS, TimeClassIcon } from '../../../components/index.ts';
import { fmtDate, fmtDateTime, fmtSigned, fmtTimeControl, TERMINATION_LABELS } from '../format.ts';
import { ColorDot, OpponentName, OutcomeMark, SiteIcon } from './bits.tsx';

const GamePreview = lazy(() => import('./GamePreview.tsx'));

/** Result cell text: `1-0`, `½-½`. */
const resultText = (r: GameRow['result']): string => (r === '1/2-1/2' ? '½-½' : r);

/** Props of `GameTable`. */
export interface GameTableProps {
  slug: string;
  games: readonly GameRow[];
  sources: readonly SourceSummary[];
  timeZone: string;
}

/** The expandable games table. */
export function GameTable({ slug, games, sources, timeZone }: GameTableProps) {
  const [open, setOpen] = useState<number | null>(null);
  const toggle = (id: number) => setOpen(o => (o === id ? null : id));
  const onKey = (id: number) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(id);
    }
  };
  const sourceOf = (id: number) => sources.find(s => s.id === id);

  return (
    <div className="table-wrap">
      <table className="slist games-table">
        <thead>
          <tr>
            <th className="gt-res">
              <span className="visually-hidden">Outcome</span>
            </th>
            <th className="gt-opp">Opponent</th>
            <th className="gt-result">Result</th>
            <th className="gt-tc">Time</th>
            <th className="gt-moves num">Moves</th>
            <th className="gt-opening">Opening</th>
            <th className="gt-date">Date</th>
            <th className="gt-src">
              <span className="visually-hidden">Account</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {games.map(g => {
            const expanded = open === g.id;
            const src = sourceOf(g.sourceId);
            const diff = g.rating !== null && g.ratingAfter !== null ? g.ratingAfter - g.rating : null;
            return (
              <Fragment key={g.id}>
                <tr
                  className={['clickable', 'game-row', `game-row--${g.outcome}`, expanded && 'expanded'].filter(Boolean).join(' ')}
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => toggle(g.id)}
                  onKeyDown={onKey(g.id)}
                >
                  <td className="gt-res">
                    <OutcomeMark outcome={g.outcome} />
                  </td>
                  <td className="gt-opp">
                    <ColorDot color={g.color} />
                    <OpponentName opponent={g.opponent} />
                  </td>
                  <td className="gt-result" title={TERMINATION_LABELS[g.termination]}>
                    <span className={`result-text result-text--${g.outcome}`}>{resultText(g.result)}</span>
                    {diff !== null && g.rated && (
                      <span className={['rating-diff', diff > 0 ? 'good' : diff < 0 ? 'bad' : 'muted'].join(' ')}>{fmtSigned(diff)}</span>
                    )}
                  </td>
                  <td className="gt-tc" title={`${TIME_CLASS_LABELS[g.timeClass]}${g.rated ? ' · rated' : ' · casual'}`}>
                    <TimeClassIcon tc={g.timeClass} />
                    <span className="gt-tc__text">{fmtTimeControl(g.timeControl)}</span>
                  </td>
                  <td className="gt-moves num">{Math.ceil(g.plies / 2)}</td>
                  <td className="gt-opening" title={g.openingName ?? undefined}>
                    {g.eco && <span className="eco">{g.eco}</span>} {g.openingName ?? <span className="muted">–</span>}
                  </td>
                  <td className="gt-date" title={fmtDateTime(g.endedAt, timeZone)}>
                    {fmtDate(g.endedAt, timeZone)}
                  </td>
                  <td className="gt-src">{src && <SiteIcon kind={src.kind} />}</td>
                </tr>
                {expanded && (
                  <tr className="game-preview-row">
                    <td colSpan={8}>
                      <Suspense fallback={<Spinner center size={28} label="Loading game" />}>
                        <GamePreview slug={slug} game={g} timeZone={timeZone} />
                      </Suspense>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
