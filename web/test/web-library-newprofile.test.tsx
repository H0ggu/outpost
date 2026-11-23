import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CreateProfileRequest, ProfileHeader } from '@outpost/shared/api';
import { queryKeys } from '../src/app/api/hooks.ts';
import NewProfilePage from '../src/app/pages/NewProfilePage.tsx';
import { apiError, database, header, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const ROUTE = { route: '/profiles/new' };

function signedIn() {
  api()
    .on('GET', '/api/session', session(USER))
    .on('GET', '/api/search', req => ({ q: req.query.get('q'), profiles: [], lichess: [], chesscom: [], reference: [] }));
}

const accounts = () => screen.getByText(/^Accounts/).nextElementSibling as HTMLElement;

describe('NewProfilePage', () => {
  it('asks signed-out visitors to sign in', async () => {
    api().on('GET', '/api/session', session(null));
    renderPage(<NewProfilePage />, ROUTE);
    expect(await screen.findByText('Sign in to see and create profiles')).toBeTruthy();
  });

  it('creates a merged profile from preselected accounts and opens it with the header cached', async () => {
    signedIn();
    const created = header({ slug: 'magnus', displayName: 'DrNykterstein' });
    api().on('POST', '/api/profiles', created);
    const { location, qc } = renderPage(<NewProfilePage />, { ...ROUTE, path: '/profiles/new?lichess=DrNykterstein&chesscom=MagnusCarlsen' });

    expect(await screen.findByText('DrNykterstein')).toBeTruthy();
    expect(within(accounts()).getByText('MagnusCarlsen')).toBeTruthy();
    // The display name defaults to the first account.
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('DrNykterstein');
    expect((screen.getByLabelText('Page address') as HTMLInputElement).placeholder).toBe('drnykterstein');

    fireEvent.click(screen.getByLabelText(/Public/));
    fireEvent.click(screen.getByLabelText('Update automatically every day'));
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));

    await waitFor(() => expect(location()).toBe('/u/magnus'));
    const body = api().find('POST', '/api/profiles')[0]!.body as CreateProfileRequest;
    expect(body).toEqual({
      displayName: 'DrNykterstein',
      visibility: 'public',
      autoRefresh: true,
      sources: [
        { kind: 'lichess', key: 'DrNykterstein' },
        { kind: 'chesscom', key: 'MagnusCarlsen' },
      ],
    });
    expect(qc.getQueryData<ProfileHeader>(queryKeys.profile('magnus'))).toEqual(created);
  });

  it('adds accounts by hand (FIDE id, PGN player) and from search, and removes them', async () => {
    signedIn();
    api()
      .on('GET', '/api/databases', { databases: [database({ id: 5, name: 'Club games' }), database({ id: 6, name: 'Ref', kind: 'reference' })] })
      .on('GET', '/api/databases/5/games', { total: 1, page: 1, pageSize: 50, games: [] })
      .on('GET', '/api/search', req => ({
        q: req.query.get('q'),
        profiles: [],
        lichess: [{ kind: 'lichess', username: 'Hikaru', title: 'GM', exists: true, known: false, profileSlug: null }],
        chesscom: [],
        reference: [],
      }))
      .on('POST', '/api/profiles', header({ slug: 'x' }));
    renderPage(<NewProfilePage />, ROUTE);

    // Search and add.
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search for an account' }), { target: { value: 'hikaru' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Hikaru' }));
    expect(within(accounts()).getByText('Hikaru')).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();

    // FIDE id by hand; a bad one is refused.
    const kind = screen.getByLabelText('Add by hand');
    fireEvent.change(kind, { target: { value: 'fide' } });
    fireEvent.change(screen.getByLabelText('FIDE id'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/A FIDE id is a number/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('FIDE id'), { target: { value: '1503014' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(within(accounts()).getByText('1503014')).toBeTruthy();

    // A player inside one of my PGN databases (reference DBs aren't offered).
    fireEvent.change(kind, { target: { value: 'pgn' } });
    const dbSelect = await screen.findByLabelText('Database');
    await waitFor(() => expect(within(dbSelect).getAllByRole('option').map(o => o.textContent)).toEqual(['Choose…', 'Club games']));
    fireEvent.change(dbSelect, { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Player name'), { target: { value: 'Carlsen, M.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(within(accounts()).getByText('Carlsen, M.')).toBeTruthy();
    expect(within(accounts()).getByText('in Club games')).toBeTruthy();

    // Remove the FIDE one.
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1503014' }));
    expect(within(accounts()).queryByText('1503014')).toBeNull();

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Hikaru N' } });
    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: 'hikaru-n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    await waitFor(() => expect(api().find('POST', '/api/profiles')).toHaveLength(1));
    expect(api().find('POST', '/api/profiles')[0]!.body).toEqual({
      displayName: 'Hikaru N',
      slug: 'hikaru-n',
      visibility: 'private',
      autoRefresh: false,
      sources: [
        { kind: 'lichess', key: 'Hikaru' },
        { kind: 'pgn', key: 'Carlsen, M.', databaseId: 5 },
      ],
    });
  });

  it('says who can read a public profile, by the anonymous-browsing setting', async () => {
    signedIn();
    renderPage(<NewProfilePage />, ROUTE);
    expect(await screen.findByText('listed under Players for everyone signed in to this server')).toBeTruthy();
    api().on('GET', '/api/session', session(USER, { anonymousBrowsing: true }));
    renderPage(<NewProfilePage />, ROUTE);
    expect(await screen.findByText('listed under Players; anyone who can reach this server can read it, signed in or not')).toBeTruthy();
  });

  it('validates before sending', async () => {
    signedIn();
    renderPage(<NewProfilePage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Create profile' }));
    expect(screen.getByText('Add at least one account.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'x y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/Usernames are 2–50 letters/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'someone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'SOMEONE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Already added.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: '-bad' } });
    expect(screen.getByText(/Use 2–64 lowercase letters/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(screen.getByText('Fix the page address first.')).toBeTruthy();
    expect(api().find('POST', '/api/profiles')).toHaveLength(0);
  });

  it('explains a taken address and other server errors', async () => {
    signedIn();
    api().on('POST', '/api/profiles', apiError(409, 'conflict', 'That address is already used.'));
    renderPage(<NewProfilePage />, { ...ROUTE, path: '/profiles/new?lichess=someone' });
    fireEvent.change(await screen.findByLabelText('Page address'), { target: { value: 'taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('That address is already used. Choose another address.')).toBeTruthy();
    // The server's own wording has no full stop: one is added before the hint.
    api().on('POST', '/api/profiles', apiError(409, 'conflict', 'The address "taken" is taken', { field: 'slug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('The address "taken" is taken. Choose another address.')).toBeTruthy();

    api().on('POST', '/api/profiles', apiError(502, 'upstream_error', 'Lichess says this account does not exist'));
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Lichess says this account does not exist')).toBeTruthy();
    expect(screen.getByText('Could not create the profile')).toBeTruthy();
  });

  it('prefills a FIDE player and a database player from links', async () => {
    signedIn();
    renderPage(<NewProfilePage />, { ...ROUTE, path: '/profiles/new?fide=1503014&fideName=Carlsen%2C+Magnus&db=5&player=Carlsen%2C+M.&name=Magnus' });
    expect(await screen.findByText('Carlsen, Magnus')).toBeTruthy();
    expect(screen.getByText('FIDE 1503014')).toBeTruthy();
    expect(within(accounts()).getByText('Carlsen, M.')).toBeTruthy();
    expect(await within(accounts()).findByText(/^in (Club games|database #5)$/)).toBeTruthy();
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Magnus');
  });
});
