import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityStats, Outcome } from '@outpost/shared/api';
import { API_ROUTES } from '@outpost/shared/api';
import { insertGame } from '../src/chess/store.ts';
import {
  bucketSizeFor,
  isoDateOfDay,
  offsetAt,
  offsetSegments,
  resolveTimeZone,
  weekdayOfDay,
} from '../src/stats/tz.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { createProfile, get } from './stats-fixtures.ts';
import { prng } from './stats-seed.ts';

const H = 3_600_000;

/** Independent oracle: local date, hour and Monday-based weekday of `t` in `tz`, straight from Intl. */
function localParts(t: number, tz: string): { date: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      weekday: 'short',
    })
      .formatToParts(new Date(t))
      .map(p => [p.type, p.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

describe('time-zone helpers', () => {
  it('validates IANA names and keeps aliases', () => {
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(resolveTimeZone('utc')).toBe('UTC');
    expect(resolveTimeZone('europe/oslo')).toBe('Europe/Oslo');
    expect(resolveTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(resolveTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(resolveTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    for (const bad of ['', 'Mars/Olympus', '+05:30', '../etc/passwd', 'Europe/Oslo\u0000', 'x'.repeat(65), 'Europe/Oslo; DROP']) {
      expect(resolveTimeZone(bad), bad).toBeNull();
    }
  });

  it('finds DST changes to the second', () => {
    const segs = offsetSegments('Europe/Oslo', Date.UTC(2025, 0, 1), Date.UTC(2025, 11, 31));
    expect(segs.map(s => [new Date(s.start).toISOString(), s.offset / H])).toEqual([
      ['2025-01-01T00:00:00.000Z', 1],
      ['2025-03-30T01:00:00.000Z', 2],
      ['2025-10-26T01:00:00.000Z', 1],
    ]);
    const ny = offsetSegments('America/New_York', Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31));
    expect(ny.map(s => new Date(s.start).toISOString()).slice(1)).toEqual(['2024-03-10T07:00:00.000Z', '2024-11-03T06:00:00.000Z']);
    expect(offsetAt('Asia/Kathmandu', Date.UTC(2025, 5, 1))).toBe(5.75 * H);
    expect(offsetAt('America/New_York', Date.UTC(1850, 0, 1))).toBe(-(4 * 3600 + 56 * 60 + 2) * 1000); // local mean time
  });

  it('chooses buckets that never straddle a local hour or an offset change', () => {
    const range = [Date.UTC(2020, 0, 1), Date.UTC(2026, 0, 1)] as const;
    expect(bucketSizeFor(offsetSegments('UTC', ...range))).toBe(H);
    expect(bucketSizeFor(offsetSegments('Europe/Oslo', ...range))).toBe(H);
    expect(bucketSizeFor(offsetSegments('Asia/Kolkata', ...range))).toBe(H / 2);
    expect(bucketSizeFor(offsetSegments('Asia/Kathmandu', ...range))).toBe(H / 4);
    expect(bucketSizeFor(offsetSegments('Australia/Lord_Howe', ...range))).toBe(H / 2);
    // Local mean time −4:56:02 until November 1883: gcd(1 h, 17,762 s) = 2 s.
    expect(bucketSizeFor(offsetSegments('America/New_York', Date.UTC(1880, 0, 1), Date.UTC(1890, 0, 1)))).toBe(2000);
  });

  it('dates and weekdays of day indexes, before and after 1970', () => {
    expect(isoDateOfDay(0)).toBe('1970-01-01');
    expect(weekdayOfDay(0)).toBe(3); // Thursday
    expect(isoDateOfDay(-1)).toBe('1969-12-31');
    expect(weekdayOfDay(-1)).toBe(2);
    const d = Math.floor(Date.UTC(1965, 5, 15) / 86_400_000);
    expect([isoDateOfDay(d), weekdayOfDay(d)]).toEqual(['1965-06-15', 1]); // a Tuesday
  });
});

describe('GET /api/profiles/:slug/activity', () => {
  let t: TestApp;
  let cookie: string;
  const instants: Array<{ t: number; outcome: Outcome }> = [];
  const activity = async (tz: string, query = '', slug = 'tzplayer'): Promise<ActivityStats> => {
    const res = await get<ActivityStats>(t, `${API_ROUTES.stats.activity(slug)}?tz=${encodeURIComponent(tz)}${query}`, cookie);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = createUserSession(t.db, { username: 'viewer' }).cookie;
    // `tzedges` holds the hand-picked games only; `tzplayer` holds those plus random ones.
    const edges = createSource(t.db, { kind: 'lichess', key: 'tzedges' });
    const random = createSource(t.db, { kind: 'lichess', key: 'tzrandom' });
    createProfile(t.db, { slug: 'tzedges', ownerUserId: null, sources: [{ id: edges }] });
    createProfile(t.db, { slug: 'tzplayer', ownerUserId: null, sources: [{ id: edges }, { id: random }] });
    let player = 'tzedges';
    const add = (at: number, outcome: Outcome) => {
      instants.push({ t: at, outcome });
      const result = outcome === 'w' ? '1-0' : outcome === 'l' ? '0-1' : '1/2-1/2';
      insertGame(t.db, testGame({ white: { name: player }, black: { name: 'opp' }, result, startedAt: at - 600_000, endedAt: at }));
    };
    // Hand-picked edges: both sides of the 2025 Oslo/New York DST changes, the Kathmandu
    // midnight, a pre-1970 game and the turn of a year.
    add(Date.UTC(2025, 2, 30, 0, 30), 'w'); // Oslo 01:30 CET, Sunday
    add(Date.UTC(2025, 2, 30, 1, 30), 'l'); // Oslo 03:30 CEST
    add(Date.UTC(2025, 9, 26, 0, 30), 'd'); // Oslo 02:30 CEST
    add(Date.UTC(2025, 9, 26, 1, 30), 'w'); // Oslo 02:30 CET (the repeated hour)
    add(Date.UTC(2025, 0, 1, 18, 10), 'w'); // Kathmandu 23:55 Wed 1 Jan
    add(Date.UTC(2025, 0, 1, 18, 20), 'l'); // Kathmandu 00:05 Thu 2 Jan
    add(Date.UTC(1965, 5, 15, 12), 'w'); // Tuesday
    add(Date.UTC(2025, 0, 1, 3), 'd'); // New York 22:00 on 31 Dec 2024
    player = 'tzrandom';
    const rand = prng(7);
    for (let i = 0; i < 300; i++) {
      const at = Date.UTC(1960, 0, 1) + Math.floor(rand() * (Date.UTC(2030, 0, 1) - Date.UTC(1960, 0, 1)));
      add(at, (['w', 'd', 'l'] as const)[Math.floor(rand() * 3)]!);
    }
  });
  afterAll(async () => t.close());

  it('puts the DST edge games in the right local hours', async () => {
    const oslo = await activity('Europe/Oslo', '&from=2025-03-29&to=2025-10-27', 'tzedges');
    expect(oslo.byHour.map(c => c.games)).toEqual(Array.from({ length: 24 }, (_, h) => (h === 1 || h === 3 ? 1 : h === 2 ? 2 : 0)));
    expect(oslo.byHour[2]).toEqual({ games: 2, score: 0.75 });
    expect(oslo.byWeekday[6]!.games).toBe(4); // both changes fall on a Sunday
    expect(oslo.grid[6]![2]).toEqual({ games: 2, score: 0.75 });
    expect(oslo.days[0]).toEqual({ date: '2025-03-30', games: 2, score: 0.5 });
    expect(oslo.days.at(-1)).toEqual({ date: '2025-10-26', games: 2, score: 0.75 });

    const ktm = await activity('Asia/Kathmandu', '&from=2025-01-01&to=2025-01-01', 'tzedges');
    expect(ktm.days).toEqual([
      { date: '2025-01-01', games: 2, score: 0.75 }, // 23:55 (win) and 08:45 (the 03:00 UTC draw)
      { date: '2025-01-02', games: 1, score: 0 }, // 00:05 (loss)
    ]);
    expect(ktm.byHour[23]).toEqual({ games: 1, score: 1 });
    expect(ktm.byHour[0]).toEqual({ games: 1, score: 0 });
    expect(ktm.grid[2]![23]!.games).toBe(1); // Wednesday
    expect(ktm.grid[3]![0]!.games).toBe(1); // Thursday

    const ny = await activity('America/New_York', '&from=2025-01-01&to=2025-01-01', 'tzedges');
    expect(ny.days[0]).toEqual({ date: '2024-12-31', games: 1, score: 0.5 });

    const old = await activity('UTC', '&to=1970-01-01', 'tzedges');
    expect(old.days).toEqual([{ date: '1965-06-15', games: 1, score: 1 }]);
    expect(old.byWeekday[1]).toEqual({ games: 1, score: 1 });
    expect(old.byHour[12]!.games).toBe(1);
  });

  it.each(['UTC', 'Europe/Oslo', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'America/Sao_Paulo', 'Pacific/Chatham'])(
    'matches an Intl oracle for every game in %s',
    async tz => {
      const a = await activity(tz);
      expect(a.tz).toBe(tz);
      const byHour = Array.from({ length: 24 }, () => 0);
      const byWeekday = Array.from({ length: 7 }, () => 0);
      const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
      const days = new Map<string, number>();
      for (const g of instants) {
        const p = localParts(g.t, tz);
        byHour[p.hour]!++;
        byWeekday[p.weekday]!++;
        grid[p.weekday]![p.hour]!++;
        days.set(p.date, (days.get(p.date) ?? 0) + 1);
      }
      expect(a.byHour.map(c => c.games)).toEqual(byHour);
      expect(a.byWeekday.map(c => c.games)).toEqual(byWeekday);
      expect(a.grid.map(r => r.map(c => c.games))).toEqual(grid);
      const sorted = [...days.keys()].sort();
      expect(a.days[0]!.date).toBe(sorted[0]);
      expect(a.days.at(-1)!.date).toBe(sorted.at(-1));
      for (const d of a.days) expect(d.games, d.date).toBe(days.get(d.date) ?? 0);
      // Consecutive calendar days, zeros included.
      for (let i = 1; i < a.days.length; i++) {
        expect(Date.parse(`${a.days[i]!.date}T00:00Z`) - Date.parse(`${a.days[i - 1]!.date}T00:00Z`)).toBe(86_400_000);
      }
      expect(a.days.filter(d => d.games === 0).every(d => d.score === null)).toBe(true);
    },
  );

  it('scores each bucket from the player side', async () => {
    const a = await activity('UTC');
    const total = a.byHour.reduce((s, c) => s + c.games, 0);
    expect(total).toBe(instants.length);
    const pts = instants.reduce((s, g) => s + (g.outcome === 'w' ? 1 : g.outcome === 'd' ? 0.5 : 0), 0);
    const weighted = a.byHour.reduce((s, c) => s + (c.score ?? 0) * c.games, 0);
    expect(weighted).toBeCloseTo(pts, 2);
    expect(a.byHour.every(c => (c.games === 0) === (c.score === null))).toBe(true);
  });

  it('applies the filters', async () => {
    const a = await activity('UTC', '&outcome=w');
    const wins = instants.filter(g => g.outcome === 'w').length;
    expect(a.byWeekday.reduce((s, c) => s + c.games, 0)).toBe(wins);
    expect(a.byWeekday.every(c => c.score === null || c.score === 1)).toBe(true);
  });
});
