/**
 * Component tests of the Overview, Games, Explorer, Openings and Opponents tabs over the fake
 * API (web-profile-fixtures.ts): what they request, what they render, and where they link.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFiltersSegment } from '@outpost/shared/filters';
import { ALL_GAMES, filterGames, gamesPage, overview } from './web-profile-fixtures.ts';
import { renderProfile, searchOf } from './web-profile-render.tsx';

// pgn-viewer's dist uses extensionless ESM imports that Node can't load outside Vite; stand in
// for the kit's wrapper and record the options it gets.
vi.mock('../src/app/components/PgnViewer.tsx', () => ({
  PgnViewer: ({ pgn, options }: { pgn: string; options?: Record<string, unknown> }) => (
    <div data-testid="pgn-viewer" data-pgn={pgn} data-orientation={String(options?.orientation)} data-initial-ply={String(options?.initialPly)} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SLUG = '/u/test-player';
const api = (rest: string) => `/api/profiles/test-player/${rest}`;
const lastQuery = (calls: Array<{ url: URL }>): URLSearchParams => calls.at(-1)!.url.searchParams;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

describe('Overview tab', () => {
  it('renders every card from one unfiltered request', async () => {
    const { requests } = renderProfile(SLUG);
    expect(await screen.findByRole('heading', { name: 'Time controls' })).toBeTruthy();
    expect(requests(api('overview')).length).toBe(1);
    expect(requests(api('overview'))[0]!.url.search).toBe('');
    for (const title of ['Rating · last year', 'By colour', 'Last 90 days', 'Openings as White', 'Openings as Black', 'How games end', 'Latest games'])
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    // Played time classes only.
    const tcTable = screen.getByRole('heading', { name: 'Time controls' }).closest('section')!;
    expect(within(tcTable).getAllByRole('row').length).toBe(1 + 4);
    expect(within(tcTable).getByText('Blitz')).toBeTruthy();
    // Charts are SVG with an accessible name.
    expect(screen.getByRole('img', { name: 'Rating over the last year' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Games per day over the last 90 days' })).toBeTruthy();
    // Latest games open in the Studio.
    const latest = screen.getByRole('heading', { name: 'Latest games' }).closest('section')!;
    const links = within(latest).getAllByRole('link').filter(a => a.getAttribute('href')?.startsWith('/studio'));
    expect(links.length).toBe(5);
    expect(links[0]!.getAttribute('href')).toBe(`/studio?game=op${ALL_GAMES[0]!.id}`);
  });

  it('opens the games of a time class and of a colour', async () => {
    const { location } = renderProfile(SLUG);
    const tcTable = (await screen.findByRole('heading', { name: 'Time controls' })).closest('section')!;
    fireEvent.click(within(tcTable).getByText('Rapid'));
    await waitFor(() => expect(location().pathname).toBe('/u/test-player/games'));
    expect(searchOf(location()).get('tc')).toBe('rapid');
  });

  it('opens the explorer at an opening line as that colour', async () => {
    const { location } = renderProfile(SLUG);
    const black = (await screen.findByRole('heading', { name: 'Openings as Black' })).closest('section')!;
    fireEvent.click(within(black).getAllByRole('button')[0]!);
    await waitFor(() => expect(location().pathname).toBe('/u/test-player/explorer'));
    expect(searchOf(location()).get('color')).toBe('black');
    expect(searchOf(location()).get('line')).toMatch(/^[a-h][1-8][a-h][1-8](,[a-h][1-8][a-h][1-8])*$/);
  });

  it('shows an empty state for a profile without games', async () => {
    // No fixture game falls in 1990.
    renderProfile(SLUG, { patch: { overview: () => overview({ from: '1990-01-01', to: '1990-01-02' }) } });
    expect(await screen.findByText('No games yet')).toBeTruthy();
    expect(screen.getByText('Press Update to import this player’s games.')).toBeTruthy();
  });

  it('says the first import is running when it is', async () => {
    renderProfile(SLUG, {
      header: { queue: { busy: true, cooldownUntil: null, queuePosition: 1 } },
      patch: { overview: () => overview({ from: '1990-01-01', to: '1990-01-02' }) },
    });
    expect(await screen.findByText('The first import is running: games appear here as they arrive.')).toBeTruthy();
  });

  it('shows an error with retry', async () => {
    const { requests } = renderProfile(SLUG, { fail: [{ match: /overview$/, status: 500, code: 'internal', message: 'Stats are down' }] });
    expect(await screen.findByText('Stats are down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(requests(api('overview')).length).toBe(2));
  });
});

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

describe('Games tab', () => {
  it('shows the W/D/L summary, a page of games and the PGN export of the filtered games', async () => {
    const { requests } = renderProfile(`${SLUG}/games?tc=blitz`);
    const expected = gamesPage({ tc: ['blitz'] });
    expect(await screen.findByText(new Intl.NumberFormat('en-US').format(expected.total))).toBeTruthy();
    const q = lastQuery(requests(api('games')));
    expect(q.get('tc')).toBe('blitz');
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('20');
    const tiles = document.querySelector<HTMLElement>('.games-summary__tiles')!;
    expect(within(tiles).getByText('Wins').previousElementSibling?.textContent).toBe(String(expected.summary.w));
    expect(within(tiles).getByText('Losses').previousElementSibling?.textContent).toBe(String(expected.summary.l));
    const rows = document.querySelectorAll('tr.game-row');
    expect(rows.length).toBe(20);
    const pgn = screen.getByRole('link', { name: 'Download PGN' });
    expect(pgn.getAttribute('href')).toBe('/api/profiles/test-player/games.pgn?tc=blitz');
    expect(screen.getByText('The filtered games')).toBeTruthy();
  });

  it('pages through the games', async () => {
    const { requests, location } = renderProfile(`${SLUG}/games`);
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(searchOf(location()).get('page')).toBe('2'));
    await waitFor(() => expect(lastQuery(requests(api('games'))).get('page')).toBe('2'));
    expect(await screen.findByText(`21–40 of ${new Intl.NumberFormat('en-US').format(ALL_GAMES.length)}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    await waitFor(() => expect(searchOf(location()).has('page')).toBe(false));
  });

  it('expands a row into a preview with Analyse and site links', async () => {
    const { requests } = renderProfile(`${SLUG}/games`);
    await screen.findByRole('button', { name: 'Next page' });
    const first = document.querySelector<HTMLTableRowElement>('tr.game-row')!;
    expect(first.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    const game = ALL_GAMES[0]!;
    const analyse = await screen.findByRole('link', { name: 'Analyse' });
    expect(analyse.getAttribute('href')).toBe(`/studio?game=op${game.id}`);
    await waitFor(() => expect(requests(`/api/games/${game.id}`).length).toBe(1));
    // The replay is oriented to the player and starts at the final position.
    const viewer = await screen.findByTestId('pgn-viewer');
    expect(viewer.dataset.orientation).toBe(game.color);
    expect(viewer.dataset.initialPly).toBe('last');
    expect(viewer.dataset.pgn).toContain(`[Result "${game.result}"]`);
    expect(screen.getByRole('link', { name: game.origin === 'lichess' ? 'Lichess' : 'Chess.com' }).getAttribute('href')).toBe(game.url);
    expect(screen.getByRole('link', { name: `All vs ${game.opponent.name}` }).getAttribute('href')).toBe(
      `/u/test-player/games?oppName=${game.opponent.name}`,
    );
    // Keyboard: Enter toggles it closed again.
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Analyse' })).toBeNull();
  });

  it('shows a preview that fails to load inline, keeping the page', async () => {
    renderProfile(`${SLUG}/games`, { fail: [{ match: /^GET \/api\/games\/\d+$/, status: 404, code: 'not_found', message: 'No such game' }] });
    await screen.findByRole('button', { name: 'Next page' });
    fireEvent.click(document.querySelector<HTMLTableRowElement>('tr.game-row')!);
    expect(await screen.findByText('Could not load the game')).toBeTruthy();
    expect(screen.getByText('No such game')).toBeTruthy();
    // The links don't need the PGN.
    expect(screen.getByRole('link', { name: 'Analyse' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('says when the filters match nothing and resets them', async () => {
    const { location } = renderProfile(`${SLUG}/games?oppName=nobody-at-all`);
    expect(await screen.findByText('No games match these filters')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Download PGN' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(location().search).toBe(''));
  });

  it('handles a page past the end', async () => {
    const { location } = renderProfile(`${SLUG}/games?page=999`);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to the first page' }));
    await waitFor(() => expect(searchOf(location()).has('page')).toBe(false));
    expect(await screen.findByRole('button', { name: 'Next page' })).toBeTruthy();
  });

  it('warns when the export would be cut at 10,000 games', async () => {
    renderProfile(`${SLUG}/games`, { patch: { games: p => ({ ...p, total: 12_345 }) } });
    expect(await screen.findByText(/One file holds at most 10,000 of these 12,345 games/)).toBeTruthy();
  });
});

describe('opponent name suggestions', () => {
  it('loads the most played opponents once the field is focused', async () => {
    const { requests } = renderProfile(`${SLUG}/games`);
    fireEvent.click(await screen.findByRole('button', { name: /More filters/ }));
    const input = screen.getByLabelText('Opponent') as HTMLInputElement;
    const opponentCalls = () => requests(api('opponents')).filter(c => c.url.searchParams.get('pageSize') === '100');
    expect(opponentCalls().length).toBe(0);
    fireEvent.focus(input);
    await waitFor(() => expect(opponentCalls().length).toBe(1));
    // Unfiltered, whatever the page's filters are.
    expect([...opponentCalls()[0]!.url.searchParams.keys()].sort()).toEqual(['page', 'pageSize', 'view']);
    await waitFor(() => expect(input.getAttribute('list')).toBeTruthy());
    const list = document.getElementById(input.getAttribute('list')!)!;
    expect(list.tagName).toBe('DATALIST');
    expect(list.querySelectorAll('option').length).toBeGreaterThan(10);
    expect(list.querySelector('option')!.getAttribute('value')).toMatch(/^Opponent\d\d$/);
  });
});

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

describe('Explorer tab', () => {
  const frameSrc = () => new URL(screen.getByTitle('Opening explorer').getAttribute('src')!, 'http://x');

  it('embeds the Studio explorer on this profile with the filters', async () => {
    renderProfile(`${SLUG}/explorer?tc=blitz,rapid&rated=rated`);
    await screen.findByTitle('Opening explorer');
    const src = frameSrc();
    expect(src.pathname).toBe('/studio');
    expect(src.searchParams.get('embed')).toBe('explorer');
    expect(src.searchParams.get('explorer')).toBe('player:test-player');
    expect(src.searchParams.get('color')).toBe('white');
    expect(decodeFiltersSegment(src.searchParams.get('filters')!)).toEqual({ tc: ['blitz', 'rapid'], rated: 'rated' });
    // The filters bar has no colour control here: the explorer's own side toggle replaces it.
    const bar = screen.getByRole('region', { name: 'Filters' });
    expect(within(bar).queryByRole('radiogroup', { name: 'Colour' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open in Studio' }).getAttribute('href')).not.toContain('embed=');
  });

  it('switches sides and opens a line on the board', async () => {
    const { location } = renderProfile(`${SLUG}/explorer?line=e2e4,c7c5`);
    await screen.findByTitle('Opening explorer');
    expect(frameSrc().searchParams.get('pgn')).toBe('1. e4 c5');
    expect(screen.getByText('1. e4 c5', { selector: '.profile-explorer__line .san' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /As Black/ }));
    await waitFor(() => expect(searchOf(location()).get('color')).toBe('black'));
    await waitFor(() => expect(frameSrc().searchParams.get('color')).toBe('black'));
    expect(frameSrc().searchParams.get('pgn')).toBe('1. e4 c5');
  });
});

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

describe('Openings tab', () => {
  it('lists both sides by default and sends the endpoint params', async () => {
    const { requests } = renderProfile(`${SLUG}/openings`);
    expect(await screen.findByRole('region', { name: 'As White' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'As Black' })).toBeTruthy();
    const q = lastQuery(requests(api('openings')));
    expect(q.get('side')).toBe('both');
    expect(q.get('order')).toBe('most');
    expect(q.has('minGames')).toBe(false);
    // Rows show ECO, name and the line as SAN.
    expect(screen.getAllByText('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6').length).toBeGreaterThan(0);
  });

  it('changes side, order, minimum games and the move range', async () => {
    const { requests, location } = renderProfile(`${SLUG}/openings`);
    await screen.findByRole('region', { name: 'As White' });
    // The side is the colour filter (the filters bar hides its own colour control here).
    expect(within(screen.getByRole('region', { name: 'Filters' })).queryByRole('radiogroup', { name: 'Colour' })).toBeNull();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Side' })).getByRole('radio', { name: /Black/ }));
    await waitFor(() => expect(searchOf(location()).get('color')).toBe('black'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'As White' })).toBeNull());
    expect(lastQuery(requests(api('openings'))).get('side')).toBe('black');
    fireEvent.click(screen.getByRole('radio', { name: 'Worst' }));
    await waitFor(() => expect(lastQuery(requests(api('openings'))).get('order')).toBe('worst'));
    fireEvent.change(screen.getByLabelText('Min. games'), { target: { value: '20' } });
    await waitFor(() => expect(lastQuery(requests(api('openings'))).get('minGames')).toBe('20'));
    fireEvent.change(screen.getByLabelText('Max. moves'), { target: { value: '2' } });
    await waitFor(() => expect(searchOf(location()).get('maxMoves')).toBe('2'));
    // A minimum above the maximum drags the maximum along.
    fireEvent.change(screen.getByLabelText('Min. moves'), { target: { value: '4' } });
    await waitFor(() => expect(searchOf(location()).get('minMoves')).toBe('4'));
    expect(searchOf(location()).get('maxMoves')).toBe('4');
    await waitFor(() => expect(lastQuery(requests(api('openings'))).get('maxMoves')).toBe('4'));
  });

  it('never sends a minimum above the maximum from a hand-edited URL', async () => {
    const { requests } = renderProfile(`${SLUG}/openings?minMoves=5&maxMoves=2`);
    await screen.findByRole('region', { name: 'As White' });
    const q = lastQuery(requests(api('openings')));
    expect(q.get('minMoves')).toBe('5');
    expect(q.has('maxMoves')).toBe(false);
  });

  it('opens the explorer at a row’s line, keeping the filters', async () => {
    const { location } = renderProfile(`${SLUG}/openings?tc=blitz`);
    const white = await screen.findByRole('region', { name: 'As White' });
    fireEvent.click(within(white).getAllByRole('row')[1]!);
    await waitFor(() => expect(location().pathname).toBe('/u/test-player/explorer'));
    const q = searchOf(location());
    expect(q.get('color')).toBe('white');
    expect(q.get('tc')).toBe('blitz');
    expect(q.get('line')).toBeTruthy();
  });

  it('shows empty sides and errors', async () => {
    renderProfile(`${SLUG}/openings?oppName=nobody-at-all`);
    expect((await screen.findAllByText('No openings match these filters')).length).toBe(2);
    cleanup();
    vi.unstubAllGlobals();
    renderProfile(`${SLUG}/openings`, { fail: [{ match: /openings$/, status: 400, code: 'validation', message: 'Bad params' }] });
    expect(await screen.findByText('Bad params')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Opponents
// ---------------------------------------------------------------------------

describe('Opponents tab', () => {
  it('lists the most played opponents with links to their games and profiles', async () => {
    const { requests } = renderProfile(`${SLUG}/opponents?tc=blitz`);
    const box = (await screen.findByRole('heading', { name: 'Opponents' })).closest('section')!;
    await waitFor(() => expect(within(box).getAllByRole('row').length).toBe(21));
    const q = lastQuery(requests(api('opponents')));
    expect(q.get('view')).toBe('most');
    expect(q.get('page')).toBe('1');
    expect(q.get('tc')).toBe('blitz');
    // The fixture gives Opponent01 a local profile.
    expect(within(box).getAllByRole('link').some(a => a.getAttribute('href') === '/u/opponent-one' && a.textContent?.includes('Opponent01'))).toBe(true);
    expect(within(box).getByRole('link', { name: 'Games against Opponent01' }).getAttribute('href')).toBe(
      '/u/test-player/games?tc=blitz&oppName=Opponent01',
    );
  });

  it('switches to titled opponents and pages', async () => {
    const { requests, location } = renderProfile(`${SLUG}/opponents?page=2`);
    await screen.findByRole('button', { name: 'Previous page' });
    fireEvent.click(screen.getByRole('radio', { name: /Titled/ }));
    await waitFor(() => expect(searchOf(location()).get('view')).toBe('titled'));
    expect(searchOf(location()).has('page')).toBe(false);
    await waitFor(() => expect(lastQuery(requests(api('opponents'))).get('view')).toBe('titled'));
    const box = screen.getByRole('heading', { name: 'Opponents' }).closest('section')!;
    await waitFor(() => expect(within(box).queryAllByText('GM').length).toBeGreaterThan(0));
  });

  it('shows how wins, draws and losses end', async () => {
    const { requests } = renderProfile(`${SLUG}/opponents?color=white`);
    expect(await screen.findByRole('heading', { name: 'How games end' })).toBeTruthy();
    expect(lastQuery(requests(api('behaviour'))).get('color')).toBe('white');
    const wins = (await screen.findByRole('heading', { name: 'Wins' })).closest('section')!;
    expect(within(wins).getByText('Resignation')).toBeTruthy();
    const total = filterGames({ color: 'white' }).filter(g => g.outcome === 'w').length;
    expect(within(wins).getByText(`${total} games`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Draws' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Losses' })).toBeTruthy();
  });

  it('shows empty states', async () => {
    renderProfile(`${SLUG}/opponents?oppName=nobody-at-all`);
    expect(await screen.findByText('No opponents match these filters')).toBeTruthy();
    expect(await screen.findByText('No wins')).toBeTruthy();
    expect(screen.getByText('No draws')).toBeTruthy();
    expect(screen.getByText('No losses')).toBeTruthy();
  });
});
