/**
 * Renders the profile routes (layout + every tab) in a memory router over the fake API in
 * web-profile-fixtures.ts, recording every request.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import ActivityPage from '../src/app/pages/profile/ActivityPage.tsx';
import ExplorerPage from '../src/app/pages/profile/ExplorerPage.tsx';
import GamesPage from '../src/app/pages/profile/GamesPage.tsx';
import OpeningsPage from '../src/app/pages/profile/OpeningsPage.tsx';
import OpponentsPage from '../src/app/pages/profile/OpponentsPage.tsx';
import OverviewPage from '../src/app/pages/profile/OverviewPage.tsx';
import ProfileLayout from '../src/app/pages/profile/ProfileLayout.tsx';
import ProfileSettingsPage from '../src/app/pages/profile/ProfileSettingsPage.tsx';
import RatingPage from '../src/app/pages/profile/RatingPage.tsx';
import WorldMapPage from '../src/app/pages/profile/WorldMapPage.tsx';
import { mockFetch, type MockOptions } from './web-profile-fixtures.ts';

/** One recorded API request. */
export interface Call {
  method: string;
  url: URL;
  body: unknown;
}

/** Renders `path` (e.g. `/u/test-player/games?tc=blitz`). */
export function renderProfile(path: string, opts: MockOptions = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    mockFetch({
      ...opts,
      record: (method, url, body) => {
        calls.push({ method, url, body });
        opts.record?.(method, url, body);
      },
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/u/:slug',
        Component: ProfileLayout,
        children: [
          { index: true, Component: OverviewPage },
          { path: 'games', Component: GamesPage },
          { path: 'explorer', Component: ExplorerPage },
          { path: 'openings', Component: OpeningsPage },
          { path: 'opponents', Component: OpponentsPage },
          { path: 'worldmap', Component: WorldMapPage },
          { path: 'activity', Component: ActivityPage },
          { path: 'rating', Component: RatingPage },
          { path: 'settings', Component: ProfileSettingsPage },
        ],
      },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  /** Requests to a path (`/api/profiles/test-player/games`), optionally by method. */
  const requests = (pathname: string, method?: string) => calls.filter(c => c.url.pathname === pathname && (!method || c.method === method));
  const location = () => router.state.location;
  return { ...view, calls, requests, router, location, queryClient };
}

/** Query parameters of the current location. */
export const searchOf = (loc: { search: string }): URLSearchParams => new URLSearchParams(loc.search);
