import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceInfo } from '@outpost/shared/api';
import { compactNumber, formatClock, percent, plural, resultLabel, sideScore, timeAgo } from '../src/app/pages/components/library/format.ts';
import { pageWindow } from '../src/app/pages/components/library/controls.tsx';
import GlobalExplorerPage, { explorerNavigation, normalizeFen, studioExplorerHref } from '../src/app/pages/GlobalExplorerPage.tsx';
import { ADMIN, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

afterEach(() => {
  vi.restoreAllMocks();
});

const reference = (totalGames: number): ReferenceInfo => ({
  databases: [],
  totalGames,
  broadcastMonths: [],
  attribution: totalGames ? ['Lichess broadcasts, CC BY-SA 4.0'] : [],
});

describe('GlobalExplorerPage', () => {
  it('offers the three explorers as Studio links, with an optional FEN', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/reference', reference(1_299_343));
    renderPage(<GlobalExplorerPage />, { route: '/explorer' });
    const masters = (await screen.findByText('Masters')).closest('a')!;
    expect(masters.getAttribute('href')).toBe('/studio?explorer=masters');
    expect(screen.getByText('Lichess').closest('a')!.getAttribute('href')).toBe('/studio?explorer=lichess');
    expect(screen.getByText('Reference').closest('a')!.getAttribute('href')).toBe('/studio?explorer=reference');
    expect(await screen.findByText('1.3M games')).toBeTruthy();
    expect(screen.getByText('Lichess broadcasts, CC BY-SA 4.0')).toBeTruthy();

    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    fireEvent.change(screen.getByLabelText(/Start from a position/), { target: { value: fen } });
    expect(masters.getAttribute('href')).toBe(studioExplorerHref('masters', fen));
    expect(new URL(masters.href).searchParams.get('fen')).toBe(fen);

    fireEvent.change(screen.getByLabelText(/Start from a position/), { target: { value: 'garbage' } });
    expect(screen.getByText(/That isn't a valid FEN/)).toBeTruthy();
    expect(masters.getAttribute('href')).toBe('/studio?explorer=masters');
  });

  it('shows the Lichess database as unavailable when the server has no token', async () => {
    api().on('GET', '/api/session', session(ADMIN, { hasLichessToken: false })).on('GET', '/api/reference', reference(5));
    renderPage(<GlobalExplorerPage />, { route: '/explorer' });
    expect(await screen.findByText(/Not available on this server: it has no Lichess API token/)).toBeTruthy();
    expect(screen.getByText('Lichess').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Admin → Settings' }).getAttribute('href')).toBe('/admin/settings');
    expect(screen.getByText('Masters').closest('a')!.getAttribute('href')).toBe('/studio?explorer=masters');
  });

  it('says when the reference database is empty', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/reference', reference(0));
    renderPage(<GlobalExplorerPage />, { route: '/explorer' });
    expect(await screen.findByText(/Empty so far/)).toBeTruthy();
  });

  it('goes straight to the Studio with ?db=', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/reference', reference(5));
    const replace = vi.spyOn(explorerNavigation, 'replace').mockImplementation(() => undefined);
    renderPage(<GlobalExplorerPage />, { route: '/explorer', path: '/explorer?db=lichess&fen=8%2F8%2F8%2F8%2F8%2F8%2F8%2FK6k%20w%20-%20-%200%201' });
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const url = new URL(replace.mock.calls[0]![0], 'http://x');
    expect(url.pathname).toBe('/studio');
    expect(url.searchParams.get('explorer')).toBe('lichess');
    expect(url.searchParams.get('fen')).toBe('8/8/8/8/8/8/8/K6k w - - 0 1');
  });

  it('ignores an unknown ?db=', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/reference', reference(5));
    const replace = vi.spyOn(explorerNavigation, 'replace').mockImplementation(() => undefined);
    renderPage(<GlobalExplorerPage />, { route: '/explorer', path: '/explorer?db=evil' });
    expect(await screen.findByText('Masters')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('validates FENs', () => {
    expect(normalizeFen('  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR   w KQkq - 0 1 ')).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(normalizeFen('')).toBeNull();
    expect(normalizeFen('8/8/8')).toBeNull();
  });
});

describe('format helpers', () => {
  it('formats results, scores, counts and clocks', () => {
    expect(resultLabel('1/2-1/2')).toBe('½-½');
    expect(sideScore('1-0', 'white')).toBe('1');
    expect(sideScore('1-0', 'black')).toBe('0');
    expect(sideScore('1/2-1/2', 'black')).toBe('½');
    expect(sideScore('*', 'white')).toBe('');
    expect(percent(0.678)).toBe('68%');
    expect(percent(null)).toBe('—');
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(12_345)).toBe('12K');
    expect(compactNumber(1_500)).toBe('1.5K');
    expect(compactNumber(4_100_000)).toBe('4.1M');
    expect(plural(1, 'game')).toBe('1 game');
    expect(plural(1200, 'game')).toBe('1,200 games');
    expect(formatClock(null)).toBe('');
    expect(formatClock(-5)).toBe('0:00');
  });

  it('says how long ago', () => {
    const now = Date.UTC(2026, 10, 23, 12);
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(timeAgo(now - 86_400_000, now)).toBe('yesterday');
    expect(timeAgo(null, now)).toBe('never');
  });

  it('builds page windows', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(6, 20)).toEqual([1, 'gap', 4, 5, 6, 7, 8, 'gap', 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 18, 19, 20]);
  });
});
