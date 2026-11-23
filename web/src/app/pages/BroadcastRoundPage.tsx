import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useParams } from 'react-router';
import { API_ROUTES, type BroadcastGamePreview } from '@outpost/shared/api';
import { ApiError } from '../api/client.ts';
import { Box, EmptyState, licon, Page, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { BroadcastError, formatTourDates, RoundStatusPill } from './components/library/broadcast.tsx';
import { MiniGame } from './components/library/MiniGame.tsx';
import { extractBroadcastGame } from './components/library/broadcastPgn.ts';
import { timeAgo } from './components/library/format.ts';
import { fetchBroadcastGamePgn, fetchRoundPgnGames, libraryKeys, POLL, useBroadcastRound, useBroadcastTour } from './library-hooks.ts';
import './components/library/library.css';
import './BroadcastsPage.css';

/** Leaves the SPA for the Studio (a separate page). Replaceable in tests. */
export const studioNavigation = { go: (href: string) => window.location.assign(href) };

/**
 * How long opening a board waits for the round PGN before it settles for the position link (ms).
 * Read at call time, so tests can shorten it.
 */
export const OPEN_PGN_TIMEOUT = { ms: 8000 };

/**
 * The Studio PGN of a live game: the board's own PGN from the server (cut from its cached round
 * PGN by URL tag), or, when no URL tag matched there (404), the round PGN matched by players
 * (cached per round for a poll interval, only that game parsed). Null when neither has it.
 */
async function broadcastStudioPgn(qc: QueryClient, roundId: string, game: BroadcastGamePreview): Promise<string | null> {
  try {
    const pgn = extractBroadcastGame(await fetchBroadcastGamePgn(qc, roundId, game.id), game);
    if (pgn) return pgn;
  } catch (e) {
    // Anything but "no such game" (no token, Lichess down…) would fail for the round PGN too.
    if (!(e instanceof ApiError && e.isNotFound)) throw e;
  }
  return extractBroadcastGame(await fetchRoundPgnGames(qc, roundId), game);
}

/**
 * Studio link for a live game: its PGN (`broadcastStudioPgn`), else — on an error, a missing game
 * or a slow download, which is then cancelled — the current position.
 */
export async function studioHrefForGame(qc: QueryClient, roundId: string, game: BroadcastGamePreview): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), OPEN_PGN_TIMEOUT.ms);
  });
  try {
    const pgn = await Promise.race([broadcastStudioPgn(qc, roundId, game), timeout]);
    if (pgn === 'timeout') void qc.cancelQueries({ queryKey: libraryKeys.broadcastRoundPgn(roundId) });
    else if (pgn) return paths.studio({ pgn });
  } catch {
    // fall back to the position
  } finally {
    clearTimeout(timer);
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
  const qc = useQueryClient();

  // Seconds since the snapshot: since we received it, plus how old the server's copy was (≤ cache).
  const receivedAt = round.dataUpdatedAt;
  const serverAge = data ? Math.min(POLL.broadcastMs, Math.max(0, receivedAt - data.fetchedAt)) / 1000 : 0;
  const elapsedSec = data ? Math.max(0, (now - receivedAt) / 1000) + serverAge : 0;

  // One board opens at a time; leaving the round (another round, another page) drops it.
  const openRef = useRef<{ cancelled: boolean } | null>(null);
  useEffect(
    () => () => {
      if (openRef.current) openRef.current.cancelled = true;
      openRef.current = null;
      setOpening(null);
      void qc.cancelQueries({ queryKey: libraryKeys.broadcastRoundPgn(roundId) });
    },
    [qc, roundId],
  );

  const onOpen = useCallback(
    (game: BroadcastGamePreview, e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab: the position link
      e.preventDefault();
      if (openRef.current) return; // already opening a board
      const run = { cancelled: false };
      openRef.current = run;
      setOpening(game.id);
      void studioHrefForGame(qc, roundId, game).then(href => {
        if (run.cancelled) return;
        openRef.current = null;
        setOpening(null);
        studioNavigation.go(href);
      });
    },
    [qc, roundId],
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
