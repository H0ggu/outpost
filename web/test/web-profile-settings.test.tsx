/**
 * Component tests of the profile Settings tab (owner / admin): rename, address, visibility,
 * auto refresh, hiding and removing accounts, adding Lichess / Chess.com / FIDE / PGN sources,
 * and deleting the profile.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHESSCOM_ID, LICHESS_ID, profileHeader } from './web-profile-fixtures.ts';
import { renderProfile } from './web-profile-render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const PAGE = '/u/test-player/settings';
const PROFILE = '/api/profiles/test-player';

const card = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!;

describe('Settings tab', () => {
  it('is only for editors', async () => {
    renderProfile(PAGE, { header: { canEdit: false } });
    expect(await screen.findByText('Only the owner of this profile (or an admin) can change its settings')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Delete profile' })).toBeNull();
  });

  it('renames the profile and saves only what changed', async () => {
    const { requests } = renderProfile(PAGE);
    const name = await screen.findByLabelText('Name');
    const save = within(card('Profile')).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: '   ' } });
    expect(screen.getByText('Enter a name')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Test Player (club) ' } });
    fireEvent.click(within(card('Profile')).getByRole('radio', { name: /Private/ }));
    fireEvent.click(screen.getByLabelText('Update automatically every day'));
    fireEvent.click(save);
    await waitFor(() => expect(requests(PROFILE, 'PATCH').length).toBe(1));
    expect(requests(PROFILE, 'PATCH')[0]!.body).toEqual({ displayName: 'Test Player (club)', visibility: 'private', autoRefresh: false });
    expect(await screen.findByText('Saved')).toBeTruthy();
    // The header shows the new name straight away.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Test Player (club)');
  });

  it('changes the page address and moves to it', async () => {
    let slug = 'test-player';
    const { requests, location } = renderProfile(PAGE, { header: () => ({ slug }) });
    const input = await screen.findByLabelText('Page address');
    fireEvent.change(input, { target: { value: '-Bad' } });
    expect(screen.getByText(/Lowercase letters, digits and dashes/)).toBeTruthy();
    // "From name" makes one from the display name.
    fireEvent.click(screen.getByRole('button', { name: 'From name' }));
    expect((input as HTMLInputElement).value).toBe('test-player');
    fireEvent.change(input, { target: { value: 'the-tester' } });
    expect(screen.getByText('The old address stops working.')).toBeTruthy();
    fireEvent.click(within(card('Profile')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests(PROFILE, 'PATCH').length).toBe(1));
    slug = 'the-tester';
    expect(requests(PROFILE, 'PATCH')[0]!.body).toEqual({ slug: 'the-tester' });
    await waitFor(() => expect(location().pathname).toBe('/u/the-tester/settings'));
    expect(await screen.findByLabelText('Page address')).toBeTruthy();
  });

  it('shows a save error such as a taken address', async () => {
    renderProfile(PAGE, { fail: [{ match: /^PATCH /, status: 409, code: 'conflict', message: 'That address is taken' }] });
    fireEvent.change(await screen.findByLabelText('Page address'), { target: { value: 'taken' } });
    fireEvent.click(within(card('Profile')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That address is taken')).toBeTruthy();
  });

  it('hides an account from other viewers and shows it again', async () => {
    // A stateful fake server: the header follows the hidden ids it was sent.
    let hidden: number[] = [];
    const base = profileHeader();
    const { requests } = renderProfile(PAGE, {
      header: () => ({ sources: base.sources.map(s => ({ ...s, hidden: hidden.includes(s.id) })) }),
      record: (method, url, body) => {
        if (method === 'PATCH' && url.pathname === PROFILE) hidden = (body as { hiddenSourceIds: number[] }).hiddenSourceIds;
      },
    });
    const accounts = (await screen.findByRole('heading', { name: 'Accounts' })).closest('section')!;
    const hide = within(accounts).getAllByRole('button', { name: 'Hide' })[1]!;
    fireEvent.click(hide);
    await waitFor(() => expect(requests(PROFILE, 'PATCH').length).toBe(1));
    expect(requests(PROFILE, 'PATCH')[0]!.body).toEqual({ hiddenSourceIds: [CHESSCOM_ID] });
    const show = await within(accounts).findByRole('button', { name: 'Show' });
    expect(show.getAttribute('aria-pressed')).toBe('true');
    // The header marks it too.
    expect(screen.getByText('hidden')).toBeTruthy();
    fireEvent.click(show);
    await waitFor(() => expect(requests(PROFILE, 'PATCH').length).toBe(2));
    expect(requests(PROFILE, 'PATCH')[1]!.body).toEqual({ hiddenSourceIds: [] });
    expect(await within(accounts).findAllByRole('button', { name: 'Hide' })).toHaveLength(2);
  });

  it('removes an account after a confirmation', async () => {
    let removed: number | null = null;
    const base = profileHeader();
    const { requests } = renderProfile(PAGE, {
      header: () => ({ sources: base.sources.filter(s => s.id !== removed) }),
      record: (method, url) => {
        if (method === 'DELETE' && url.pathname.startsWith(`${PROFILE}/sources/`)) removed = Number(url.pathname.split('/').pop());
      },
    });
    const accounts = (await screen.findByRole('heading', { name: 'Accounts' })).closest('section')!;
    fireEvent.click(within(accounts).getByRole('button', { name: 'Remove TestPlayer' }));
    fireEvent.click(within(accounts).getByRole('button', { name: 'Cancel' }));
    expect(requests(`${PROFILE}/sources/${LICHESS_ID}`, 'DELETE').length).toBe(0);
    fireEvent.click(within(accounts).getByRole('button', { name: 'Remove TestPlayer' }));
    fireEvent.click(within(accounts).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(requests(`${PROFILE}/sources/${LICHESS_ID}`, 'DELETE').length).toBe(1));
    await waitFor(() => expect(within(accounts).queryByRole('button', { name: 'Remove TestPlayer' })).toBeNull());
    expect(within(accounts).getByRole('button', { name: 'Remove test_player' })).toBeTruthy();
  });

  it('adds a Lichess or Chess.com account by name or from search', async () => {
    const { requests } = renderProfile(PAGE);
    const add = (await screen.findByRole('heading', { name: 'Add an account' })).closest('section')!;
    fireEvent.change(within(add).getByLabelText('Username'), { target: { value: 'someone' } });
    // Typed names can be added directly…
    fireEvent.click(within(add).getByRole('button', { name: /Add “someone” on Lichess/ }));
    await waitFor(() => expect(requests(`${PROFILE}/sources`, 'POST').length).toBe(1));
    expect(requests(`${PROFILE}/sources`, 'POST')[0]!.body).toEqual({ kind: 'lichess', key: 'someone' });
    expect(await within(add).findByText('Added Lichess someone. Its games are being imported.')).toBeTruthy();
    // …or picked from the search results (debounced).
    const hit = await within(add).findByText('someone_cc', {}, { timeout: 3000 });
    fireEvent.click(within(hit.closest('li')!).getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(requests(`${PROFILE}/sources`, 'POST').length).toBe(2));
    expect(requests(`${PROFILE}/sources`, 'POST')[1]!.body).toEqual({ kind: 'chesscom', key: 'someone_cc' });
    expect(requests('/api/search').at(-1)!.url.searchParams.get('q')).toBe('someone');
  });

  it('marks accounts the profile already has', async () => {
    renderProfile(PAGE);
    const add = (await screen.findByRole('heading', { name: 'Add an account' })).closest('section')!;
    fireEvent.change(within(add).getByLabelText('Username'), { target: { value: 'TestPlayer' } });
    expect((within(add).getByRole('button', { name: /on Lichess/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(add).getByRole('button', { name: /on Chess.com/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a FIDE player from the reference database', async () => {
    const { requests } = renderProfile(PAGE);
    const add = (await screen.findByRole('heading', { name: 'Add an account' })).closest('section')!;
    fireEvent.click(within(add).getByRole('radio', { name: 'FIDE' }));
    fireEvent.change(within(add).getByLabelText('Name or FIDE id'), { target: { value: 'Synth' } });
    const hit = await within(add).findByText('Synth, Synthetic', { exact: false }, { timeout: 3000 });
    fireEvent.click(within(hit.closest('li')!).getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(requests(`${PROFILE}/sources`, 'POST').length).toBe(1));
    expect(requests(`${PROFILE}/sources`, 'POST')[0]!.body).toEqual({ kind: 'fide', key: '9990001' });
    // A bare FIDE id can be added directly.
    fireEvent.change(within(add).getByLabelText('Name or FIDE id'), { target: { value: '1503014' } });
    fireEvent.click(within(add).getByRole('button', { name: /Add FIDE id 1503014/ }));
    await waitFor(() => expect(requests(`${PROFILE}/sources`, 'POST').length).toBe(2));
    expect(requests(`${PROFILE}/sources`, 'POST')[1]!.body).toEqual({ kind: 'fide', key: '1503014' });
  });

  it('adds a player from a PGN database', async () => {
    const { requests } = renderProfile(PAGE);
    const add = (await screen.findByRole('heading', { name: 'Add an account' })).closest('section')!;
    fireEvent.click(within(add).getByRole('radio', { name: 'PGN database' }));
    const db = (await within(add).findByLabelText('Database')) as HTMLSelectElement;
    expect(db.value).toBe('3');
    const submit = within(add).getByRole('button', { name: 'Add player' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(add).getByLabelText('Player name, exactly as in the PGN'), { target: { value: ' Player, Club ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(requests(`${PROFILE}/sources`, 'POST').length).toBe(1));
    expect(requests(`${PROFILE}/sources`, 'POST')[0]!.body).toEqual({ kind: 'pgn', key: 'Player, Club', databaseId: 3 });
  });

  it('shows an add error', async () => {
    renderProfile(PAGE, { fail: [{ match: /^POST .*\/sources$/, status: 502, code: 'upstream_error', message: 'Lichess says no' }] });
    const add = (await screen.findByRole('heading', { name: 'Add an account' })).closest('section')!;
    fireEvent.change(within(add).getByLabelText('Username'), { target: { value: 'ghost' } });
    fireEvent.click(within(add).getByRole('button', { name: /Add “ghost” on Lichess/ }));
    expect(await within(add).findByText('Lichess says no')).toBeTruthy();
  });

  it('deletes the profile only after the address is typed', async () => {
    const { requests, location } = renderProfile(PAGE);
    const danger = (await screen.findByRole('heading', { name: 'Delete profile' })).closest('section')!;
    fireEvent.click(within(danger).getByRole('button', { name: 'Delete this profile' }));
    const confirm = within(danger).getByRole('button', { name: 'Delete for good' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(danger).getByRole('textbox'), { target: { value: 'test-playe' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(danger).getByRole('textbox'), { target: { value: 'test-player' } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(requests(PROFILE, 'DELETE').length).toBe(1));
    await waitFor(() => expect(location().pathname).toBe('/players'));
  });
});
