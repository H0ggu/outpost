/**
 * Inline game preview (Games tab): the kit's pgn-viewer replay (oriented to the player, at the
 * final position) plus the game's details and links. Loaded lazily with pgn-viewer.
 */
import { Link } from 'react-router';
import type { GameRow } from '@outpost/shared/api';
import { ErrorBox, licon, Spinner, TIME_CLASS_LABELS } from '../../../components/index.ts';
import { PgnViewer } from '../../../components/PgnViewer.tsx';
import { paths } from '../../../paths.ts';
import { fmtDateTime, fmtTimeControl, OUTCOME_LABELS, TERMINATION_LABELS } from '../format.ts';
import { useGame } from '../hooks.ts';
import { studioGameLink } from '../links.ts';

export default function GamePreview({ slug, game, timeZone }: { slug: string; game: GameRow; timeZone: string }) {
  const q = useGame(slug, game.id);
  const site = game.origin === 'lichess' ? 'Lichess' : game.origin === 'chesscom' ? 'Chess.com' : null;

  return (
    <div className="game-preview">
      <div className="game-preview__viewer">
        {q.isPending ? (
          <Spinner center size={28} label="Loading game" />
        ) : q.isError ? (
          <ErrorBox error={q.error} onRetry={() => void q.refetch()} title="Could not load the game" />
        ) : (
          <PgnViewer
            key={game.id}
            pgn={q.data.pgn}
            options={{ orientation: game.color, initialPly: 'last', showMoves: 'auto', showClocks: true }}
          />
        )}
      </div>
      <div className="game-preview__side">
        <dl className="game-facts">
          <dt>Result</dt>
          <dd>
            {OUTCOME_LABELS[game.outcome]} · {TERMINATION_LABELS[game.termination]}
          </dd>
          <dt>Time control</dt>
          <dd>
            {TIME_CLASS_LABELS[game.timeClass]} {fmtTimeControl(game.timeControl)} · {game.rated ? 'rated' : 'casual'}
          </dd>
          {game.openingName && (
            <>
              <dt>Opening</dt>
              <dd>
                {game.eco && <span className="eco">{game.eco}</span>} {game.openingName}
              </dd>
            </>
          )}
          {game.event && (
            <>
              <dt>Event</dt>
              <dd>{game.event}</dd>
            </>
          )}
          <dt>Played</dt>
          <dd>{fmtDateTime(game.endedAt ?? game.startedAt, timeZone)}</dd>
          {game.accuracy !== null && (
            <>
              <dt>Accuracy</dt>
              <dd>{game.accuracy.toFixed(1)}%</dd>
            </>
          )}
        </dl>
        <div className="game-preview__actions">
          <a className="button button-thin" href={studioGameLink(game.id, game.color)} data-icon={licon.Microscope}>
            Analyse
          </a>
          {game.url && site && (
            <a className="button button-secondary button-thin" href={game.url} target="_blank" rel="noopener noreferrer" data-icon={licon.ExternalArrow}>
              {site}
            </a>
          )}
          <Link className="button button-empty button-thin" to={paths.profile(slug, 'games', { oppName: game.opponent.name })} data-icon={licon.Search}>
            All vs {game.opponent.name}
          </Link>
        </div>
      </div>
    </div>
  );
}
