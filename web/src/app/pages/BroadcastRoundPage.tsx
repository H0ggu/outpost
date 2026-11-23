import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { Link, useParams } from 'react-router';
import { API_ROUTES, type BroadcastGamePreview } from '@outpost/shared/api';
import { api } from '../api/client.ts';
import { Box, EmptyState, licon, Page, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { BroadcastError, formatTourDates, MiniGame, RoundStatusPill } from './components/library/broadcast.tsx';
import { extractBroadcastGame } from './components/library/broadcastPgn.ts';
import { timeAgo } from './components/library/format.ts';
import { POLL, useBroadcastRound, useBroadcastTour } from './library-hooks.ts';
import './components/library/library.css';
import './BroadcastsPage.css';

/** Leaves the SPA for the Studio (a separate page). Replaceable in tests. */
export const studioNavigation = { go: (href: string) => window.location.assign(href) };

/** Studio link for a live game: its PGN out of the round PGN, else the current position. */
export async function studioHrefForGame(roundId: string, game: BroadcastGamePreview): Promise<string> {
  try {
    const all = await api.text(API_ROUTES.broadcastRoundPgn(roundId));
    const pgn = extractBroadcastGame(all, game);
    if (pgn) return paths.studio({ pgn });
  } catch {
    // fall back to the position
  }
  return paths.studio({ fen: game.fen });
}

/** A clock that ticks every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * PLAN §9 `/broadcasts/:roundId`, §6 GET /api/broadcasts/round/:roundId (polled every 10 s while
 * the round isn't finished): a responsive grid of view-only mini-boards with players, ratings,
 * running clocks and results. A board opens that game in the Studio. Other rounds of the event
 * are one tap away, and the round's PGN can be downloaded.
 */
export default function BroadcastRoundPage() {
  const { roundId = '' } = useParams();
  const round = useBroadcastRound(roundId || undefined);
  const data = round.data;
  const tour = useBroadcastTour(data?.tour.id);
  const live = !!data?.round.ongoing;
  const now = useNow(live || !!data?.games.some(g => g.status === '*'));
  const [opening, setOpening] = useState<string | null>(null);

  // Seconds since the snapshot: since we received it, plus how old the server's copy was (≤ cache).
  const receivedAt = round.dataUpdatedAt;
  const serverAge = data ? Math.min(POLL.broadcastMs, Math.max(0, receivedAt - data.fetchedAt)) / 1000 : 0;
  const elapsedSec = data ? Math.max(0, (now - receivedAt) / 1000) + serverAge : 0;

  const onOpen = useCallback(
    (game: BroadcastGamePreview, e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab: the position link
      e.preventDefault();
      setOpening(game.id);
      void studioHrefForGame(roundId, game).then(href => studioNavigation.go(href)).finally(() => setOpening(null));
    },
    [roundId],
  );

  const title = data ? `${data.tour.name} · ${data.round.name}` : 'Broadcast';
  const rounds = tour.data?.rounds ?? [];
  const dates = tour.data ? formatTourDates(tour.data.tour.dates) : null;

  return (
    <Page title={title}>
      {data ? (
        <>
          <Box
            title={data.tour.name}
            actions={
              <>
                <a className="button button-secondary button-thin" href={API_ROUTES.broadcastRoundPgn(roundId)} download data-icon={licon.Download}>
                  PGN
                </a>
                {data.round.url && (
                  <a className="button button-empty button-thin" href={data.round.url} target="_blank" rel="noreferrer" data-icon={licon.ExternalArrow}>
                    Lichess
                  </a>
                )}
              </>
            }
          >
            <div className="lib-roundhead">
              <strong className="lib-roundhead__name">{data.round.name}</strong>
              <RoundStatusPill round={data.round} />
              {dates && <span className="muted">{dates}</span>}
              <span className="muted lib-roundhead__updated" aria-live="off">
                {round.isFetching ? 'updating…' : `updated ${timeAgo(receivedAt, now)}`}
                {!data.round.finished && ' · refreshes every 10 s'}
              </span>
            </div>
            {rounds.length > 1 && (
              <nav className="lib-rounds lib-rounds--compact" aria-label="Rounds">
                {rounds.map(r => (
                  <Link
                    key={r.id}
                    to={paths.broadcastRound(r.id)}
                    className={['lib-round', r.ongoing && 'lib-round--live', r.finished && 'lib-round--done', r.id === data.round.id && 'lib-round--current'].filter(Boolean).join(' ')}
                    aria-current={r.id === data.round.id ? 'page' : undefined}
                  >
                    {r.ongoing && <span className="lib-live-dot" aria-hidden />}
                    {r.name}
                  </Link>
                ))}
              </nav>
            )}
            {round.isError && <p className="form-error lib-roundhead__stale">Couldn't refresh: {round.error.message}. Showing the last boards.</p>}
          </Box>

          {data.games.length === 0 ? (
            <Box>
              <EmptyState icon={licon.RadioTower} title="No games yet">
                <p>Pairings appear here when the round starts.</p>
              </EmptyState>
            </Box>
          ) : (
            <section className="box lib-boards-box" aria-label="Games">
              <div className="now-playing lib-boards">
                {data.games.map(g => (
                  <MiniGame key={g.id} game={g} elapsedSec={elapsedSec} live={live} opening={opening === g.id} onOpen={onOpen} />
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <Box title="Broadcast">
          {round.isError ? <BroadcastError error={round.error} onRetry={() => void round.refetch()} /> : <Spinner center />}
          <p className="lib-back">
            <Link to={paths.broadcasts} data-icon={licon.Back}>
              All broadcasts
            </Link>
          </p>
        </Box>
      )}
    </Page>
  );
}
