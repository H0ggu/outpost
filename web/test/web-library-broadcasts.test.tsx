import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BroadcastGamePreview, BroadcastRound, BroadcastSummary } from '@outpost/shared/api';
import BroadcastRoundPage, { OPEN_PGN_TIMEOUT, studioNavigation } from '../src/app/pages/BroadcastRoundPage.tsx';
import BroadcastsPage, { defaultRound, shortDescription } from '../src/app/pages/BroadcastsPage.tsx';
import { roundStatus } from '../src/app/pages/components/library/broadcast.tsx';
import { inCheck, liveClock, playerTooltip, turnOf } from '../src/app/pages/components/library/MiniGame.tsx';
import { extractBroadcastGame, indexRoundPgn } from '../src/app/pages/components/library/broadcastPgn.ts';
import { formatClock } from '../src/app/pages/components/library/format.ts';
import { isNoTokenError, POLL, roundRefetchInterval } from '../src/app/pages/library-hooks.ts';
import { ApiError } from '../src/app/api/client.ts';
import { ADMIN, apiError, noTokenError, renderPage, session, text, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const tour = (over: Partial<BroadcastSummary> = {}): BroadcastSummary => ({
  tour: {
    id: 'tour0001',
    name: 'Synthetic Open 2026',
    slug: 'synthetic-open-2026',
    tier: 5,
    dates: [Date.UTC(2026, 10, 20), Date.UTC(2026, 10, 28)],
    url: 'https://lichess.org/broadcast/synthetic-open-2026/tour0001',
    description: 'A **made-up** event for [tests](https://example.org).',
    info: { format: '9-round Swiss', fideTC: 'Standard', location: 'Nowhere', players: 'Player A, Player B' },
  },
  rounds: [
    { id: 'rnd00001', name: 'Round 1', slug: 'round-1', startsAt: Date.UTC(2026, 10, 20), finished: true, ongoing: false, url: 'https://lichess.org/r1' },
    { id: 'rnd00002', name: 'Round 2', slug: 'round-2', startsAt: Date.UTC(2026, 10, 21), finished: false, ongoing: true, url: 'https://lichess.org/r2' },
    { id: 'rnd00003', name: 'Round 3', slug: 'round-3', startsAt: Date.UTC(2030, 0, 1), finished: false, ongoing: false, url: 'https://lichess.org/r3' },
  ],
  defaultRoundId: 'rnd00002',
  live: true,
  ...over,
});

const player = (name: string, over: Partial<BroadcastGamePreview['white']> = {}): BroadcastGamePreview['white'] => ({
  name,
  title: 'GM',
  rating: 2700,
  fideId: null,
  fed: 'NOR',
  clock: 3600,
  ...over,
});

const games: BroadcastGamePreview[] = [
  {
    id: 'chap0001',
    name: 'Alpha - Beta',
    white: player('Alpha', { clock: 5400 }),
    black: player('Beta', { clock: 4000, title: null, rating: 2650 }),
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    lastMove: 'g1f3',
    status: '*',
    thinkTime: 60,
  },
  {
    id: 'chap0002',
    name: 'Gamma - Delta',
    white: player('Gamma'),
    black: player('Delta'),
    fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    lastMove: 'd8h4',
    status: '0-1',
    thinkTime: null,
  },
];

const round = (over: Partial<BroadcastRound> = {}): BroadcastRound => ({
  tour: { id: 'tour0001', name: 'Synthetic Open 2026', slug: 'synthetic-open-2026' },
  round: tour().rounds[1]!,
  games,
  fetchedAt: Date.now(),
  ...over,
});

const ROUND_PGN = `[Event "Synthetic Open 2026"]
[White "Gamma"]
[Black "Delta"]
[Result "0-1"]
[GameURL "https://lichess.org/broadcast/synthetic-open-2026/round-2/rnd00002/chap0002"]

1. f3 { [%clk 1:30:00] } e5 { [%clk 1:30:00] } 2. g4 { [%clk 1:29:50] } Qh4# 0-1

[Event "Synthetic Open 2026"]
[White "Alpha"]
[Black "Beta"]
[WhiteElo "2700"]
[Result "*"]
[GameURL "https://lichess.org/broadcast/synthetic-open-2026/round-2/rnd00002/chap0001"]

1. e4 { [%clk 1:30:00] } e5 { [%eval 0.2] } 2. Nf3 (2. Bc4 Nf6) *
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BroadcastsPage', () => {
  it('lists ongoing and recent tournaments with their rounds', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/broadcasts', { active: [tour()], recent: [tour({ tour: { ...tour().tour, id: 'tour0002', name: 'Old Masters', tier: 3 }, live: false, defaultRoundId: null })] });
    renderPage(<BroadcastsPage />, { route: '/broadcasts' });
    const card = (await screen.findByText('Synthetic Open 2026')).closest('li')!;
    expect(within(card).getByText('Synthetic Open 2026').getAttribute('href')).toBe('/broadcasts/rnd00002');
    expect(within(card).getByText('Top tier')).toBeTruthy();
    expect(within(card).getAllByText('Live').length).toBeGreaterThan(0);
    expect(within(card).getByText(/Nowhere · Standard · 9-round Swiss/)).toBeTruthy();
    expect(within(card).getByText('A made-up event for tests.')).toBeTruthy();
    const rounds = within(card).getByRole('navigation', { name: 'Synthetic Open 2026 rounds' });
    expect(within(rounds).getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(['/broadcasts/rnd00001', '/broadcasts/rnd00002', '/broadcasts/rnd00003']);
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('Old Masters')).toBeTruthy();
  });

  it('explains a missing Lichess token, with the settings link for admins', async () => {
    api()
      .on('GET', '/api/session', session(ADMIN))
      .on('GET', '/api/broadcasts', noTokenError('No Lichess token is configured'));
    renderPage(<BroadcastsPage />, { route: '/broadcasts' });
    expect(await screen.findByText("Live broadcasts aren't available on this server")).toBeTruthy();
    expect(screen.getByText('No Lichess token is configured')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Admin → Settings' })).getAttribute('href')).toBe('/admin/settings');
    // a missing token is not retried
    expect(api().find('GET', '/api/broadcasts')).toHaveLength(1);
  });

  it('tells a transient Lichess outage apart from a missing token', async () => {
    const retryAt = Date.now() + 60_000;
    api()
      .on('GET', '/api/session', session(ADMIN))
      .on('GET', '/api/broadcasts', apiError(503, 'upstream_unavailable', 'lichess.org is rate-limiting us', { host: 'lichess.org', reason: 'rate_limited', retryAt }));
    renderPage(<BroadcastsPage />, { route: '/broadcasts' });
    expect(await screen.findByText("Lichess can't be reached right now", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/Try again after/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Admin → Settings' })).toBeNull();
    api().on('GET', '/api/broadcasts', { active: [], recent: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No official broadcasts right now')).toBeTruthy();
  });

  it('tells other users to ask the admin', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/broadcasts', noTokenError('No token'));
    renderPage(<BroadcastsPage />, { route: '/broadcasts' });
    expect(await screen.findByText(/Ask the admin of this Outpost to add one/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Admin → Settings' })).toBeNull();
  });

  it('lists upcoming tournaments between the ongoing and the recent ones', async () => {
    const next = tour({ tour: { ...tour().tour, id: 'tour0003', name: 'Future Cup', tier: null }, live: false, rounds: [{ ...tour().rounds[0]!, id: 'rnd00009', name: 'Round 1', ongoing: false, finished: false }], defaultRoundId: null });
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/broadcasts', { active: [], upcoming: [next], recent: [tour({ tour: { ...tour().tour, id: 'tour0002', name: 'Old Masters' }, live: false })] });
    renderPage(<BroadcastsPage />, { route: '/broadcasts' });
    expect(await screen.findByText('Future Cup')).toBeTruthy();
    const titles = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    expect(titles.filter(t => /Upcoming|Recent|Ongoing/.test(t ?? ''))).toEqual(['Upcoming 1', 'Recent 1']);
    expect(screen.getByText('Future Cup').getAttribute('href')).toBe('/broadcasts/rnd00009');
  });

  it('shows the empty state', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/broadcasts', { active: [], recent: [] });
    renderPage(<BroadcastsPage />, { route: '/broadcasts' });
    expect(await screen.findByText('No official broadcasts right now')).toBeTruthy();
  });
});

describe('BroadcastRoundPage', () => {
  const ROUTE = { route: '/broadcasts/:roundId', path: '/broadcasts/rnd00002' };

  function base(r: () => BroadcastRound = () => round()) {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/broadcasts/round/rnd00002', () => r())
      .on('GET', '/api/broadcasts/tour/tour0001', tour());
  }

  it('shows the live boards with players, clocks and results', async () => {
    base();
    renderPage(<BroadcastRoundPage />, ROUTE);
    const alpha = (await screen.findByRole('link', { name: /Alpha – Beta: open in the Studio/ })) as HTMLAnchorElement;
    // Black on top, White below; ratings, federations, titles.
    const lines = alpha.querySelectorAll('.mini-game__player');
    expect(lines[0]!.textContent).toContain('Beta');
    expect(lines[1]!.textContent).toContain('Alpha');
    expect(within(alpha).getAllByText('NOR')).toHaveLength(2);
    // Black to move: their clock runs (4000 − 60 s thinking, minus a little elapsed time), White's is still.
    const blackClock = lines[0]!.querySelector('.mini-game__clock')!;
    expect(blackClock.className).toContain('clock--run');
    expect(blackClock.textContent).toMatch(/^1:05:(39|40)$/);
    expect(lines[1]!.querySelector('.mini-game__clock')!.textContent).toBe('1:30:00');
    // A finished game shows the score instead of clocks.
    const gamma = screen.getByRole('link', { name: /Gamma – Delta, 0-1/ });
    expect([...gamma.querySelectorAll('.mini-game__result')].map(e => e.textContent)).toEqual(['1', '0']);
    // A board is mounted for every game.
    expect(document.querySelectorAll('.lib-mini cg-board').length).toBe(2);
    // Round navigation and the PGN download.
    expect(screen.getByRole('link', { name: 'Round 2' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'PGN' }).getAttribute('href')).toBe('/api/broadcasts/round/rnd00002.pgn');
  });

  it('opens a game in the Studio with its PGN (main line, no clock comments)', async () => {
    base();
    api().on('GET', '/api/broadcasts/round/rnd00002.pgn', text(ROUND_PGN));
    const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
    renderPage(<BroadcastRoundPage />, ROUTE);
    fireEvent.click(await screen.findByRole('link', { name: /Alpha – Beta/ }));
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    const url = new URL(go.mock.calls[0]![0], 'http://x');
    expect(url.pathname).toBe('/studio');
    const pgn = url.searchParams.get('pgn')!;
    expect(pgn).toContain('[White "Alpha"]');
    expect(pgn).toContain('1. e4 e5 2. Nf3 *');
    expect(pgn).not.toContain('%clk');
    expect(pgn).not.toContain('Bc4');
  });

  it('opens a board from its own PGN without downloading the round (decision 17)', async () => {
    base();
    const GAME_PGN = ROUND_PGN.slice(ROUND_PGN.indexOf('[Event', 10));
    api().on('GET', '/api/broadcasts/round/rnd00002/game/chap0001.pgn', text(GAME_PGN));
    const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
    renderPage(<BroadcastRoundPage />, ROUTE);
    fireEvent.click(await screen.findByRole('link', { name: /Alpha – Beta/ }));
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    const pgn = new URL(go.mock.calls[0]![0], 'http://x').searchParams.get('pgn')!;
    expect(pgn).toContain('[White "Alpha"]');
    expect(pgn).toContain('1. e4 e5 2. Nf3 *');
    expect(pgn).not.toContain('%clk');
    expect(api().find('GET', '/api/broadcasts/round/rnd00002.pgn')).toHaveLength(0);
  });

  it('does not try the round PGN when the board PGN fails for another reason than a missing game', async () => {
    base();
    api()
      .on('GET', '/api/broadcasts/round/rnd00002/game/chap0002.pgn', apiError(503, 'upstream_unavailable'))
      .on('GET', '/api/broadcasts/round/rnd00002.pgn', text(ROUND_PGN));
    const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
    renderPage(<BroadcastRoundPage />, ROUTE);
    fireEvent.click(await screen.findByRole('link', { name: /Gamma – Delta/ }));
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    expect(new URL(go.mock.calls[0]![0], 'http://x').searchParams.get('fen')).toBe(games[1]!.fen);
    expect(api().find('GET', '/api/broadcasts/round/rnd00002.pgn')).toHaveLength(0);
  });

  it('downloads the round PGN once: a second click waits, a later board reuses it', async () => {
    base();
    let release: () => void = () => undefined;
    api().on('GET', '/api/broadcasts/round/rnd00002.pgn', () => new Promise(resolve => (release = () => resolve(text(ROUND_PGN)))));
    const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
    renderPage(<BroadcastRoundPage />, ROUTE);
    const alpha = await screen.findByRole('link', { name: /Alpha – Beta/ });
    fireEvent.click(alpha);
    expect(await within(alpha).findByText('Opening…')).toBeTruthy();
    // Clicks while a board is opening are ignored (no second download, no second navigation).
    fireEvent.click(alpha);
    fireEvent.click(screen.getByRole('link', { name: /Gamma – Delta/ }));
    await waitFor(() => expect(api().find('GET', '/api/broadcasts/round/rnd00002.pgn')).toHaveLength(1));
    release();
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    expect(new URL(go.mock.calls[0]![0], 'http://x').searchParams.get('pgn')).toContain('[White "Alpha"]');
    expect(within(alpha).queryByText('Opening…')).toBeNull();
    // Opening another board soon after uses the copy already downloaded.
    fireEvent.click(screen.getByRole('link', { name: /Gamma – Delta/ }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(2));
    expect(new URL(go.mock.calls[1]![0], 'http://x').searchParams.get('pgn')).toContain('Qh4# 0-1');
    expect(api().find('GET', '/api/broadcasts/round/rnd00002.pgn')).toHaveLength(1);
  });

  it('settles for the position when the PGN is slow, and cancels the download', async () => {
    const saved = OPEN_PGN_TIMEOUT.ms;
    OPEN_PGN_TIMEOUT.ms = 40;
    try {
      base();
      let aborted = false;
      api().on(
        'GET',
        '/api/broadcasts/round/rnd00002.pgn',
        () => new Promise((_resolve, reject) => {
          const signal = api().fetch.mock.calls.at(-1)![1]!.signal!;
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      );
      const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
      renderPage(<BroadcastRoundPage />, ROUTE);
      fireEvent.click(await screen.findByRole('link', { name: /Alpha – Beta/ }));
      await waitFor(() => expect(go).toHaveBeenCalledOnce());
      expect(new URL(go.mock.calls[0]![0], 'http://x').searchParams.get('fen')).toBe(games[0]!.fen);
      await waitFor(() => expect(aborted).toBe(true));
    } finally {
      OPEN_PGN_TIMEOUT.ms = saved;
    }
  });

  it('does not leave for the Studio once the round page is gone', async () => {
    base();
    let release: () => void = () => undefined;
    api().on('GET', '/api/broadcasts/round/rnd00002.pgn', () => new Promise(resolve => (release = () => resolve(text(ROUND_PGN)))));
    const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
    const { unmount } = renderPage(<BroadcastRoundPage />, ROUTE);
    fireEvent.click(await screen.findByRole('link', { name: /Alpha – Beta/ }));
    await waitFor(() => expect(api().find('GET', '/api/broadcasts/round/rnd00002.pgn')).toHaveLength(1));
    unmount();
    release();
    await new Promise(r => setTimeout(r, 30));
    expect(go).not.toHaveBeenCalled();
  });

  it('falls back to the position when the PGN is unavailable', async () => {
    base();
    api().on('GET', '/api/broadcasts/round/rnd00002.pgn', apiError(503, 'upstream_unavailable'));
    const go = vi.spyOn(studioNavigation, 'go').mockImplementation(() => undefined);
    renderPage(<BroadcastRoundPage />, ROUTE);
    fireEvent.click(await screen.findByRole('link', { name: /Gamma – Delta/ }));
    await waitFor(() => expect(go).toHaveBeenCalledOnce());
    expect(new URL(go.mock.calls[0]![0], 'http://x').searchParams.get('fen')).toBe(games[1]!.fen);
  });

  it('polls every 10 s until the round is finished', async () => {
    const saved = POLL.broadcastMs;
    POLL.broadcastMs = 40;
    try {
      let n = 0;
      base(() => {
        n++;
        return n < 3 ? round() : round({ round: { ...round().round, ongoing: false, finished: true } });
      });
      renderPage(<BroadcastRoundPage />, ROUTE);
      expect(await screen.findByText('Finished', undefined, { timeout: 2000 })).toBeTruthy();
      const calls = api().find('GET', '/api/broadcasts/round/rnd00002').length;
      await new Promise(r => setTimeout(r, 200));
      expect(api().find('GET', '/api/broadcasts/round/rnd00002').length).toBe(calls);
      expect(calls).toBe(3);
    } finally {
      POLL.broadcastMs = saved;
    }
  });

  it('explains the missing token here too', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/broadcasts/round/rnd00002', noTokenError('Lichess token missing'));
    renderPage(<BroadcastRoundPage />, ROUTE);
    expect(await screen.findByText('Lichess token missing')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All broadcasts' }).getAttribute('href')).toBe('/broadcasts');
  });

  it('shows a round without pairings yet', async () => {
    base(() => round({ games: [], round: tour().rounds[2]! }));
    renderPage(<BroadcastRoundPage />, ROUTE);
    expect(await screen.findByText('No games yet')).toBeTruthy();
    expect(screen.getByText(/^Starts /)).toBeTruthy();
  });
});

describe('broadcast helpers', () => {
  it('extracts one game by chapter id, else by names', () => {
    expect(extractBroadcastGame(ROUND_PGN, { id: 'chap0002', white: player('x'), black: player('y') })).toContain('1. f3 e5 2. g4 Qh4# 0-1');
    expect(extractBroadcastGame(ROUND_PGN, { id: 'nope', white: player('alpha '), black: player('BETA') })).toContain('[White "Alpha"]');
    expect(extractBroadcastGame(ROUND_PGN, { id: 'nope', white: player('Q'), black: player('R') })).toBeNull();
  });

  it('indexes a round PGN by its tag lines without parsing moves', () => {
    const entries = indexRoundPgn(`\uFEFF${ROUND_PGN.replaceAll('\n', '\r\n')}`);
    expect(entries.map(e => e.headers.get('White'))).toEqual(['Gamma', 'Alpha']);
    expect(entries[1]!.headers.get('WhiteElo')).toBe('2700');
    expect(entries[0]!.text).toContain('Qh4# 0-1');
    expect(entries[0]!.text).not.toContain('Alpha');
    // Escaped quotes in tag values; comment lines that start with "[%" are moves, not tags.
    const odd = indexRoundPgn('[Event "The \\"Big\\" Open"]\n[White "A"]\n\n1. e4\n[%clk 1:00:00]\ne5 *\n\n[White "B"]\n\n1. d4 *\n');
    expect(odd).toHaveLength(2);
    expect(odd[0]!.headers.get('Event')).toBe('The "Big" Open');
    expect(odd[0]!.text).toContain('[%clk 1:00:00]');
    expect(odd[1]!.headers.get('White')).toBe('B');
    expect(indexRoundPgn('')).toEqual([]);
    // Extracting from the index parses the matched game only.
    expect(extractBroadcastGame(entries, { id: 'chap0001', white: player('x'), black: player('y') })).toContain('1. e4 e5 2. Nf3 *');
  });

  it('puts the whole player line in a tooltip', () => {
    expect(playerTooltip(player('Alpha'))).toBe('GM Alpha (NOR), 2700');
    expect(playerTooltip(player('', { title: null, fed: null, rating: null }))).toBe('?');
  });

  it('runs the clock of the side to move only', () => {
    expect(liveClock(player('a', { clock: 100 }), true, 10, 5)).toBe(85);
    expect(liveClock(player('a', { clock: 100 }), false, 10, 5)).toBe(100);
    expect(liveClock(player('a', { clock: 3 }), true, null, 10)).toBe(0);
    expect(liveClock(player('a', { clock: null }), true, 1, 1)).toBeNull();
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(65)).toBe('1:05');
  });

  it('reads turn and check from a FEN', () => {
    expect(turnOf(games[0]!.fen)).toBe('black');
    expect(inCheck(games[1]!.fen)).toBe(true);
    expect(inCheck(games[0]!.fen)).toBe(false);
    expect(inCheck('not a fen')).toBe(false);
  });

  it('names round states and picks the default round', () => {
    const t = tour();
    expect(roundStatus(t.rounds[0]!).kind).toBe('finished');
    expect(roundStatus(t.rounds[1]!).label).toBe('Live');
    expect(roundStatus(t.rounds[2]!).kind).toBe('upcoming');
    expect(defaultRound(t)?.id).toBe('rnd00002');
    expect(defaultRound({ ...t, defaultRoundId: null, rounds: [t.rounds[0]!, t.rounds[2]!] })?.id).toBe('rnd00001');
    expect(shortDescription('x'.repeat(300))!.length).toBe(220);
  });

  it('stops polling on finished rounds and permanent errors', () => {
    const r = round();
    expect(roundRefetchInterval(r, null)).toBe(POLL.broadcastMs);
    expect(roundRefetchInterval({ ...r, round: { ...r.round, finished: true } }, null)).toBe(false);
    expect(roundRefetchInterval(undefined, new ApiError(503, 'upstream_unavailable', 'x', { reason: 'no_token' }))).toBe(false);
    // Lichess briefly unreachable or rate-limited: keep polling
    expect(roundRefetchInterval(r, new ApiError(503, 'upstream_unavailable', 'x', { reason: 'timeout' }))).toBe(POLL.broadcastMs);
    expect(roundRefetchInterval(r, new ApiError(429, 'rate_limited', 'x'))).toBe(POLL.broadcastMs);
    expect(isNoTokenError(new ApiError(503, 'upstream_unavailable', 'x'))).toBe(false);
    expect(isNoTokenError(new ApiError(503, 'upstream_unavailable', 'x', { reason: 'no_token' }))).toBe(true);
    expect(roundRefetchInterval(undefined, new ApiError(404, 'not_found', 'x'))).toBe(false);
    expect(roundRefetchInterval(r, new ApiError(502, 'upstream_error', 'x'))).toBe(POLL.broadcastMs);
    expect(roundRefetchInterval(r, new ApiError(0, 'network', 'x'))).toBe(POLL.broadcastMs);
  });
});
