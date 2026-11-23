import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityStats, Outcome } from '@outpost/shared/api';
import { API_ROUTES } from '@outpost/shared/api';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { ACTIVITY_MAX_DAYS, ACTIVITY_MIN_MS, activityDays, type LocalActivity } from '../src/stats/activity.ts';
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
  it('validates IANA names and gives each one spelling, whatever the casing', () => {
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(resolveTimeZone('utc')).toBe('UTC');
    expect(resolveTimeZone('europe/oslo')).toBe('Europe/Oslo');
    expect(resolveTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    expect(resolveTimeZone('etc/gmt+5')).toBe('Etc/GMT+5');
    // Current IANA names that ICU only knows as aliases keep their own spelling in any casing.
    for (const tz of ['Asia/Kolkata', 'asia/kolkata', 'ASIA/KOLKATA']) expect(resolveTimeZone(tz), tz).toBe('Asia/Kolkata');
    for (const tz of ['Europe/Kyiv', 'europe/kyiv']) expect(resolveTimeZone(tz), tz).toBe('Europe/Kyiv');
    expect(resolveTimeZone('america/argentina/buenos_aires')).toBe('America/Argentina/Buenos_Aires');
    // ICU's own names stay as they are; legacy aliases become the zone they point to.
    for (const tz of ['Asia/Calcutta', 'asia/calcutta']) expect(resolveTimeZone(tz), tz).toBe('Asia/Calcutta');
    for (const tz of ['europe/kiev', 'EUROPE/KIEV']) expect(resolveTimeZone(tz), tz).toBe('Europe/Kiev');
    for (const tz of ['US/Eastern', 'us/eastern', 'US/EASTERN']) expect(resolveTimeZone(tz), tz).toBe('America/New_York');
    for (const tz of ['Etc/UTC', 'etc/utc', 'GMT']) expect(resolveTimeZone(tz), tz).toBe('UTC');
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

  it('caps `days` at ACTIVITY_MAX_DAYS, starting at the first game inside the window', () => {
    const local = (...dayIndexes: number[]): LocalActivity => ({
      days: new Map(dayIndexes.map(d => [d, { games: 1, w: 1, d: 0 }])),
      minDay: Math.min(...dayIndexes),
      maxDay: Math.max(...dayIndexes),
      byHour: [],
      byWeekday: [],
      grid: [],
    });
    const last = 20_000;
    expect(activityDays(local(last - ACTIVITY_MAX_DAYS + 1, last))).toHaveLength(ACTIVITY_MAX_DAYS);
    const capped = activityDays(local(-200_000, last - ACTIVITY_MAX_DAYS, last - 30, last));
    expect(capped).toHaveLength(31);
    expect(capped[0]).toEqual({ date: isoDateOfDay(last - 30), games: 1, score: 1 });
    expect(activityDays(local(last))).toEqual([{ date: isoDateOfDay(last), games: 1, score: 1 }]);
    expect(activityDays({ ...local(1), days: new Map(), minDay: null, maxDay: null })).toEqual([]);
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
      // 1960–2026: older than the 40 years of precomputed offsets, so both paths are checked.
      const at = Date.UTC(1960, 0, 1) + Math.floor(rand() * (Date.UTC(2026, 0, 1) - Date.UTC(1960, 0, 1)));
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
      // `days` starts at the first game of the last ACTIVITY_MAX_DAYS of the 66 years; the hour
      // charts keep every game.
      const lastDay = Date.parse(`${sorted.at(-1)}T00:00Z`) / 86_400_000;
      const windowStart = isoDateOfDay(lastDay - ACTIVITY_MAX_DAYS + 1);
      expect(a.days[0]!.date).toBe(sorted.find(d => d >= windowStart));
      expect(sorted[0]! < a.days[0]!.date).toBe(true);
      expect(a.days.length).toBeLessThanOrEqual(ACTIVITY_MAX_DAYS);
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

  it('keeps date-only PGN games on their written date and out of the hour charts', async () => {
    const dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('OTB', 'games', 0)").lastInsertRowid;
    const src = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(dbId, 'Otb Player'), databaseId: dbId });
    createProfile(t.db, { slug: 'otb', ownerUserId: null, sources: [{ id: src }] });
    const otb = (originId: string, endedAt: number, result: '1-0' | '0-1', black = 'Rival') =>
      insertGame(
        t.db,
        testGame({ origin: 'pgn', originId: `${dbId}:${originId}`, databaseId: dbId, white: { name: 'Otb Player' }, black: { name: black }, result, startedAt: endedAt, endedAt, timeClass: 'unknown', rated: false }),
      );
    otb('d1', Date.UTC(2024, 2, 10), '1-0'); // [Date "2024.03.10"], a Sunday, no time
    otb('d2', Date.UTC(2024, 2, 10), '0-1', 'Other');
    otb('t1', Date.UTC(2024, 2, 11, 2, 30), '1-0'); // [UTCTime "02:30:00"]: New York 22:30 on the 10th (EDT)
    for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
      const a = await activity(tz, '', 'otb');
      expect(a.byHour.reduce((s, c) => s + c.games, 0), tz).toBe(1);
      expect(a.grid.flat().reduce((s, c) => s + c.games, 0), tz).toBe(1);
      expect(a.byWeekday.reduce((s, c) => s + c.games, 0), tz).toBe(3);
      expect(a.days[0], tz).toEqual({ date: '2024-03-10', games: tz === 'America/New_York' ? 3 : 2, score: tz === 'America/New_York' ? 0.6667 : 0.5 });
    }
    const ny = await activity('America/New_York', '', 'otb');
    expect(ny.days).toHaveLength(1);
    expect(ny.byHour[22]).toEqual({ games: 1, score: 1 });
    expect(ny.byWeekday[6]).toEqual({ games: 3, score: 0.6667 });
    const utc = await activity('UTC', '', 'otb');
    expect(utc.days.map(d => [d.date, d.games])).toEqual([
      ['2024-03-10', 2],
      ['2024-03-11', 1],
    ]);
    expect(utc.byHour[2]!.games).toBe(1);
    expect(utc.byHour[0]!.games).toBe(0);
  });

  it('keeps a short history whole', async () => {
    const a = await activity('Europe/Oslo', '&from=2020-01-01');
    const inRange = instants.filter(g => g.t >= Date.UTC(2020, 0, 1)); // `from` is a UTC day
    const first = inRange.reduce((m, g) => Math.min(m, g.t), Infinity);
    expect(a.days[0]!.date).toBe(localParts(first, 'Europe/Oslo').date);
    expect(a.days.reduce((s, d) => s + d.games, 0)).toBe(inRange.length);
    expect(a.byHour.reduce((s, c) => s + c.games, 0)).toBe(inRange.length);
  });

  it('applies the filters', async () => {
    const a = await activity('UTC', '&outcome=w');
    const wins = instants.filter(g => g.outcome === 'w').length;
    expect(a.byWeekday.reduce((s, c) => s + c.games, 0)).toBe(wins);
    expect(a.byWeekday.every(c => c.score === null || c.score === 1)).toBe(true);
  });
});

describe('activity with implausible dates', () => {
  let t: TestApp;
  let cookie: string;
  const now = Date.now();
  const activity = async (slug: string, tz: string): Promise<{ body: ActivityStats; ms: number; bytes: number }> => {
    const start = performance.now();
    const res = await get<ActivityStats>(t, `${API_ROUTES.stats.activity(slug)}?tz=${encodeURIComponent(tz)}`, cookie);
    const ms = performance.now() - start;
    expect(res.status).toBe(200);
    return { body: res.body, ms, bytes: res.text.length };
  };
  const total = (cells: Array<{ games: number }>) => cells.reduce((s, c) => s + c.games, 0);

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = createUserSession(t.db, { username: 'viewer' }).cookie;
    const profile = (slug: string, dates: number[]) => {
      const src = createSource(t.db, { kind: 'lichess', key: slug });
      createProfile(t.db, { slug, ownerUserId: null, sources: [{ id: src }] });
      for (const [i, at] of dates.entries()) {
        insertGame(t.db, testGame({ white: { name: slug }, black: { name: `opp${i}` }, result: '1-0', startedAt: at - 600_000, endedAt: at }));
      }
    };
    // Typo'd or placeholder dates around two real games, a game an hour ago and one dated 1400.
    profile('typos', [
      Date.UTC(9999, 11, 31, 12),
      Date.UTC(3000, 0, 1, 12),
      now + 2 * 86_400_000,
      Date.UTC(1000, 0, 1, 12),
      ACTIVITY_MIN_MS - 1,
      ACTIVITY_MIN_MS + 12 * H,
      Date.UTC(2026, 5, 1, 12),
      Date.UTC(2026, 5, 2, 13),
      now - H,
    ]);
    profile('future-only', [Date.UTC(9999, 0, 1), now + 3 * 86_400_000]);
    profile('historic', [Date.UTC(1880, 4, 1, 15, 30), Date.UTC(2025, 0, 1, 9), Date.UTC(2025, 6, 1, 21)]);
  });
  afterAll(async () => t.close());

  it.each(['Europe/Oslo', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Chatham', 'UTC'])(
    'ignores dates before 1400 or after tomorrow and stays small and fast in %s',
    async tz => {
      const { body, ms, bytes } = await activity('typos', tz);
      expect(total(body.byHour)).toBe(4);
      expect(total(body.byWeekday)).toBe(4);
      expect(total(body.grid.flat())).toBe(4);
      // 1400 to today is far more than 40 years: `days` starts at the first game of the last 40.
      expect(body.days[0]!.date).toBe(localParts(Date.UTC(2026, 5, 1, 12), tz).date);
      expect(body.days.at(-1)!.date).toBe(localParts(now - H, tz).date);
      expect(total(body.days)).toBe(3);
      expect(bytes).toBeLessThan(1_000_000);
      expect(ms).toBeLessThan(1500); // was ~8 s with the year-9999 game before the bounds
      // The 1400 game counts at its local-mean-time hour.
      const old = localParts(ACTIVITY_MIN_MS + 12 * H, tz);
      expect(body.grid[old.weekday]![old.hour]!.games).toBeGreaterThanOrEqual(1);
    },
  );

  it('returns an empty activity when every date is implausible', async () => {
    const { body } = await activity('future-only', 'Europe/Oslo');
    expect(body.days).toEqual([]);
    expect(total(body.byHour)).toBe(0);
    expect(body.byWeekday.every(c => c.games === 0 && c.score === null)).toBe(true);
  });

  it('counts historical games exactly but keeps `days` to the recent span', async () => {
    for (const tz of ['America/New_York', 'Europe/Oslo']) {
      const { body } = await activity('historic', tz);
      expect(body.days[0]!.date, tz).toBe(localParts(Date.UTC(2025, 0, 1, 9), tz).date);
      expect(total(body.days), tz).toBe(2);
      const p = localParts(Date.UTC(1880, 4, 1, 15, 30), tz); // local mean time: 10:33 in New York, 16:13 in Oslo
      expect(body.grid[p.weekday]![p.hour], tz).toEqual({ games: 1, score: 1 });
      expect(total(body.byHour), tz).toBe(3);
    }
  });
});
