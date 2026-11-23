/**
 * Component tests of the World map, Activity and Rating tabs over the fake API: requests,
 * controls, charts (React-rendered SVG) and their empty / error states.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone } from '../src/app/api/hooks.ts';
import { activity, CHESSCOM_ID, LICHESS_ID, profileHeader, worldMap } from './web-profile-fixtures.ts';
import { renderProfile, searchOf } from './web-profile-render.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SLUG = '/u/test-player';
const api = (rest: string) => `/api/profiles/test-player/${rest}`;
const lastQuery = (calls: Array<{ url: URL }>): URLSearchParams => calls.at(-1)!.url.searchParams;
const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);

// ---------------------------------------------------------------------------
// World map
// ---------------------------------------------------------------------------

describe('World map tab', () => {
  const data = worldMap();

  it('draws the choropleth with a legend, the top countries and the lookup note', async () => {
    const { requests } = renderProfile(`${SLUG}/worldmap`);
    const map = await screen.findByRole('img', { name: 'Opponents by country' });
    // Unfiltered: the World map tab is not a filtered tab.
    expect(requests(api('worldmap'))[0]!.url.search).toBe('');
    const withData = map.querySelectorAll('path.map-country.has-data');
    // Countries with a polygon in the 110m atlas (SG and MT are dots; XK is matched by name).
    expect(withData.length).toBe(data.countries.filter(c => !['SG', 'MT'].includes(c.code)).length);
    expect(map.querySelectorAll('circle.map-dot').length).toBe(2);
    expect(screen.getByLabelText('Games colour scale')).toBeTruthy();
    expect(screen.getByText(`Top 10 countries`)).toBeTruthy();
    const box = screen.getByRole('heading', { name: 'World map' }).closest('section')!;
    expect(within(box).getByText('Countries').previousElementSibling?.textContent).toBe(String(data.countries.length));
    expect(screen.getByText(new RegExp(`${data.unknownGames} games are against opponents whose country is unknown`))).toBeTruthy();
    expect(screen.getByText(/4 opponents are still queued for a country lookup/)).toBeTruthy();
  });

  it('shows a tooltip for a hovered country and highlights a picked one', async () => {
    renderProfile(`${SLUG}/worldmap`);
    const map = await screen.findByRole('img', { name: 'Opponents by country' });
    const norway = [...map.querySelectorAll<SVGPathElement>('path.map-country.has-data')].find(p => p.classList.length > 0)!;
    fireEvent.pointerMove(norway, { clientX: 100, clientY: 100 });
    const tip = await screen.findByRole('status');
    expect(within(tip).getByText('Games')).toBeTruthy();
    expect(within(tip).getByText('Score')).toBeTruthy();
    // Picking a row in the table highlights the country on the map.
    const table = screen.getByText('Top 10 countries').closest('.map-table')!;
    const row = within(table as HTMLElement).getAllByRole('row')[1]!;
    fireEvent.click(row);
    expect(row.className).toContain('selected');
    expect(map.querySelectorAll('.map-country.active, .map-dot.active').length).toBe(1);
  });

  it('switches the colouring and the list view', async () => {
    const { location } = renderProfile(`${SLUG}/worldmap`);
    await screen.findByRole('img', { name: 'Opponents by country' });
    fireEvent.click(screen.getByRole('radio', { name: 'Score' }));
    await waitFor(() => expect(searchOf(location()).get('show')).toBe('score'));
    expect(screen.getByLabelText('Score colour scale')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Played' }));
    expect(await screen.findByText('Not played')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /List/ }));
    await waitFor(() => expect(searchOf(location()).get('view')).toBe('list'));
    expect(screen.queryByRole('img', { name: 'Opponents by country' })).toBeNull();
    // The list has every country, sortable by name.
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(rows().length).toBe(data.countries.length);
    fireEvent.click(screen.getByRole('button', { name: 'Country' }));
    const names = rows().map(r => r.querySelector('td')!.textContent!.trim());
    expect(names).toEqual([...names].sort((a, b) => a.replace(/^\S+\s/, '').localeCompare(b.replace(/^\S+\s/, ''))));
  });

  it('keys every atlas shape uniquely (N. Cyprus and Somaliland share codes)', async () => {
    const error = vi.spyOn(console, 'error');
    try {
      renderProfile(`${SLUG}/worldmap`);
      await screen.findByRole('img', { name: 'Opponents by country' });
      expect(error.mock.calls.filter(c => String(c[0]).includes('same key'))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('picks a country from the list with a real button, and unpicks it', async () => {
    renderProfile(`${SLUG}/worldmap`);
    const map = await screen.findByRole('img', { name: 'Opponents by country' });
    const table = screen.getByText('Top 10 countries').closest('.map-table') as HTMLElement;
    const row = within(table).getAllByRole('row')[1]!;
    // The row itself is not a tab stop: its first cell's button is.
    expect(row.hasAttribute('tabindex')).toBe(false);
    const button = within(row).getByRole('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(row.className).toContain('selected');
    expect(map.querySelectorAll('.map-country.active, .map-dot.active').length).toBe(1);
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(map.querySelectorAll('.map-country.active, .map-dot.active').length).toBe(0);
  });

  it('explains an empty map and errors', async () => {
    renderProfile(`${SLUG}/worldmap`, { patch: { worldmap: () => ({ countries: [], unknownGames: 12, pendingLookups: 30 }) } });
    expect(await screen.findByText('No opponent countries yet')).toBeTruthy();
    expect(screen.getByText(/30 opponents are still queued/)).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    renderProfile(`${SLUG}/worldmap`, { fail: [{ match: /worldmap$/, status: 500, code: 'internal', message: 'Map failed' }] });
    expect(await screen.findByText('Map failed')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

describe('Activity tab', () => {
  it('buckets the last 12 months in the viewer’s zone preference', async () => {
    const { requests } = renderProfile(`${SLUG}/activity`);
    const calendar = await screen.findByRole('img', { name: 'Games per day over the last year' });
    // The fixture user prefers UTC.
    const q = lastQuery(requests(api('activity')));
    expect(q.get('tz')).toBe('UTC');
    expect(q.get('period')).toBe('12m');
    // 53 weeks of days ending today.
    const cells = calendar.querySelectorAll('rect.heat-cell').length;
    expect(cells).toBeGreaterThanOrEqual(365);
    expect(cells).toBeLessThanOrEqual(371);
    expect(screen.getByRole('img', { name: 'Games by hour of day' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Games by weekday' })).toBeTruthy();
    const grid = screen.getByRole('img', { name: 'Games by weekday and hour' });
    expect(grid.querySelectorAll('rect.heat-cell').length).toBe(7 * 24);
    const a = activity({ period: '12m' });
    const total = a.byHour.reduce((n, c) => n + c.games, 0);
    const summary = document.querySelector<HTMLElement>('.activity-summary')!;
    expect(within(summary).getByText('Games').previousElementSibling?.textContent).toBe(fmt(total));
    expect(screen.getByText('Times in UTC.')).toBeTruthy();
  });

  it('switches to the browser’s zone and saves the preference', async () => {
    const { requests } = renderProfile(`${SLUG}/activity`);
    await screen.findByRole('img', { name: 'Games per day over the last year' });
    fireEvent.click(screen.getByRole('radio', { name: 'My time' }));
    await waitFor(() => expect(requests('/api/me/prefs', 'PUT').length).toBe(1));
    expect(requests('/api/me/prefs', 'PUT')[0]!.body).toEqual({ timezone: 'local' });
    await waitFor(() => expect(lastQuery(requests(api('activity'))).get('tz')).toBe(browserTimeZone()));
  });

  it('keeps an anonymous visitor’s zone choice local', async () => {
    const { requests } = renderProfile(`${SLUG}/activity`, { signedIn: false });
    await screen.findByRole('img', { name: 'Games per day over the last year' });
    // Defaults: the browser's zone.
    expect(lastQuery(requests(api('activity'))).get('tz')).toBe(browserTimeZone());
    fireEvent.click(screen.getByRole('radio', { name: 'UTC' }));
    await waitFor(() => expect(lastQuery(requests(api('activity'))).get('tz')).toBe('UTC'));
    expect(requests('/api/me/prefs', 'PUT').length).toBe(0);
  });

  it('covers all time and colours cells by score', async () => {
    const { requests, location } = renderProfile(`${SLUG}/activity`);
    await screen.findByRole('img', { name: 'Games per day over the last year' });
    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => expect(searchOf(location()).get('span')).toBe('all'));
    await waitFor(() => expect(lastQuery(requests(api('activity'))).has('period')).toBe(false));
    const calendarCard = screen.getByRole('heading', { name: 'Last year' }).closest('section')!;
    expect(within(calendarCard).getByLabelText('Games per day colour scale')).toBeTruthy();
    fireEvent.click(within(calendarCard).getByRole('radio', { name: 'Score' }));
    await waitFor(() => expect(within(calendarCard).getByLabelText('Score colour scale')).toBeTruthy());
  });

  it('shows a cell’s numbers on hover', async () => {
    renderProfile(`${SLUG}/activity`);
    const grid = await screen.findByRole('img', { name: 'Games by weekday and hour' });
    fireEvent.pointerEnter(grid.querySelectorAll('rect.heat-cell')[0]!);
    const tip = await within(grid.parentElement!).findByRole('status');
    expect(tip.textContent).toContain('Monday 00:00–00:59');
  });

  it('counts games without a time of day (date-only PGN / OTB games) outside the hour charts', async () => {
    const empty = { games: 0, score: null };
    // Only date-only games: the server leaves them out of byHour and grid, not of the weekdays.
    renderProfile(`${SLUG}/activity`, {
      patch: { activity: r => ({ ...r, byHour: r.byHour.map(() => empty), grid: r.grid.map(row => row.map(() => empty)) }) },
    });
    await screen.findByRole('img', { name: 'Games per day over the last year' });
    const a = activity({ period: '12m' });
    const total = a.byWeekday.reduce((n, c) => n + c.games, 0);
    const summary = document.querySelector<HTMLElement>('.activity-summary')!;
    expect(within(summary).getByText('Games').previousElementSibling?.textContent).toBe(fmt(total));
    expect(within(summary).getByText('Busiest hour').previousElementSibling?.textContent).toBe('–');
    expect(screen.getByText(new RegExp(`${fmt(total)} of these games have a date but no time of day`))).toBeTruthy();
  });

  it('shows the empty state', async () => {
    const empty = { games: 0, score: null };
    renderProfile(`${SLUG}/activity`, {
      patch: {
        activity: r => ({ ...r, days: [], byHour: r.byHour.map(() => empty), byWeekday: r.byWeekday.map(() => empty), grid: r.grid.map(row => row.map(() => empty)) }),
      },
    });
    expect(await screen.findByText('No games in the last 12 months')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

describe('Rating tab', () => {
  it('charts the most played lines and lists the averages', async () => {
    const { requests } = renderProfile(`${SLUG}/rating`);
    const chart = await screen.findByRole('img', { name: 'Rating history' });
    expect(requests(api('rating'))[0]!.url.search).toBe('');
    // Two accounts × four time classes, three lines on at first.
    const lines = screen.getByRole('list', { name: 'Lines' });
    const chips = within(lines).getAllByRole('button');
    expect(chips.length).toBe(8);
    expect(chips.filter(c => c.getAttribute('aria-pressed') === 'true').length).toBe(3);
    expect(chart.querySelectorAll('path.chart-line').length).toBe(3);
    // Switching a line on adds it.
    fireEvent.click(chips.find(c => c.getAttribute('aria-pressed') === 'false')!);
    await waitFor(() => expect(chart.querySelectorAll('path.chart-line').length).toBe(4));
    const averages = screen.getByRole('heading', { name: 'Averages' }).closest('section')!;
    expect(within(averages).getByText('Last 10 games')).toBeTruthy();
    expect(within(averages).getByText(/^All [\d,]+ games$/)).toBeTruthy();
    expect(within(averages).getByText(/don’t compare/)).toBeTruthy();
  });

  it('narrows to one account, time control and range through the filters', async () => {
    const { requests, location } = renderProfile(`${SLUG}/rating`);
    await screen.findByRole('img', { name: 'Rating history' });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: String(CHESSCOM_ID) } });
    await waitFor(() => expect(searchOf(location()).get('src')).toBe(String(CHESSCOM_ID)));
    fireEvent.change(screen.getByLabelText('Time control'), { target: { value: 'blitz' } });
    await waitFor(() => expect(lastQuery(requests(api('rating'))).get('tc')).toBe('blitz'));
    expect(lastQuery(requests(api('rating'))).get('src')).toBe(String(CHESSCOM_ID));
    fireEvent.click(screen.getByRole('radio', { name: '3 months' }));
    await waitFor(() => expect(lastQuery(requests(api('rating'))).get('period')).toBe('3m'));
    // One line left: one account, one time class, and the averages compare like with like.
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Lines' })).getAllByRole('button').length).toBe(1));
    expect(screen.queryByText(/don’t compare/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    await waitFor(() => expect(searchOf(location()).has('period')).toBe(false));
  });

  it('shows a shorter period carried from the filters as the selected range', async () => {
    const { requests, location } = renderProfile(`${SLUG}/rating?period=7d`);
    await screen.findByRole('radiogroup', { name: 'Range' });
    await waitFor(() => expect(lastQuery(requests(api('rating'))).get('period')).toBe('7d'));
    const seven = screen.getByRole('radio', { name: '7 days' });
    expect(seven.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(searchOf(location()).get('period')).toBe('30d'));
    expect(screen.queryByRole('radio', { name: '7 days' })).toBeNull();
  });

  it('switches on the lines with the most games, not the most points', async () => {
    // The server caps points per line, so every line has the same number: the header's game
    // counts decide. Chess.com rapid, Lichess classical and Chess.com bullet are the busiest.
    const games: Record<string, number> = { [`${CHESSCOM_ID}:rapid`]: 900, [`${LICHESS_ID}:classical`]: 800, [`${CHESSCOM_ID}:bullet`]: 700 };
    const base = profileHeader();
    renderProfile(`${SLUG}/rating`, {
      header: { sources: base.sources.map(s => ({ ...s, ratings: s.ratings.map(r => ({ ...r, games: games[`${s.id}:${r.timeClass}`] ?? 10 })) })) },
      patch: { rating: r => ({ ...r, series: r.series.map(x => ({ ...x, points: x.points.slice(0, 4) })) }) },
    });
    await screen.findByRole('img', { name: 'Rating history' });
    const on = within(screen.getByRole('list', { name: 'Lines' }))
      .getAllByRole('button')
      .filter(c => c.getAttribute('aria-pressed') === 'true')
      .map(c => c.textContent);
    expect(on.sort()).toEqual(['TestPlayer · Classical', 'test_player · Bullet', 'test_player · Rapid'].sort());
  });

  it('shows a custom range from the URL and a hover readout', async () => {
    renderProfile(`${SLUG}/rating?from=2026-01-01&to=2026-06-30&src=${LICHESS_ID}`);
    const chart = await screen.findByRole('img', { name: 'Rating history' });
    const custom = screen.getByRole('radio', { name: '2026-01-01 – 2026-06-30' });
    expect(custom.getAttribute('aria-checked')).toBe('true');
    fireEvent.pointerMove(chart, { clientX: 200, clientY: 100 });
    const tip = await within(chart.parentElement!).findByRole('status');
    expect(tip.textContent).toMatch(/\d{4}/);
    expect(chart.querySelector('.chart-crosshair')).not.toBeNull();
    fireEvent.pointerLeave(chart);
    await waitFor(() => expect(chart.querySelector('.chart-crosshair')).toBeNull());
  });

  it('shows empty states', async () => {
    renderProfile(`${SLUG}/rating`, { patch: { rating: () => ({ series: [], averages: [{ n: null, games: 0, avgRating: null, avgOppRating: null, score: null }] }) } });
    expect(await screen.findByText('No rated games in this selection')).toBeTruthy();
    expect(screen.getByText('No games in this selection')).toBeTruthy();
  });
});
