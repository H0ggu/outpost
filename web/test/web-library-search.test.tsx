import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SearchResults } from '@outpost/shared/api';
import { dedupeSources, newProfileHref, parseNewProfileQuery } from '../src/app/pages/components/library/newProfileQuery.ts';
import SearchPage from '../src/app/pages/SearchPage.tsx';
import { apiError, profile, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const results = (q: string, over: Partial<SearchResults> = {}): SearchResults => ({
  q,
  profiles: [],
  lichess: [],
  chesscom: [],
  reference: [],
  ...over,
});

describe('SearchPage', () => {
  it('asks for at least two characters', async () => {
    api().on('GET', '/api/session', session(USER));
    renderPage(<SearchPage />, { route: '/search', path: '/search' });
    expect(await screen.findByText('Type at least 2 characters')).toBeTruthy();
    expect(api().find('GET', '/api/search')).toHaveLength(0);
  });

  it('debounces typing into the URL and shows every list', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/search', req =>
        results(req.query.get('q')!, {
          profiles: [profile({ displayName: 'Hikaru (local)', slug: 'hikaru' })],
          lichess: [{ kind: 'lichess', username: 'Hikaru', title: 'GM', exists: true, known: false, profileSlug: null }],
          chesscom: [{ kind: 'chesscom', username: 'hikaru', title: 'GM', exists: true, known: true, profileSlug: 'hikaru' }],
          reference: [
            { fideId: '2016192', name: 'Nakamura, Hikaru', title: 'GM', federation: 'USA', games: 812, lastPlayed: null, maxRating: 2816, profileSlug: null },
            { fideId: null, name: 'Hikaru, Anon', title: null, federation: null, games: 2, lastPlayed: null, maxRating: null, profileSlug: null },
          ],
        }),
      );
    const { location } = renderPage(<SearchPage />, { route: '/search', path: '/search' });
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search players' }), { target: { value: 'hikaru' } });
    await waitFor(() => expect(location()).toBe('/search?q=hikaru'));
    expect(await screen.findByText('Hikaru (local)')).toBeTruthy();
    expect(api().find('GET', '/api/search').at(-1)!.query.get('q')).toBe('hikaru');

    // Chess.com account already in a profile → Open; Lichess account → create a profile.
    const cc = screen.getByText('has a profile here').closest('li')!;
    expect(within(cc).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/u/hikaru');
    expect(screen.getByRole('link', { name: 'Create a profile for Hikaru' }).getAttribute('href')).toBe('/profiles/new?lichess=Hikaru');
    // Reference player with a FIDE id → a FIDE profile (with the name); without one → no action.
    expect(screen.getByRole('link', { name: 'Create a profile for Nakamura, Hikaru' }).getAttribute('href')).toBe(
      '/profiles/new?fide=2016192&fideName=Nakamura%2C+Hikaru',
    );
    const anon = screen.getByText('Hikaru, Anon').closest('li')!;
    expect(within(anon).queryByRole('link')).toBeNull();
  });

  it('merges picked accounts into one new profile', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/search', req =>
        results(req.query.get('q')!, {
          lichess: [{ kind: 'lichess', username: 'DrNykterstein', title: 'GM', exists: true, known: false, profileSlug: null }],
          chesscom: [{ kind: 'chesscom', username: 'MagnusCarlsen', title: 'GM', exists: true, known: false, profileSlug: null }],
        }),
      );
    renderPage(<SearchPage />, { route: '/search', path: '/search?q=magnus' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Pick DrNykterstein' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick MagnusCarlsen' }));
    const bar = screen.getByRole('region', { name: 'Picked accounts' });
    expect(within(bar).getByText('DrNykterstein, MagnusCarlsen')).toBeTruthy();
    expect(within(bar).getByRole('link', { name: 'Create profile' }).getAttribute('href')).toBe(
      '/profiles/new?lichess=DrNykterstein&chesscom=MagnusCarlsen',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick DrNykterstein' }));
    expect(within(bar).getByText('MagnusCarlsen')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Picked accounts' })).toBeNull();
  });

  it('flags a site that did not answer and offers to add the username by hand', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/search', req => results(req.query.get('q')!, { unavailable: ['lichess'] }));
    renderPage(<SearchPage />, { route: '/search', path: '/search?q=somebody' });
    expect(await screen.findByText("Couldn't reach Lichess this time, so results here may be missing.")).toBeTruthy();
    // Only the failed site is flagged.
    expect(screen.queryByText(/Couldn't reach Chess.com/)).toBeNull();
    // Not "no players found": one list is unknown.
    expect(screen.queryByText(/No players found/)).toBeNull();
    expect(screen.getByText('No Chess.com account with exactly this username.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lichess account' }).getAttribute('href')).toBe('/profiles/new?lichess=somebody');
    expect(screen.getByRole('link', { name: 'Chess.com account' }).getAttribute('href')).toBe('/profiles/new?chesscom=somebody');
    const before = api().find('GET', '/api/search').length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api().find('GET', '/api/search').length).toBe(before + 1));
  });

  it('caps the query at the server limit', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/search', req => results(req.query.get('q')!));
    renderPage(<SearchPage />, { route: '/search', path: '/search' });
    expect((await screen.findByRole('searchbox', { name: /search/i })).getAttribute('maxlength')).toBe('100');
    // A longer link is cut to the limit rather than answered with a validation error.
    renderPage(<SearchPage />, { route: '/search', path: `/search?q=${'x'.repeat(150)}` });
    await waitFor(() => expect(api().find('GET', '/api/search').length).toBeGreaterThan(0));
    expect(api().find('GET', '/api/search').every(c => c.query.get('q')!.length === 100)).toBe(true);
  });

  it('says when nothing matches', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/search', req => results(req.query.get('q')!));
    renderPage(<SearchPage />, { route: '/search', path: '/search?q=zzzz' });
    expect(await screen.findByText('No players found for “zzzz”')).toBeTruthy();
  });

  it('follows the URL when the header search changes it', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/search', req => results(req.query.get('q')!));
    const { router } = renderPage(<SearchPage />, { route: '/search', path: '/search?q=first' });
    expect(await screen.findByText('No players found for “first”')).toBeTruthy();
    await router.navigate('/search?q=second');
    expect(await screen.findByText('No players found for “second”')).toBeTruthy();
    expect((screen.getByRole('searchbox', { name: 'Search players' }) as HTMLInputElement).value).toBe('second');
  });

  it('asks signed-out visitors to sign in when search needs a session', async () => {
    api()
      .on('GET', '/api/session', session(null))
      .on('GET', '/api/search', apiError(401, 'unauthorized'));
    renderPage(<SearchPage />, { route: '/search', path: '/search?q=hikaru' });
    expect(await screen.findByText('Sign in to see search results')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2Fsearch%3Fq%3Dhikaru');
  });

  it('shows results without create actions to anonymous visitors', async () => {
    api()
      .on('GET', '/api/session', session(null, { anonymousBrowsing: true }))
      .on('GET', '/api/search', req =>
        results(req.query.get('q')!, {
          lichess: [{ kind: 'lichess', username: 'Hikaru', title: 'GM', exists: true, known: false, profileSlug: null }],
        }),
      );
    renderPage(<SearchPage />, { route: '/search', path: '/search?q=hikaru' });
    expect(await screen.findByText('Hikaru')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/to create profiles from these accounts/)).toBeTruthy();
  });
});

describe('new-profile links', () => {
  it('round-trips sources through the query', () => {
    const href = newProfileHref(
      [
        { kind: 'lichess', key: 'DrNykterstein' },
        { kind: 'chesscom', key: 'MagnusCarlsen' },
        { kind: 'fide', key: '1503014', label: 'Carlsen, Magnus' },
        { kind: 'pgn', key: 'Carlsen, M.', databaseId: 4 },
      ],
      'Magnus',
    );
    const parsed = parseNewProfileQuery(new URL(href, 'http://x').searchParams);
    expect(parsed.name).toBe('Magnus');
    expect(parsed.sources).toEqual([
      { kind: 'lichess', key: 'DrNykterstein' },
      { kind: 'chesscom', key: 'MagnusCarlsen' },
      { kind: 'fide', key: '1503014', label: 'Carlsen, Magnus' },
      { kind: 'pgn', key: 'Carlsen, M.', databaseId: 4 },
    ]);
  });

  it('keeps FIDE names paired with their ids when some have none', () => {
    const href = newProfileHref([
      { kind: 'fide', key: '111' },
      { kind: 'fide', key: '222', label: 'Second, Player' },
    ]);
    expect(parseNewProfileQuery(new URL(href, 'http://x').searchParams).sources).toEqual([
      { kind: 'fide', key: '111', label: undefined },
      { kind: 'fide', key: '222', label: 'Second, Player' },
    ]);
  });

  it('drops invalid and duplicate entries', () => {
    const parsed = parseNewProfileQuery(new URLSearchParams('lichess=a%20b&lichess=Hik&lichess=hik&fide=x1&db=0&player=Z&db=3'));
    expect(parsed.sources).toEqual([{ kind: 'lichess', key: 'Hik' }]);
    expect(dedupeSources([{ kind: 'pgn', key: 'A', databaseId: 1 }, { kind: 'pgn', key: 'a', databaseId: 1 }, { kind: 'pgn', key: 'a', databaseId: 2 }])).toHaveLength(2);
  });
});
