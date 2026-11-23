/**
 * A route whose code can't be loaded (a tab left open across an upgrade): RouteError reloads
 * once to get the current version, then offers the reload (web review).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_WINDOW_MS, isChunkLoadError, reloadForNewVersion } from '../src/app/chunkErrors.ts';
import RouteError from '../src/app/RouteError.tsx';

const CHUNK_ERROR = 'Failed to fetch dynamically imported module: http://localhost/assets/WorldMapPage-1.js';

beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    // no storage
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A router whose only page fails to load with `error`, under RouteError. */
function renderFailingRoute(error: Error) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        errorElement: <RouteError />,
        children: [
          {
            path: 'u/:slug/worldmap',
            lazy: async () => {
              throw error;
            },
          },
        ],
      },
    ],
    { initialEntries: ['/u/x/worldmap'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('a page whose code cannot be loaded', () => {
  it('reloads once to get the current version', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderFailingRoute(new TypeError(CHUNK_ERROR));
    expect(await screen.findByRole('heading', { name: 'Outpost was updated' })).toBeTruthy();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status', { name: 'Loading the new version' })).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch dynamically imported module/)).toBeNull();
  });

  it('offers the reload when it failed again right after one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    sessionStorage.setItem('outpost:chunk-reload', String(Date.now() - 5_000));
    renderFailingRoute(new TypeError(CHUNK_ERROR));
    const button = await screen.findByRole('button', { name: 'Reload page' });
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows other errors with a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderFailingRoute(new Error('Boom'));
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(screen.getByText('Boom')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once a minute per tab', () => {
    const reload = vi.fn();
    const t = 1_000_000;
    expect(reloadForNewVersion(t, reload)).toBe(true);
    expect(reloadForNewVersion(t + 1_000, reload)).toBe(false);
    expect(reloadForNewVersion(t + CHUNK_RELOAD_WINDOW_MS + 1, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(isChunkLoadError(new TypeError(CHUNK_ERROR))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
  });
});
