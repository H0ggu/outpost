import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileHeader } from './web-profile-fixtures.ts';
import { renderProfile, searchOf } from './web-profile-render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SLUG = '/u/test-player';
const api = (rest = '') => `/api/profiles/test-player${rest ? `/${rest}` : ''}`;

describe('ProfileLayout header', () => {
  it('shows the name, title, accounts with ratings and sync state, and the tabs', async () => {
    renderProfile(SLUG);
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Test Player');
    expect(heading.textContent).toContain('GM');
    expect(screen.getByText('TestPlayer').closest('a')?.getAttribute('href')).toBe('https://lichess.org/@/testplayer');
    expect(screen.getByText('test_player')).toBeTruthy();
    expect(screen.getAllByText(/synced .* ago · \d+ games/).length).toBe(2);
    expect(screen.getByRole('img', { name: 'Chess.com' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Profile sections' });
    expect(within(tabs).getAllByRole('link').map(a => a.textContent)).toEqual([
      'Overview',
      'Games',
      'Explorer',
      'Openings',
      'Opponents',
      'World map',
      'Activity',
      'Rating',
      'Settings',
    ]);
    // The Studio link opens this player's explorer (full page load, not an SPA link).
    const studio = screen.getByRole('link', { name: /Analyse in Studio/i });
    expect(studio.getAttribute('href')).toBe('/studio?explorer=player%3Atest-player&color=white&filters=_');
  });

  it('hides Settings and Update from viewers who cannot edit', async () => {
    renderProfile(SLUG, { header: { canEdit: false } });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull();
  });

  it('shows a not-found state for unknown or private profiles', async () => {
    renderProfile('/u/nobody');
    expect(await screen.findByText('No profile called “nobody”')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search for this player' }).getAttribute('href')).toBe('/search?q=nobody');
  });

  it('shows an error with retry when the header fails', async () => {
    const { requests } = renderProfile(SLUG, { fail: [{ match: /^GET \/api\/profiles\/test-player$/, status: 500, code: 'internal', message: 'Boom' }] });
    expect(await screen.findByText('Boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(requests(api()).length).toBe(2));
  });

  it('keeps the cached profile on screen when a refetch fails, with an inline retry', async () => {
    const fail: Array<{ match: RegExp; status: number; code: string; message: string }> = [];
    const { requests, queryClient } = renderProfile(`${SLUG}/settings`, { fail });
    await screen.findByRole('heading', { level: 1 });
    // The server goes away; something (here: a finished sync) refreshes the header.
    fail.push({ match: /^GET \/api\/profiles\/test-player$/, status: 502, code: 'upstream_error', message: 'Bad gateway' });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['profile', 'test-player'] });
    });
    expect(await screen.findByText('Could not refresh this profile')).toBeTruthy();
    expect(screen.getByText('Bad gateway')).toBeTruthy();
    // Header, tabs and the active tab stay.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Test Player');
    expect(screen.getByRole('navigation', { name: 'Profile sections' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Delete profile' })).toBeTruthy();
    // Back online: Retry clears the banner.
    fail.length = 0;
    const before = requests(api()).length;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(requests(api()).length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText('Could not refresh this profile')).toBeNull());
  });

  it('shows not found when a refetch says the profile is gone', async () => {
    const fail: Array<{ match: RegExp; status: number; code: string; message: string }> = [];
    const { queryClient } = renderProfile(`${SLUG}/games`, { fail });
    await screen.findByRole('heading', { level: 1 });
    fail.push({ match: /^GET \/api\/profiles\/test-player$/, status: 404, code: 'not_found', message: 'Profile not found' });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['profile', 'test-player'] });
    });
    expect(await screen.findByText('No profile called “test-player”')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Profile sections' })).toBeNull();
  });

  it('redirects a mixed-case address to the lowercase slug', async () => {
    const { location, calls } = renderProfile('/u/Test-Player/games?tc=blitz');
    await screen.findByRole('heading', { level: 1 });
    expect(location().pathname).toBe('/u/test-player/games');
    expect(location().search).toBe('?tc=blitz');
    // The mixed-case slug never reaches the server.
    expect(calls.some(c => c.url.pathname.includes('Test-Player'))).toBe(false);
  });

  it('treats an address the server rejects as not found', async () => {
    renderProfile('/u/-x', { fail: [{ match: /^GET \/api\/profiles\/-x$/, status: 400, code: 'validation', message: 'invalid profile slug' }] });
    expect(await screen.findByText('No profile called “-x”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('toggles the bookmark', async () => {
    const { requests } = renderProfile(SLUG);
    fireEvent.click(await screen.findByRole('button', { name: 'Bookmark this profile' }));
    await screen.findByRole('button', { name: 'Remove bookmark' });
    expect(requests(api('bookmark'), 'PUT').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove bookmark' }));
    await screen.findByRole('button', { name: 'Bookmark this profile' });
    expect(requests(api('bookmark'), 'DELETE').length).toBe(1);
  });

  it('hides the bookmark star from anonymous visitors', async () => {
    renderProfile(SLUG, { signedIn: false });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Bookmark this profile' })).toBeNull();
  });

  it('asks anonymous visitors to sign in, without asking the server, when anonymous browsing is off', async () => {
    const { requests } = renderProfile(SLUG, { signedIn: false, anonymousBrowsing: false });
    expect(await screen.findByText('Sign in to see this profile')).toBeTruthy();
    expect(requests(api())).toHaveLength(0);
  });

  it('queues an update and shows the queue position', async () => {
    // The fake server keeps the job queued once asked.
    let queued = false;
    const { requests } = renderProfile(SLUG, {
      header: () => (queued ? { queue: { busy: true, cooldownUntil: null, queuePosition: 2 } } : {}),
      record: (method, url) => {
        if (method === 'POST' && url.pathname.endsWith('/update')) queued = true;
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Update$/ }));
    expect(await screen.findByText('In queue · #2')).toBeTruthy();
    expect(requests(api('update'), 'POST').length).toBe(1);
  });

  it('shows running progress while a sync runs', async () => {
    const base = profileHeader();
    renderProfile(SLUG, {
      header: {
        queue: { busy: true, cooldownUntil: null, queuePosition: 0 },
        sources: base.sources.map((s, i) =>
          i === 0 ? { ...s, sync: { ...s.sync, state: 'running', progress: { done: 312, total: null, message: null }, queuePosition: 0 } } : s,
        ),
      },
    });
    expect(await screen.findByText('Updating · TestPlayer: 312')).toBeTruthy();
    // The account chip says what the number counts (it read 'updating · 0' before any game).
    expect(screen.getByText(/updating · 312 checked/)).toBeTruthy();
  });

  it('counts games from the status poll while a sync imports them', async () => {
    const base = profileHeader();
    const lichess = base.sources[0]!;
    // The status endpoint already knows about 25 more games than the header did.
    let path = '';
    renderProfile(SLUG, {
      record: (_m, url) => {
        path = url.pathname;
      },
      header: () => ({
        queue: { busy: true, cooldownUntil: null, queuePosition: 0 },
        sources: base.sources.map((s, i) =>
          i === 0
            ? {
                ...s,
                gameCount: path.endsWith('/status') ? s.gameCount + 25 : s.gameCount,
                sync: { ...s.sync, state: 'running', progress: { done: 40, total: null, message: null, counts: { imported: 25 } }, queuePosition: 0 },
              }
            : s,
        ),
      }),
    });
    const n = new Intl.NumberFormat('en-US').format(lichess.gameCount + 25);
    expect(await screen.findByText(new RegExp(`updating · 25 new · ${n} games`))).toBeTruthy();
  });

  it('shows a failed sync with its error', async () => {
    const base = profileHeader();
    renderProfile(SLUG, {
      header: {
        sources: base.sources.map((s, i) =>
          i === 1 ? { ...s, sync: { ...s.sync, state: 'error', lastError: 'Chess.com answered 410 Gone' } } : s,
        ),
      },
    });
    expect(await screen.findByText(/sync failed · \d+ games/)).toBeTruthy();
    expect(screen.getByText('Chess.com answered 410 Gone')).toBeTruthy();
  });

  it('counts down a cooldown from the server', async () => {
    const until = Date.now() + 125_000;
    renderProfile(SLUG, { header: { queue: { busy: false, cooldownUntil: until, queuePosition: null } } });
    const button = await screen.findByRole('button', { name: /Update in 2:0[45]/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns a cooldown error into a countdown', async () => {
    const retryAt = Date.now() + 61_000;
    renderProfile(SLUG, { fail: [{ match: /^POST .*\/update$/, status: 429, code: 'cooldown', message: 'Too soon', details: { retryAt } }] });
    fireEvent.click(await screen.findByRole('button', { name: /^Update$/ }));
    expect(await screen.findByRole('button', { name: /Update in 1:0[01]/ })).toBeTruthy();
    expect(screen.queryByText('Too soon')).toBeNull();
  });

  it('shows other update errors', async () => {
    renderProfile(SLUG, { fail: [{ match: /^POST .*\/update$/, status: 403, code: 'forbidden', message: 'Not your profile' }] });
    fireEvent.click(await screen.findByRole('button', { name: /^Update$/ }));
    expect(await screen.findByText('Not your profile')).toBeTruthy();
  });

  it('refreshes the profile when a running sync finishes', async () => {
    let busy = true;
    const { requests } = renderProfile(SLUG, {
      header: () => ({ queue: { busy, cooldownUntil: null, queuePosition: busy ? 1 : null } }),
    });
    await screen.findByText('In queue · #1');
    const before = requests(api()).length;
    busy = false;
    // The next status poll (every 3 s) sees the empty queue and refetches the header and stats.
    await waitFor(() => expect(screen.queryByText(/In queue/)).toBeNull(), { timeout: 6000 });
    await waitFor(() => expect(requests(api()).length).toBeGreaterThan(before));
    expect(await screen.findByRole('button', { name: /^Update$/ })).toBeTruthy();
  }, 10_000);
});

describe('tab links and the filters bar', () => {
  it('shows the filters bar on filtered tabs only and carries filters between them', async () => {
    const { location } = renderProfile(`${SLUG}/games?tc=blitz&color=white`);
    expect(await screen.findByRole('region', { name: 'Filters' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Profile sections' });
    expect(within(tabs).getByText('Openings').getAttribute('href')).toBe('/u/test-player/openings?color=white&tc=blitz');
    expect(within(tabs).getByText('Activity').getAttribute('href')).toBe('/u/test-player/activity');
    expect(within(tabs).getByText('Rating').getAttribute('href')).toBe('/u/test-player/rating');
    fireEvent.click(within(tabs).getByText('Overview'));
    await waitFor(() => expect(location().pathname).toBe('/u/test-player'));
    expect(screen.queryByRole('region', { name: 'Filters' })).toBeNull();
  });

  it('carries only the date range to the Rating tab', async () => {
    renderProfile(`${SLUG}/games?period=3m&tc=blitz`);
    const tabs = await screen.findByRole('navigation', { name: 'Profile sections' });
    expect(within(tabs).getByText('Rating').getAttribute('href')).toBe('/u/test-player/rating?period=3m');
  });

  it('carries only the date range back from the Rating tab', async () => {
    // Account and time control there narrow the chart, not the other tabs.
    renderProfile(`${SLUG}/rating?period=6m&tc=blitz&src=12`);
    const tabs = await screen.findByRole('navigation', { name: 'Profile sections' });
    expect(within(tabs).getByText('Games').getAttribute('href')).toBe('/u/test-player/games?period=6m');
    expect(within(tabs).getByText('Openings').getAttribute('href')).toBe('/u/test-player/openings?period=6m');
    expect(within(tabs).getByText('Rating').getAttribute('href')).toBe('/u/test-player/rating?period=6m&tc=blitz&src=12');
    expect(within(tabs).getByText('Overview').getAttribute('href')).toBe('/u/test-player');
  });

  it('updates the URL from the controls and resets paging', async () => {
    const { location } = renderProfile(`${SLUG}/games?page=3`);
    await screen.findByRole('region', { name: 'Filters' });
    fireEvent.click(screen.getByRole('radio', { name: /Black/ }));
    await waitFor(() => expect(searchOf(location()).get('color')).toBe('black'));
    expect(searchOf(location()).has('page')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Bullet/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wins/ }));
    await waitFor(() => expect(searchOf(location()).get('outcome')).toBe('w'));
    expect(searchOf(location()).get('tc')).toBe('bullet');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30d' } });
    await waitFor(() => expect(searchOf(location()).get('period')).toBe('30d'));
    fireEvent.click(screen.getByRole('radio', { name: 'Casual' }));
    await waitFor(() => expect(searchOf(location()).get('rated')).toBe('unrated'));
    // Mobile summary chips list the active filters.
    expect(within(screen.getByRole('list', { name: 'Active filters' })).getAllByRole('button').length).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(location().search).toBe(''));
  });

  it('removes one filter from its chip', async () => {
    const { location } = renderProfile(`${SLUG}/games?tc=blitz&color=white`);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove filter As White' }));
    await waitFor(() => expect(location().search).toBe('?tc=blitz'));
  });

  it('sets a custom date range', async () => {
    const { location } = renderProfile(`${SLUG}/openings`);
    fireEvent.change(await screen.findByLabelText('Period'), { target: { value: 'custom' } });
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-01-01' } });
    await waitFor(() => expect(searchOf(location()).get('from')).toBe('2026-01-01'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-30' } });
    await waitFor(() => expect(searchOf(location()).get('to')).toBe('2026-06-30'));
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '' } });
    await waitFor(() => expect(location().search).toBe(''));
  });

  it('filters by opponent, event, strength and account', async () => {
    const { location } = renderProfile(`${SLUG}/opponents`);
    fireEvent.click(await screen.findByRole('button', { name: /More filters/ }));
    const opp = screen.getByLabelText('Opponent');
    fireEvent.change(opp, { target: { value: 'Opponent01' } });
    fireEvent.keyDown(opp, { key: 'Enter' });
    await waitFor(() => expect(searchOf(location()).get('oppName')).toBe('Opponent01'));
    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'Arena' } });
    fireEvent.blur(screen.getByLabelText('Event'));
    await waitFor(() => expect(searchOf(location()).get('event')).toBe('Arena'));
    fireEvent.change(screen.getByLabelText('Opponent strength'), { target: { value: '-100' } });
    await waitFor(() => expect(searchOf(location()).get('opp')).toBe('-100'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Accounts' })).getByRole('button', { name: /test_player/ }));
    await waitFor(() => expect(searchOf(location()).get('src')).toBe('12'));
  });

  it('commits a typed opponent name after a pause', async () => {
    const { location } = renderProfile(`${SLUG}/games`);
    fireEvent.click(await screen.findByRole('button', { name: /More filters/ }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: 'Opp' } });
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    vi.useRealTimers();
    await waitFor(() => expect(searchOf(location()).get('oppName')).toBe('Opp'));
  });

  it('sets the line filter from typed moves, shows it as SAN and clears it', async () => {
    const { location } = renderProfile(`${SLUG}/games`);
    fireEvent.click(await screen.findByRole('button', { name: /More filters/ }));
    const input = screen.getByLabelText('Line');
    fireEvent.change(input, { target: { value: '1. e4 e4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(await screen.findByText('Illegal or unknown move: e4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Line'), { target: { value: '1. e4 c5 2. Nf3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(searchOf(location()).get('line')).toBe('e2e4,c7c5,g1f3'));
    expect(screen.getAllByText('1. e4 c5 2. Nf3').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the line filter' }));
    await waitFor(() => expect(searchOf(location()).has('line')).toBe(false));
  });

  it('leaves “Custom…” once no date is set any more', async () => {
    const { location } = renderProfile(`${SLUG}/games`);
    const period = (await screen.findByLabelText('Period')) as HTMLSelectElement;
    // Picked but not filled in yet: the date inputs stay.
    fireEvent.change(period, { target: { value: 'custom' } });
    expect(period.value).toBe('custom');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-30' } });
    await waitFor(() => expect(searchOf(location()).get('to')).toBe('2026-06-30'));
    // Retyping a date empties it for a moment: the inputs stay while focus is in them...
    const to = screen.getByLabelText('To');
    fireEvent.focus(to);
    fireEvent.change(to, { target: { value: '' } });
    await waitFor(() => expect(searchOf(location()).has('to')).toBe(false));
    expect(period.value).toBe('custom');
    expect(screen.getByLabelText('From')).toBeTruthy();
    // ...and leaving them empty goes back to "All time".
    fireEvent.blur(screen.getByLabelText('To'), { relatedTarget: document.body });
    await waitFor(() => expect(period.value).toBe(''));
    expect(screen.queryByLabelText('From')).toBeNull();
  });

  it('shows “All time” after Reset or removing the dates chip', async () => {
    const { location } = renderProfile(`${SLUG}/games?from=2026-01-01&to=2026-06-30`);
    const period = (await screen.findByLabelText('Period')) as HTMLSelectElement;
    expect(period.value).toBe('custom');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter 2026-01-01 → 2026-06-30' }));
    await waitFor(() => expect(location().search).toBe(''));
    expect(period.value).toBe('');
    // Custom picked with nothing typed, then Reset (another filter is active).
    fireEvent.click(within(screen.getByRole('group', { name: 'Time control' })).getByRole('button', { name: /Blitz/ }));
    fireEvent.change(period, { target: { value: 'custom' } });
    expect(period.value).toBe('custom');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(location().search).toBe(''));
    expect(period.value).toBe('');
  });

  it('opens the filters panel on phones', async () => {
    renderProfile(`${SLUG}/games?tc=blitz`);
    const toggle = await screen.findByRole('button', { name: 'Filters (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Filters' }).className).toContain('pfilters--open');
  });
});
