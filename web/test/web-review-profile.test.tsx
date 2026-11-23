/**
 * Fixes from the web review on the profile pages: the W/D/L perspective preference (and the
 * Display settings' note on it), creating a profile for an opponent (opponents table, game
 * preview), the openings' board preview and the W/D/L bar's wording.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserPrefs } from '@outpost/shared/api';
import { perspectiveWdl, WdlBar } from '../src/app/components/WdlBar.tsx';
import GamesPage from '../src/app/pages/profile/GamesPage.tsx';
import OpeningsPage from '../src/app/pages/profile/OpeningsPage.tsx';
import OpponentsPage from '../src/app/pages/profile/OpponentsPage.tsx';
import OverviewPage from '../src/app/pages/profile/OverviewPage.tsx';
import ProfileLayout from '../src/app/pages/profile/ProfileLayout.tsx';
import LinePreview, { linePosition, previewPlacement } from '../src/app/pages/profile/components/LinePreview.tsx';
import { newProfileForOpponent } from '../src/app/pages/profile/links.ts';
import SettingsPage from '../src/app/pages/SettingsPage.tsx';
import { ALL_GAMES, mockFetch, sessionInfo, type MockOptions } from './web-profile-fixtures.ts';

vi.mock('../src/app/components/PgnViewer.tsx', () => ({
  PgnViewer: ({ pgn }: { pgn: string }) => <div data-testid="pgn-viewer" data-pgn={pgn} />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SLUG = '/u/test-player';

/** The profile routes over the fixtures' fake API, with the viewer's prefs overridden. */
function renderAs(path: string, prefs: Partial<UserPrefs> = {}, opts: MockOptions = {}) {
  const base = mockFetch(opts);
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    if (url.pathname === '/api/session') {
      const s = sessionInfo(opts.signedIn ?? true, opts.anonymousBrowsing ?? true);
      if (s.user) s.user.prefs = { ...s.user.prefs, ...prefs };
      return new Response(JSON.stringify(s), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return base(input, init);
  }) as typeof fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const router = createMemoryRouter(
    [
      {
        path: '/u/:slug',
        Component: ProfileLayout,
        children: [
          { index: true, Component: OverviewPage },
          { path: 'games', Component: GamesPage },
          { path: 'openings', Component: OpeningsPage },
          { path: 'opponents', Component: OpponentsPage },
        ],
      },
      { path: '/settings', Component: SettingsPage },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

/** The first element matching `sel` once it is rendered. */
const find = <E extends Element = Element>(sel: string, root: ParentNode = document): Promise<E> =>
  waitFor(() => {
    const el = root.querySelector<E>(sel);
    expect(el).not.toBeNull();
    return el!;
  });

/** Segment classes of a bar, in order (`win,draw,loss` or `white,draws,black`). */
const classesOf = (bar: Element): string => [...bar.children].map(c => c.className).join(',');

describe('perspectiveWdl (the winratePerspective preference)', () => {
  const x = { w: 5, d: 2, l: 3 };

  it("keeps the player's results by default and for bars mixing both colours", () => {
    expect(perspectiveWdl(x, 'white', 'player')).toEqual({ w: 5, d: 2, l: 3, mode: 'player' });
    expect(perspectiveWdl(x, null, 'white')).toEqual({ w: 5, d: 2, l: 3, mode: 'player' });
    expect(perspectiveWdl(x, undefined, 'white')).toEqual({ w: 5, d: 2, l: 3, mode: 'player' });
  });

  it('turns one-colour bars into White wins / draws / Black wins', () => {
    expect(perspectiveWdl(x, 'white', 'white')).toEqual({ w: 5, d: 2, l: 3, mode: 'color' });
    // As Black, the player's wins are Black's wins.
    expect(perspectiveWdl(x, 'black', 'white')).toEqual({ w: 3, d: 2, l: 5, mode: 'color' });
  });
});

describe('WdlBar wording', () => {
  it('names single games in the singular', () => {
    const { container, rerender } = render(<WdlBar w={1} d={1} l={2} />);
    expect(container.querySelector('.wdl-bar')!.getAttribute('aria-label')).toBe('1 win (25.0%), 1 draw (25.0%), 2 losses (50.0%)');
    rerender(<WdlBar w={2} d={0} l={1} mode="color" />);
    expect(container.querySelector('.wdl-bar')!.getAttribute('aria-label')).toBe('2 White wins (66.7%), 0 draws (0.0%), 1 Black win (33.3%)');
  });
});

describe('the W/D/L perspective on the profile pages', () => {
  it('shows White / Black results on the openings tables when the viewer chose them', async () => {
    renderAs(`${SLUG}/openings`, { winratePerspective: 'white' });
    const black = await screen.findByRole('region', { name: 'As Black' });
    const bar = await find('td.col-wdl .wdl-bar', black);
    expect(classesOf(bar)).toMatch(/^(white|draws|black)(,(white|draws|black))*$/);
    expect(bar.getAttribute('aria-label')).toMatch(/White win|Black win/);
  });

  it("keeps the player's results by default", async () => {
    renderAs(`${SLUG}/openings`);
    const white = await screen.findByRole('region', { name: 'As White' });
    const bar = await find('td.col-wdl .wdl-bar', white);
    expect(classesOf(bar)).toMatch(/^(win|draw|loss)(,(win|draw|loss))*$/);
  });

  it('splits the opponents bars by colour only under a colour filter', async () => {
    const { unmount } = renderAs(`${SLUG}/opponents`, { winratePerspective: 'white' });
    let bar = await find('.opponents-table td.col-wdl .wdl-bar');
    expect(classesOf(bar)).toMatch(/win|draw|loss/);
    unmount();
    renderAs(`${SLUG}/opponents?color=black`, { winratePerspective: 'white' });
    bar = await find('.opponents-table td.col-wdl .wdl-bar');
    expect(classesOf(bar)).toMatch(/^(white|draws|black)/);
  });

  it('colours the overview by colour rows, not the time-control rows', async () => {
    renderAs(SLUG, { winratePerspective: 'white' });
    const colours = await waitFor(() => {
      const bars = document.querySelectorAll('.ov-color .wdl-bar');
      expect(bars.length).toBe(2);
      return bars;
    });
    // The Black row: the player's losses are White's wins.
    expect(colours[1]!.getAttribute('aria-label')).toMatch(/White win.*Black win/);
    expect(classesOf(await find('.ov-tc .wdl-bar'))).toMatch(/win|draw|loss/);
  });
});

describe('the Display settings', () => {
  it('say where White / Black results apply', async () => {
    renderAs('/settings?section=display');
    expect(await screen.findByText(/Bars mixing both colours keep the player's results/)).toBeTruthy();
  });
});

describe('a profile for an opponent', () => {
  it('links the new-profile form with the account picked', () => {
    expect(newProfileForOpponent({ kind: 'chesscom', key: 'faustinooro', name: 'FaustinoOro' })).toBe('/profiles/new?chesscom=FaustinoOro&name=FaustinoOro');
    expect(newProfileForOpponent({ kind: 'lichess', key: 'someone', name: 'Other Name' })).toBe('/profiles/new?lichess=someone&name=Other+Name');
    expect(newProfileForOpponent({ kind: 'fide', key: '1503014', name: 'Carlsen, Magnus' })).toBe(
      '/profiles/new?fide=1503014&fideName=Carlsen%2C+Magnus&name=Carlsen%2C+Magnus',
    );
    // A PGN opponent is only a name.
    expect(newProfileForOpponent({ kind: 'pgn', key: 'doe, jane', name: 'Doe, Jane' })).toBeNull();
  });

  it('offers it on the opponents table for opponents without a profile, signed in', async () => {
    renderAs(`${SLUG}/opponents`);
    const table = await find<HTMLElement>('.opponents-table');
    const rows = await within(table).findAllByRole('row');
    const create = within(table).getAllByRole('link', { name: /^New profile for / });
    expect(create.length).toBeGreaterThan(0);
    const href = create[0]!.getAttribute('href')!;
    expect(href).toMatch(/^\/profiles\/new\?(lichess|chesscom)=Opponent\d\d&name=Opponent\d\d$/);
    // Opponent01 has a profile here: its name links to it, and there is nothing to create.
    const one = rows.find(r => r.textContent?.includes('Opponent01'));
    expect(one).toBeTruthy();
    expect(within(one!).getAllByRole('link').some(a => a.getAttribute('href') === '/u/opponent-one')).toBe(true);
    expect(within(one!).queryByRole('link', { name: /^New profile/ })).toBeNull();
    // The link does not also open the row's games.
    fireEvent.click(create[0]!);
  });

  it('is not offered to visitors who are not signed in', async () => {
    renderAs(`${SLUG}/opponents`, {}, { signedIn: false });
    await find('.opponents-table td.col-wdl .wdl-bar');
    expect(screen.queryByRole('link', { name: /^New profile for / })).toBeNull();
  });

  it("puts the opponent's profile, or a new one, in the game preview", async () => {
    const vsOne = ALL_GAMES.find(g => g.opponent.key === 'opponent01')!;
    const { unmount } = renderAs(`${SLUG}/games?oppName=Opponent01`);
    fireEvent.click(await find('tr.game-row'));
    const profile = await screen.findByRole('link', { name: 'Profile of Opponent01' });
    expect(profile.getAttribute('href')).toBe('/u/opponent-one');
    expect(screen.queryByRole('link', { name: /^New profile/ })).toBeNull();
    expect(vsOne.opponent.name).toBe('Opponent01');
    unmount();

    renderAs(`${SLUG}/games?oppName=Opponent02`);
    fireEvent.click(await find('tr.game-row'));
    const create = await screen.findByRole('link', { name: 'New profile for Opponent02' });
    expect(create.getAttribute('href')).toMatch(/^\/profiles\/new\?(lichess|chesscom)=Opponent02&name=Opponent02$/);
    expect(create.textContent).toBe('New profile');
  });
});

describe('the openings board preview', () => {
  it('finds the position at the end of a line', () => {
    const p = linePosition('e2e4,c7c5,g1f3');
    expect(p?.fen).toBe('rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
    expect(p?.lastMove).toEqual(['g1', 'f3']);
    expect(linePosition('')?.lastMove).toBeUndefined();
    expect(linePosition('e2e5')).toBeNull();
  });

  it('opens below the name, or above it near the bottom of the window', () => {
    expect(previewPlacement({ left: 100, top: 200, bottom: 220 }, { width: 1280, height: 900 }, 176)).toEqual({ left: 100, top: 226 });
    expect(previewPlacement({ left: 100, top: 800, bottom: 820 }, { width: 1280, height: 900 }, 176)).toEqual({ left: 100, top: 618 });
    // Kept inside the window horizontally.
    expect(previewPlacement({ left: 1250, top: 200, bottom: 220 }, { width: 1280, height: 900 }, 176).left).toBe(1096);
  });

  it('draws a view-only board turned to the player, outside the table', () => {
    render(<LinePreview line="e2e4,e7e5" color="black" anchor={{ left: 10, top: 10, bottom: 30 }} />);
    const box = document.body.querySelector<HTMLElement>('body > .line-preview')!;
    expect(box).not.toBeNull();
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.querySelector('.cg-wrap')?.classList.contains('orientation-black')).toBe(true);
    expect(box.style.top).toBe('36px');
  });

  it('shows on hovering an opening name, and goes on leaving it', async () => {
    renderAs(`${SLUG}/openings`);
    const white = await screen.findByRole('region', { name: 'As White' });
    const link = await find<HTMLAnchorElement>('td.op-name a.row-action', white);
    fireEvent.pointerOver(link, { pointerType: 'mouse' });
    await waitFor(() => expect(document.querySelector('.line-preview .cg-wrap')).not.toBeNull());
    fireEvent.pointerOut(link, { pointerType: 'mouse' });
    await waitFor(() => expect(document.querySelector('.line-preview')).toBeNull());
    // A touch tap opens the line instead.
    fireEvent.pointerOver(link, { pointerType: 'touch' });
    expect(document.querySelector('.line-preview')).toBeNull();
  });
});
