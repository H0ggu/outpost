import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityCell, PrepOpponentReport, PrepReport, PrepSet, ProfileSummary } from '@outpost/shared/api';
import { busiestHours, peakIndex } from '../src/app/pages/components/library/ActivityBars.tsx';
import { lineExplorerHref } from '../src/app/pages/components/library/PrepReportCard.tsx';
import PrepListPage from '../src/app/pages/PrepListPage.tsx';
import PrepPage, { describeFilters } from '../src/app/pages/PrepPage.tsx';
import { apiError, gameRow, header, profile, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const OPP = profile({ id: 11, displayName: 'Olga Opponent', slug: 'olga', sources: [{ kind: 'lichess', key: 'olga', displayName: 'olga', title: 'WFM', country: 'PL' }] });

const set = (opponents: ProfileSummary[] = [OPP], over: Partial<PrepSet> = {}): PrepSet => ({
  id: 3,
  name: 'Club championship',
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 3_600_000,
  opponents,
  ...over,
});

const cells = (n: number, f: (i: number) => number): ActivityCell[] => Array.from({ length: n }, (_, i) => ({ games: f(i), score: f(i) ? 0.5 : null }));

const oppReport = (p: ProfileSummary = OPP): PrepOpponentReport => ({
  profile: p,
  asWhite: {
    games: 40,
    wdl: { w: 20, d: 10, l: 10 },
    topLines: [{ line: 'e2e4,c7c5,g1f3', san: '1. e4 c5 2. Nf3', eco: 'B27', name: 'Sicilian Defense', games: 25, w: 14, d: 6, l: 5, score: 0.68, lastPlayed: Date.now() }],
    worstLines: [{ line: 'e2e4,e7e6', san: '1. e4 e6', eco: 'C00', name: 'French Defense', games: 6, w: 1, d: 1, l: 4, score: 0.25, lastPlayed: Date.now() }],
  },
  asBlack: { games: 30, wdl: { w: 10, d: 10, l: 10 }, topLines: [], worstLines: [] },
  recentGames: [gameRow({ id: 900, opponent: { name: 'Zed', key: 'zed', rating: 1800, title: 'CM', kind: 'lichess', country: null }, outcome: 'l', result: '0-1' })],
  activity: { tz: 'Europe/Oslo', byHour: cells(24, h => (h >= 19 && h <= 22 ? 10 : h === 9 ? 2 : 0)), byWeekday: cells(7, d => (d === 2 ? 9 : 3)) },
  ratings: [{ sourceId: 1, kind: 'lichess', ratings: [{ timeClass: 'blitz', rating: 2210, games: 400, rd: 50, provisional: false }, { timeClass: 'bullet', rating: 2300, games: 900, rd: 60, provisional: true }] }],
});

const report = (opponents: PrepOpponentReport[] = [oppReport()]): PrepReport => ({ prep: { id: 3, name: 'Club championship' }, generatedAt: Date.now(), opponents });

describe('PrepListPage', () => {
  it('lists sets and creates one', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/prep', { sets: [set()] })
      .on('POST', '/api/prep', set([], { id: 8, name: 'League' }));
    const { location } = renderPage(<PrepListPage />, { route: '/prep' });
    const link = (await screen.findByText('Club championship')).closest('a')!;
    expect(link.getAttribute('href')).toBe('/prep/3');
    expect(within(link).getByText('1 opponent: Olga Opponent')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New set'), { target: { value: 'League' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(location()).toBe('/prep/8'));
    expect(api().find('POST', '/api/prep')[0]!.body).toEqual({ name: 'League', profileIds: [] });
  });

  it('deletes a set after confirmation and shows the empty state', async () => {
    let sets = [set()];
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/prep', () => ({ sets }))
      .on('DELETE', '/api/prep/3', () => {
        sets = [];
        return { ok: true };
      });
    renderPage(<PrepListPage />, { route: '/prep' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Club championship' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No prep sets yet')).toBeTruthy();
    expect(screen.getByLabelText('Name your first set')).toBeTruthy();
  });

  it('needs a sign-in', async () => {
    api().on('GET', '/api/session', session(null)).on('GET', '/api/prep', apiError(401, 'unauthorized'));
    renderPage(<PrepListPage />, { route: '/prep' });
    expect(await screen.findByText('Sign in to see your prep sets')).toBeTruthy();
    expect(api().find('GET', '/api/prep')).toHaveLength(0);
  });
});

describe('PrepPage', () => {
  const ROUTE = { route: '/prep/:id', path: '/prep/3' };

  function base(s: () => PrepSet = () => set(), r: () => PrepReport = () => report()) {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/prep/3', () => s())
      .on('GET', '/api/prep/3/report', () => r())
      .on('GET', '/api/profiles', { profiles: [OPP, profile({ id: 12, displayName: 'Pavel Peer', slug: 'pavel' })] })
      .on('GET', '/api/bookmarks', { profiles: [] })
      .on('GET', '/api/search', req => ({ q: req.query.get('q'), profiles: [], lichess: [], chesscom: [], reference: [] }));
  }

  it('renders a report card per opponent with explorer links', async () => {
    base();
    renderPage(<PrepPage />, ROUTE);
    const card = (await screen.findByRole('heading', { name: 'Olga Opponent' })).closest('article')!;
    expect(within(card).getByRole('link', { name: 'Olga Opponent' }).getAttribute('href')).toBe('/u/olga');
    // Ratings, most played first, provisional marked.
    expect(within(card).getByText('2210')).toBeTruthy();
    expect(within(card).getByText('2300?')).toBeTruthy();
    // Repertoire lines jump into the Studio's player explorer at that line.
    const line = within(card).getByText('1. e4 c5 2. Nf3').closest('a')!;
    expect(line.getAttribute('href')).toBe(lineExplorerHref('olga', 'white', {}, '1. e4 c5 2. Nf3'));
    expect(line.getAttribute('href')).toContain('explorer=player%3Aolga');
    expect(within(card).getByText('68%')).toBeTruthy();
    expect(within(card).getByText('1. e4 e6')).toBeTruthy();
    expect(within(card).getAllByText('No repeated lines yet.')).toHaveLength(1);
    // Recent games open in the Studio.
    expect(within(card).getByText('Zed').closest('li')!.querySelector('a')!.getAttribute('href')).toMatch(/^\/studio\?game=900&color=(white|black)$/);
    // When they play.
    expect(within(card).getByText('19:00–23:00')).toBeTruthy();
    expect(within(card).getByText('Wednesday')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Explorer as White' }).getAttribute('href')).toBe(lineExplorerHref('olga', 'white', {}));
  });

  it('sends the filters and the time zone, and keeps them in the URL', async () => {
    base();
    const { location } = renderPage(<PrepPage />, ROUTE);
    await screen.findByRole('heading', { name: 'Olga Opponent' });
    expect(api().find('GET', '/api/prep/3/report')[0]!.query.get('tz')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '12m' } });
    await waitFor(() => expect(location()).toBe('/prep/3?period=12m'));
    fireEvent.click(screen.getByLabelText('Blitz'));
    fireEvent.click(screen.getByLabelText('Rapid'));
    fireEvent.change(screen.getByLabelText('Games'), { target: { value: 'rated' } });
    await waitFor(() => expect(location()).toBe('/prep/3?period=12m&tc=blitz%2Crapid&rated=rated'));
    await waitFor(() => {
      const last = api().find('GET', '/api/prep/3/report').at(-1)!.query;
      expect([last.get('period'), last.get('tc'), last.get('rated')]).toEqual(['12m', 'blitz,rapid', 'rated']);
    });
    expect(screen.getByText(/Last 12 months · Blitz, Rapid · rated only/)).toBeTruthy();
    // Explorer links carry the filters too.
    expect(screen.getByRole('link', { name: 'Explorer as White' }).getAttribute('href')).toContain('filters=');
  });

  it('asks for longer or shorter repertoire lines', async () => {
    base();
    const { location } = renderPage(<PrepPage />, { route: '/prep/:id', path: '/prep/3?period=3m' });
    await screen.findByRole('heading', { name: 'Olga Opponent' });
    // the server default (8 plies) is not sent
    expect(api().find('GET', '/api/prep/3/report')[0]!.query.get('plies')).toBeNull();
    expect((screen.getByLabelText('Line length') as HTMLSelectElement).value).toBe('8');
    fireEvent.change(screen.getByLabelText('Line length'), { target: { value: '12' } });
    await waitFor(() => expect(location()).toBe('/prep/3?period=3m&plies=12'));
    await waitFor(() => expect(api().find('GET', '/api/prep/3/report').at(-1)!.query.get('plies')).toBe('12'));
    expect(api().find('GET', '/api/prep/3/report').at(-1)!.query.get('period')).toBe('3m');
    expect(screen.getByText(/lines of 6 moves/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Line length'), { target: { value: '8' } });
    await waitFor(() => expect(location()).toBe('/prep/3?period=3m'));
  });

  it('asks for a different minimum of games for the weakest lines (decision 32)', async () => {
    base();
    const { location } = renderPage(<PrepPage />, { route: '/prep/:id', path: '/prep/3?period=3m' });
    await screen.findByRole('heading', { name: 'Olga Opponent' });
    // the server default (3 games) is not sent
    expect(api().find('GET', '/api/prep/3/report')[0]!.query.get('minGames')).toBeNull();
    expect((screen.getByLabelText('Weakest lines') as HTMLSelectElement).value).toBe('3');
    expect(screen.getAllByText('(min 3 games)').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Weakest lines'), { target: { value: '10' } });
    await waitFor(() => expect(location()).toBe('/prep/3?period=3m&minGames=10'));
    await waitFor(() => expect(api().find('GET', '/api/prep/3/report').at(-1)!.query.get('minGames')).toBe('10'));
    expect(api().find('GET', '/api/prep/3/report').at(-1)!.query.get('period')).toBe('3m');
    expect(screen.getByText(/weakest\s+lines from 10 games/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Weakest lines'), { target: { value: '3' } });
    await waitFor(() => expect(location()).toBe('/prep/3?period=3m'));
  });

  it('says when the lines come from the most recent games only', async () => {
    base(undefined, () => report([{ ...oppReport(), sampledGames: 5000 }]));
    renderPage(<PrepPage />, ROUTE);
    expect(await screen.findByText(/Lines and activity come from the latest 5,000 of/)).toBeTruthy();
  });

  it('adds and removes opponents', async () => {
    let current = set();
    base(() => current);
    api().on('PUT', '/api/prep/3', req => {
      const ids = (req.body as { profileIds: number[] }).profileIds;
      const all = [OPP, profile({ id: 12, displayName: 'Pavel Peer', slug: 'pavel' })];
      current = set(all.filter(p => ids.includes(p.id)));
      return current;
    });
    renderPage(<PrepPage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Add opponents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Pavel Peer' }));
    await waitFor(() => expect(api().find('PUT', '/api/prep/3')).toHaveLength(1));
    expect(api().find('PUT', '/api/prep/3')[0]!.body).toEqual({ profileIds: [11, 12] });
    expect(await screen.findByText('Opponents (2)')).toBeTruthy();
    // Already in the set.
    expect(screen.getAllByText('in set').length).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Olga Opponent' }));
    await waitFor(() => expect(api().find('PUT', '/api/prep/3')).toHaveLength(2));
    expect(api().find('PUT', '/api/prep/3')[1]!.body).toEqual({ profileIds: [12] });
  });

  it('creates a profile for a searched account and adds it', async () => {
    let current = set([]);
    base(() => current, () => report([]));
    api()
      .on('GET', '/api/search', req => ({
        q: req.query.get('q'),
        profiles: [],
        lichess: [{ kind: 'lichess', username: 'Newbie', title: null, exists: true, known: false, profileSlug: null }],
        chesscom: [{ kind: 'chesscom', username: 'known', title: null, exists: true, known: true, profileSlug: 'known-slug' }],
        reference: [],
      }))
      .on('POST', '/api/profiles', header({ id: 33, slug: 'newbie', displayName: 'Newbie' }))
      .on('GET', '/api/profiles/known-slug', header({ id: 44, slug: 'known-slug' }))
      .on('PUT', '/api/prep/3', req => {
        current = set([], { id: 3 });
        current.opponents = (req.body as { profileIds: number[] }).profileIds.map(id => profile({ id, displayName: `P${id}` }));
        return current;
      });
    renderPage(<PrepPage />, ROUTE);
    // An empty set opens the picker straight away.
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find an opponent' }), { target: { value: 'newb' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create a profile for Newbie and add it' }));
    await waitFor(() => expect(api().find('PUT', '/api/prep/3')).toHaveLength(1));
    expect(api().find('POST', '/api/profiles')[0]!.body).toEqual({ displayName: 'Newbie', visibility: 'private', sources: [{ kind: 'lichess', key: 'Newbie' }] });
    expect(api().find('PUT', '/api/prep/3')[0]!.body).toEqual({ profileIds: [33] });

    fireEvent.click(await screen.findByRole('button', { name: 'Add known' }));
    await waitFor(() => expect(api().find('PUT', '/api/prep/3')).toHaveLength(2));
    expect(api().find('PUT', '/api/prep/3')[1]!.body).toEqual({ profileIds: [33, 44] });
  });

  it('holds removals while "Create & add" runs, and adds onto the set as saved by then', async () => {
    const PAVEL = profile({ id: 12, displayName: 'Pavel Peer', slug: 'pavel' });
    let current = set([OPP, PAVEL]);
    base(() => current, () => report([]));
    let release: () => void = () => undefined;
    api()
      .on('GET', '/api/search', req => ({
        q: req.query.get('q'),
        profiles: [],
        lichess: [{ kind: 'lichess', username: 'Newbie', title: null, exists: true, known: false, profileSlug: null }],
        chesscom: [],
        reference: [],
      }))
      .on('POST', '/api/profiles', () => new Promise(resolve => (release = () => resolve(header({ id: 33, slug: 'newbie', displayName: 'Newbie' })))))
      .on('PUT', '/api/prep/3', req => {
        const ids = (req.body as { profileIds: number[] }).profileIds;
        current = set(ids.map(id => [OPP, PAVEL].find(p => p.id === id) ?? profile({ id, displayName: `P${id}` })));
        return current;
      });
    const { qc } = renderPage(<PrepPage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Add opponents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an opponent' }), { target: { value: 'newb' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create a profile for Newbie and add it' }));
    await waitFor(() => expect(api().find('POST', '/api/profiles')).toHaveLength(1));
    // While the profile is being created, the chips can't be removed…
    expect((screen.getByRole('button', { name: 'Remove Olga Opponent' }) as HTMLButtonElement).disabled).toBe(true);
    // …and whatever the set became meanwhile (another tab, say) is what the add builds on.
    current = set([PAVEL]);
    qc.setQueryData(['prep', 3], current);
    release();
    await waitFor(() => expect(api().find('PUT', '/api/prep/3')).toHaveLength(1));
    expect(api().find('PUT', '/api/prep/3')[0]!.body).toEqual({ profileIds: [12, 33] });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Remove Pavel Peer' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows every period, describes date ranges, and drops filters a report does not use', async () => {
    base();
    const { location } = renderPage(<PrepPage />, { route: '/prep/:id', path: '/prep/3?period=24h&color=white&outcome=l&plies=12' });
    await screen.findByRole('heading', { name: 'Olga Opponent' });
    expect((screen.getByLabelText('Period') as HTMLSelectElement).value).toBe('24h');
    await waitFor(() => expect(location()).toBe('/prep/3?plies=12&period=24h'));
    const sent = api().find('GET', '/api/prep/3/report').at(-1)!.query;
    expect([sent.get('period'), sent.get('color'), sent.get('outcome')]).toEqual(['24h', null, null]);
    expect(document.querySelector('.lib-prep-printhead')!.textContent).toContain('Last 24 hours · lines of 6 moves');
  });

  it('keeps a from/to range from a link and says it', async () => {
    base();
    renderPage(<PrepPage />, { route: '/prep/:id', path: '/prep/3?from=2026-01-01&to=2026-06-30' });
    await screen.findByRole('heading', { name: 'Olga Opponent' });
    const period = screen.getByLabelText('Period') as HTMLSelectElement;
    expect(period.selectedOptions[0]!.textContent).toBe('2026-01-01 to 2026-06-30');
    const sent = api().find('GET', '/api/prep/3/report').at(-1)!.query;
    expect([sent.get('from'), sent.get('to')]).toEqual(['2026-01-01', '2026-06-30']);
    // Picking a preset replaces the range.
    fireEvent.change(period, { target: { value: '3m' } });
    await waitFor(() => expect(api().find('GET', '/api/prep/3/report').at(-1)!.query.get('period')).toBe('3m'));
    expect(api().find('GET', '/api/prep/3/report').at(-1)!.query.get('from')).toBeNull();
  });

  it('does not refetch a set it just deleted', async () => {
    base();
    api().on('DELETE', '/api/prep/3', { ok: true });
    const { location, qc } = renderPage(<PrepPage />, ROUTE);
    await screen.findByRole('heading', { name: 'Olga Opponent' });
    const before = api().find('GET', /^\/api\/prep\/3(\/report)?$/).length;
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete set' }));
    await waitFor(() => expect(location()).toBe('/prep'));
    await new Promise(r => setTimeout(r, 50));
    expect(api().find('GET', /^\/api\/prep\/3(\/report)?$/).length).toBe(before);
    await waitFor(() => expect(qc.getQueryCache().findAll({ queryKey: ['prep', 3] })).toHaveLength(0));
  });

  it('renames, prints and deletes the set', async () => {
    let current = set();
    base(() => current);
    api()
      .on('PUT', '/api/prep/3', req => {
        current = { ...current, ...(req.body as { name: string }) };
        return current;
      })
      .on('DELETE', '/api/prep/3', { ok: true });
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const { location } = renderPage(<PrepPage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Set name'), { target: { value: 'Open 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: /Open 2026/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete set' }));
    await waitFor(() => expect(location()).toBe('/prep'));
  });

  it('explains opponents without games', async () => {
    base(undefined, () => report([{ ...oppReport(), asWhite: { games: 0, wdl: { w: 0, d: 0, l: 0 }, topLines: [], worstLines: [] }, asBlack: { games: 0, wdl: { w: 0, d: 0, l: 0 }, topLines: [], worstLines: [] }, recentGames: [] }]));
    renderPage(<PrepPage />, ROUTE);
    expect(await screen.findByText(/No games match these filters/)).toBeTruthy();
    expect(screen.queryByText('Main lines')).toBeNull();
  });

  it('shows a report error with retry', async () => {
    base();
    api().on('GET', '/api/prep/3/report', apiError(500, 'internal', 'stats exploded'));
    renderPage(<PrepPage />, ROUTE);
    expect(await screen.findByText('Could not build the report')).toBeTruthy();
    expect(screen.getByText('stats exploded')).toBeTruthy();
  });

  it('handles a missing set', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/prep/3', apiError(404, 'not_found'));
    renderPage(<PrepPage />, ROUTE);
    expect(await screen.findByText("This prep set doesn't exist (or isn't yours).")).toBeTruthy();
  });
});

describe('prep helpers', () => {
  it('describes filters in words', () => {
    expect(describeFilters({})).toBe('All time');
    expect(describeFilters({ period: '3m', tc: ['bullet'], rated: 'unrated' })).toBe('Last 3 months · Bullet · casual only');
    expect(describeFilters({ period: '24h' })).toBe('Last 24 hours');
    expect(describeFilters({ from: '2026-01-01' })).toBe('Since 2026-01-01');
    expect(describeFilters({ to: '2026-02-01', color: 'white', outcome: ['w'] })).toBe('Until 2026-02-01');
    expect(describeFilters({ from: '2026-03-04', to: '2026-03-04' })).toBe('On 2026-03-04');
  });

  it('finds the busiest hours (wrapping midnight) and weekday', () => {
    expect(busiestHours(cells(24, h => (h === 23 || h <= 2 ? 5 : 0)))).toBe('23:00–03:00');
    expect(busiestHours(cells(24, () => 0))).toBeNull();
    expect(peakIndex(cells(7, d => (d === 6 ? 4 : 1)))).toBe(6);
    expect(peakIndex(cells(7, () => 0))).toBe(-1);
  });
});
