import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HomePage from '../src/app/pages/HomePage.tsx';
import { apiError, job, profile, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const lists = (mine = [profile()], recent = [profile()], bookmarks = [profile({ bookmarked: true })]) => {
  api()
    .on('GET', '/api/profiles', req => ({ profiles: req.query.get('scope') === 'mine' ? mine : req.query.get('scope') === 'recent' ? recent : [] }))
    .on('GET', '/api/bookmarks', { profiles: bookmarks })
    .on('GET', '/api/jobs/mine', { jobs: [] });
};

describe('HomePage signed out', () => {
  it('welcomes visitors with sign-in and sign-up', async () => {
    api().on('GET', '/api/session', session(null, { signupMode: 'invite' }));
    renderPage(<HomePage />);
    expect(await screen.findByRole('heading', { name: 'Chess statistics and opponent prep' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: 'I have an invite' }).getAttribute('href')).toBe('/signup');
    expect(screen.queryByText('Public profiles')).toBeNull();
  });

  it('hides sign-up when signups are closed and lists public profiles when anonymous browsing is on', async () => {
    api()
      .on('GET', '/api/session', session(null, { signupMode: 'closed', anonymousBrowsing: true }))
      .on('GET', '/api/profiles', req => ({ profiles: req.query.get('scope') === 'public' ? [profile({ displayName: 'Public Pat', visibility: 'public' })] : [] }));
    renderPage(<HomePage />);
    expect(await screen.findByText('Public Pat')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /create an account/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /bookmark/i })).toBeNull();
  });

  it('sends a brand-new server to setup', async () => {
    api().on('GET', '/api/session', session(null, { setupRequired: true }));
    renderPage(<HomePage />);
    expect((await screen.findByRole('link', { name: 'Set up Outpost' })).getAttribute('href')).toBe('/setup');
  });

  it('shows an error with retry when the server is unreachable', async () => {
    api().on('GET', '/api/session', apiError(500, 'internal', 'boom'));
    renderPage(<HomePage />);
    expect(await screen.findByText('Cannot reach the Outpost server')).toBeTruthy();
    api().on('GET', '/api/session', session(null));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('HomePage signed in', () => {
  it('shows the first-run guide when there is nothing yet', async () => {
    api().on('GET', '/api/session', session(USER));
    lists([], [], []);
    renderPage(<HomePage />);
    expect(await screen.findByRole('heading', { name: "Let's get you set up" })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create my profile' }).getAttribute('href')).toBe('/profiles/new');
    expect(screen.queryByRole('heading', { name: 'My profiles' })).toBeNull();
  });

  it('lists my profiles, bookmarks, recently viewed and running updates', async () => {
    api().on('GET', '/api/session', session(USER));
    lists(
      [profile({ displayName: 'Me Myself', slug: 'me' })],
      [profile({ displayName: 'Seen Sam' })],
      [profile({ displayName: 'Starred Stan', bookmarked: true })],
    );
    api().on('GET', '/api/jobs/mine', {
      jobs: [job({ kind: 'sync', label: 'Sync lichess:me', status: 'running', queuePosition: 0, progress: { done: 3, total: 10, message: '2026-11', counts: { imported: 120 } } })],
    });
    renderPage(<HomePage />);
    expect(await screen.findByText('Hello, alice')).toBeTruthy();
    const mine = (await screen.findByText('Me Myself')).closest('a')!;
    expect(mine.getAttribute('href')).toBe('/u/me');
    expect(await screen.findByText('Starred Stan')).toBeTruthy();
    expect(await screen.findByText('Seen Sam')).toBeTruthy();
    expect(await screen.findByText('Sync lichess:me')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
    // Quick links: the Studio is a full page load (plain <a>), the rest are SPA links.
    const quick = screen.getByRole('navigation', { name: 'Quick links' });
    expect(within(quick).getByText('Studio').closest('a')!.getAttribute('href')).toBe('/studio');
    expect(within(quick).getByText('Opening explorer').closest('a')!.getAttribute('href')).toBe('/explorer');
  });

  it('searches from the big box', async () => {
    api().on('GET', '/api/session', session(USER));
    lists();
    const { location } = renderPage(<HomePage />);
    const box = await screen.findByRole('searchbox', { name: 'Search players' });
    fireEvent.change(box, { target: { value: '  hikaru ' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(location()).toBe('/search?q=hikaru'));
  });

  it('toggles a bookmark from a list', async () => {
    api().on('GET', '/api/session', session(USER));
    lists([profile({ displayName: 'Me Myself', slug: 'me' })], [], []);
    api().on('PUT', '/api/profiles/me/bookmark', { bookmarked: true });
    renderPage(<HomePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bookmark Me Myself' }));
    await waitFor(() => expect(api().find('PUT', '/api/profiles/me/bookmark')).toHaveLength(1));
    expect(api().find('PUT', '/api/profiles/me/bookmark')[0]!.headers.get('x-outpost')).toBe('1');
    // Lists are refetched after the change.
    await waitFor(() => expect(api().find('GET', '/api/bookmarks').length).toBeGreaterThan(1));
  });
});
