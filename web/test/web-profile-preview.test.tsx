/**
 * The Games tab's lazily loaded preview when its chunk can't be fetched (a redeploy removed it,
 * the network dropped): the error stays inside the row, Retry imports the chunk afresh (React.lazy
 * keeps a failed import), and a chunk that fails again makes Retry reload the page.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Boundary, isChunkLoadError } from '../src/app/pages/profile/components/Boundary.tsx';
import { previewChunk } from '../src/app/pages/profile/components/GameTable.tsx';
import { renderProfile } from './web-profile-render.tsx';

// pgn-viewer's dist can't load outside Vite (see web-profile-pages.test.tsx).
vi.mock('../src/app/components/PgnViewer.tsx', () => ({
  PgnViewer: ({ pgn }: { pgn: string }) => <div data-testid="pgn-viewer" data-pgn={pgn} />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHUNK_ERROR = 'Failed to fetch dynamically imported module: http://localhost/assets/X-1.js';

describe('Boundary', () => {
  it('recognises failed dynamic imports in each browser’s wording', () => {
    expect(isChunkLoadError(new TypeError(CHUNK_ERROR))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: x.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Invalid PGN'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('resets its owner before retrying, then reloads the page when a chunk fails twice', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { throwing: true };
    const Child = () => {
      if (state.throwing) throw new TypeError(CHUNK_ERROR);
      return <p>loaded</p>;
    };
    const onReset = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(
      <Boundary title="Could not show the game" onReset={onReset}>
        <Child />
      </Boundary>,
    );
    expect(screen.getByText('Could not show the game')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    // It failed again: only a fresh page can help now, and the box says so.
    expect(screen.getByText('Could not show the game: Retry reloads the page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('just retries other errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { throwing: true };
    const Child = () => {
      if (state.throwing) throw new Error('Invalid PGN');
      return <p>loaded</p>;
    };
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(
      <Boundary title="Could not show the game">
        <Child />
      </Boundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(screen.getByText('Could not show the game')).toBeTruthy();
    state.throwing = false;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(screen.getByText('loaded')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('Games tab preview chunk', () => {
  it('shows a failed chunk inline and loads it on Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.spyOn(previewChunk, 'load').mockRejectedValueOnce(new TypeError(CHUNK_ERROR));
    renderProfile('/u/test-player/games');
    const rows = await screen.findAllByRole('row');
    fireEvent.click(rows[1]!);
    expect(await screen.findByText('Could not show the game')).toBeTruthy();
    expect(screen.getByText(CHUNK_ERROR)).toBeTruthy();
    // The rest of the page is still there.
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    // The network is back: Retry imports the chunk again instead of replaying the failure.
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('pgn-viewer')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    // Other rows use the fresh import too.
    const other = screen.getAllByRole('row').filter(r => r.classList.contains('game-row') && !r.classList.contains('expanded'))[0]!;
    fireEvent.click(other);
    await waitFor(() => expect(other.classList.contains('expanded')).toBe(true));
    expect(await screen.findByTestId('pgn-viewer')).toBeTruthy();
    expect(screen.queryByText('Could not show the game')).toBeNull();
  });
});
