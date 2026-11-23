/**
 * Routes (PLAN §9), React Router 8 in data mode. Every page is lazy-loaded into its own chunk.
 * `/studio` is not here: it is a separate page (studio.html) — link to it with a full page load.
 */
import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import Layout from './Layout.tsx';
import RouteError from './RouteError.tsx';

/** Lazy route module whose default export is the page component. */
const page = (load: () => Promise<{ default: ComponentType }>): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => ({ Component: (await load()).default }),
});

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: Layout,
    errorElement: <RouteError />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, ...page(() => import('./pages/HomePage.tsx')) },
          { path: 'login', ...page(() => import('./pages/LoginPage.tsx')) },
          { path: 'setup', ...page(() => import('./pages/SetupPage.tsx')) },
          { path: 'signup', ...page(() => import('./pages/SignupPage.tsx')) },
          { path: 'search', ...page(() => import('./pages/SearchPage.tsx')) },

          {
            path: 'u/:slug',
            ...page(() => import('./pages/profile/ProfileLayout.tsx')),
            children: [
              { index: true, ...page(() => import('./pages/profile/OverviewPage.tsx')) },
              { path: 'games', ...page(() => import('./pages/profile/GamesPage.tsx')) },
              { path: 'explorer', ...page(() => import('./pages/profile/ExplorerPage.tsx')) },
              { path: 'openings', ...page(() => import('./pages/profile/OpeningsPage.tsx')) },
              { path: 'opponents', ...page(() => import('./pages/profile/OpponentsPage.tsx')) },
              { path: 'worldmap', ...page(() => import('./pages/profile/WorldMapPage.tsx')) },
              { path: 'activity', ...page(() => import('./pages/profile/ActivityPage.tsx')) },
              { path: 'rating', ...page(() => import('./pages/profile/RatingPage.tsx')) },
              { path: 'settings', ...page(() => import('./pages/profile/ProfileSettingsPage.tsx')) },
            ],
          },
          { path: 'profiles/new', ...page(() => import('./pages/NewProfilePage.tsx')) },
          { path: 'players', ...page(() => import('./pages/PlayersPage.tsx')) },
          { path: 'bookmarks', ...page(() => import('./pages/BookmarksPage.tsx')) },

          { path: 'databases', ...page(() => import('./pages/DatabasesPage.tsx')) },
          { path: 'databases/:id', ...page(() => import('./pages/DatabasePage.tsx')) },

          { path: 'prep', ...page(() => import('./pages/PrepListPage.tsx')) },
          { path: 'prep/:id', ...page(() => import('./pages/PrepPage.tsx')) },

          { path: 'broadcasts', ...page(() => import('./pages/BroadcastsPage.tsx')) },
          { path: 'broadcasts/:roundId', ...page(() => import('./pages/BroadcastRoundPage.tsx')) },

          { path: 'explorer', ...page(() => import('./pages/GlobalExplorerPage.tsx')) },
          { path: 'settings', ...page(() => import('./pages/SettingsPage.tsx')) },

          {
            path: 'admin',
            ...page(() => import('./pages/admin/AdminLayout.tsx')),
            children: [
              { index: true, element: <Navigate to="settings" replace /> },
              { path: 'settings', ...page(() => import('./pages/admin/AdminSettingsPage.tsx')) },
              { path: 'users', ...page(() => import('./pages/admin/AdminUsersPage.tsx')) },
              { path: 'jobs', ...page(() => import('./pages/admin/AdminJobsPage.tsx')) },
              { path: 'reference', ...page(() => import('./pages/admin/AdminReferencePage.tsx')) },
            ],
          },

          { path: '*', ...page(() => import('./pages/NotFoundPage.tsx')) },
        ],
      },
    ],
  },
];

/** Creates the browser router (call once, in main.tsx). */
export const createRouter = () => createBrowserRouter(routes);
