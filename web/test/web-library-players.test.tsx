import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProfileSummary } from '@outpost/shared/api';
import BookmarksPage from '../src/app/pages/BookmarksPage.tsx';
import { filterProfiles } from '../src/app/pages/components/library/ProfileList.tsx';
import PlayersPage from '../src/app/pages/PlayersPage.tsx';
import { apiError, profile, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const PUBLIC = [
  profile({ displayName: 'Ada Public', slug: 'ada', visibility: 'public', owner: { id: 2, username: 'bob' } }),
  profile({
    displayName: 'Ben Public',
    slug: 'ben',
    visibility: 'public',
    sources: [{ kind: 'chesscom', key: 'benny', displayName: 'Benny', title: 'IM', country: 'NO' }],
  }),
];

function lists() {
  api()
    .on('GET', '/api/profiles', req => {
      const scope = req.query.get('scope');
      if (scope === 'public') return { profiles: PUBLIC };
      if (scope === 'mine') return { profiles: [profile({ displayName: 'My Own', slug: 'own' })] };
      return { profiles: [] };
    })
    .on('GET', '/api/bookmarks', { profiles: [profile({ displayName: 'Starred', slug: 'starred', bookmarked: true })] });
}

describe('PlayersPage', () => {
  it('switches lists with query-string tabs', async () => {
    api().on('GET', '/api/session', session(USER));
    lists();
    const { location } = renderPage(<PlayersPage />, { route: '/players' });
    expect(await screen.findByText('Ada Public')).toBeTruthy();
    // Owners are shown on the public list; titles and flags on account chips.
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getByText('IM')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Norway' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'My profiles' }));
    await waitFor(() => expect(location()).toBe('/players?tab=mine'));
    expect(await screen.findByText('My Own')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Recently viewed' }));
    expect(await screen.findByText('Nothing viewed yet')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Bookmarks' }));
    expect(await screen.findByText('Starred')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bookmarks' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('link', { name: 'Public' }));
    await waitFor(() => expect(location()).toBe('/players'));
  });

  it('filters by name or account and toggles bookmarks', async () => {
    api().on('GET', '/api/session', session(USER)).on('PUT', '/api/profiles/ben/bookmark', { bookmarked: true });
    lists();
    renderPage(<PlayersPage />, { route: '/players' });
    await screen.findByText('Ada Public');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter players' }), { target: { value: 'benny' } });
    expect(screen.queryByText('Ada Public')).toBeNull();
    expect(screen.getByText('Ben Public')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter players' }), { target: { value: 'nobody' } });
    expect(screen.getByText('No player matches “nobody”.')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter players' }), { target: { value: '' } });

    const star = screen.getByRole('button', { name: 'Bookmark Ben Public' });
    fireEvent.click(star);
    // Optimistic while saving.
    expect(star.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(api().find('PUT', '/api/profiles/ben/bookmark')).toHaveLength(1));
  });

  it('gives anonymous visitors the public list only', async () => {
    api().on('GET', '/api/session', session(null, { anonymousBrowsing: true }));
    lists();
    renderPage(<PlayersPage />, { route: '/players', path: '/players?tab=mine' });
    expect(await screen.findByText('Ada Public')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'My profiles' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Bookmark/ })).toBeNull();
  });

  it('asks for a sign-in when the server requires one', async () => {
    api().on('GET', '/api/session', session(null)).on('GET', '/api/profiles', apiError(401, 'unauthorized'));
    renderPage(<PlayersPage />, { route: '/players' });
    expect(await screen.findByText('Sign in to see these players')).toBeTruthy();
  });

  it('offers to create a first profile on an empty "mine" tab', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/profiles', { profiles: [] });
    renderPage(<PlayersPage />, { route: '/players', path: '/players?tab=mine' });
    expect(await screen.findByText('You have no profiles yet')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'New profile' }).length).toBeGreaterThan(0);
  });
});

describe('BookmarksPage', () => {
  it('lists bookmarks and removes one', async () => {
    let marks: ProfileSummary[] = [profile({ displayName: 'Starred', slug: 'starred', bookmarked: true })];
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/bookmarks', () => ({ profiles: marks }))
      .on('DELETE', '/api/profiles/starred/bookmark', () => {
        marks = [];
        return { bookmarked: false };
      });
    renderPage(<BookmarksPage />, { route: '/bookmarks' });
    const row = (await screen.findByText('Starred')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Starred from bookmarks' }));
    expect(await screen.findByText('No bookmarks yet')).toBeTruthy();
    expect(api().find('DELETE', '/api/profiles/starred/bookmark')).toHaveLength(1);
  });

  it('shows a filter only for longer lists', async () => {
    const many = Array.from({ length: 7 }, (_, i) => profile({ displayName: `Mark ${i}`, bookmarked: true }));
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/bookmarks', { profiles: many });
    renderPage(<BookmarksPage />, { route: '/bookmarks' });
    await screen.findByText('Mark 0');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter bookmarks' }), { target: { value: 'mark 6' } });
    expect(screen.queryByText('Mark 0')).toBeNull();
    expect(screen.getByText('Mark 6')).toBeTruthy();
  });

  it('shows errors with a retry', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/bookmarks', apiError(500, 'internal', 'db locked'));
    renderPage(<BookmarksPage />, { route: '/bookmarks' });
    expect(await screen.findByText('db locked')).toBeTruthy();
    api().on('GET', '/api/bookmarks', { profiles: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No bookmarks yet')).toBeTruthy();
  });
});

describe('filterProfiles', () => {
  it('matches names, slugs and account names case-insensitively', () => {
    const list = [profile({ displayName: 'Alpha', slug: 'alpha' }), profile({ displayName: 'Beta', slug: 'b-team' })];
    expect(filterProfiles(list, '').length).toBe(2);
    expect(filterProfiles(list, 'ALP').map(p => p.displayName)).toEqual(['Alpha']);
    expect(filterProfiles(list, 'b-te').map(p => p.displayName)).toEqual(['Beta']);
  });
});
