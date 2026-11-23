/**
 * Fixes from the web review on the profile pages: the W/D/L perspective preference (and the
 * Display settings' note on it), creating a profile for an opponent (opponents table, game
 * preview), the openings' board preview and the W/D/L bar's wording.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserPrefs } from '@outpost/shared/api';
import { perspectiveWdl, WdlBar } from '../src/app/components/WdlBar.tsx';
import OpeningsPage from '../src/app/pages/profile/OpeningsPage.tsx';
import OpponentsPage from '../src/app/pages/profile/OpponentsPage.tsx';
import OverviewPage from '../src/app/pages/profile/OverviewPage.tsx';
import ProfileLayout from '../src/app/pages/profile/ProfileLayout.tsx';
import SettingsPage from '../src/app/pages/SettingsPage.tsx';
import { mockFetch, sessionInfo, type MockOptions } from './web-profile-fixtures.ts';

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
