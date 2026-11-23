import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActivityStats,
  ApiErrorBody,
  BehaviourStats,
  GamesPage,
  OpeningsResponse,
  OpponentsPage,
  OverviewStats,
  RatingStats,
  WorldMapStats,
} from '@outpost/shared/api';
import { API_ROUTES } from '@outpost/shared/api';
import { writeSettings } from '../src/settings.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAY, get, seedAliceWorld, type AliceWorld } from './stats-fixtures.ts';

const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

describe('stats endpoints on a seeded profile', () => {
  let t: TestApp;
  let w: AliceWorld;
  let cookie: string;
  const url = (kind: keyof typeof API_ROUTES.stats, query = '', slug = 'alice') => `${API_ROUTES.stats[kind](slug)}${query ? `?${query}` : ''}`;

  beforeAll(async () => {
    t = await makeTestApp();
    w = seedAliceWorld(t);
    cookie = w.users.other.cookie;
  });
  afterAll(async () => t.close());

  describe('access', () => {
    it('needs a session unless anonymous browsing is on', async () => {
      expect((await get(t, url('overview'))).status).toBe(401);
      writeSettings(t.db, { anonymousBrowsing: true });
      try {
        expect((await get(t, url('overview'))).status).toBe(200);
        expect((await get(t, url('games', '', 'private-p'))).status).toBe(404);
      } finally {
        writeSettings(t.db, { anonymousBrowsing: false });
      }
    });

    it('hides private profiles from other users but not from the owner or admins', async () => {
      for (const kind of Object.keys(API_ROUTES.stats) as Array<keyof typeof API_ROUTES.stats>) {
        const res = await get<ApiErrorBody>(t, url(kind, '', 'private-p'), cookie);
        expect(res.status, kind).toBe(404);
        expect(res.body?.error.code ?? 'not_found').toBe('not_found');
      }
      expect((await get<GamesPage>(t, url('games', '', 'private-p'), w.users.owner.cookie)).body.total).toBe(1);
      expect((await get<GamesPage>(t, url('games', '', 'private-p'), w.users.admin.cookie)).body.total).toBe(1);
      expect((await get(t, url('games', '', 'no-such-profile'), cookie)).status).toBe(404);
      expect((await get(t, url('games', '', 'Bad_Slug!'), cookie)).status).toBe(400);
    });

    it('counts hidden sources for the owner only', async () => {
      expect((await get<GamesPage>(t, url('games'), cookie)).body.total).toBe(5);
      expect((await get<GamesPage>(t, url('games'), w.users.owner.cookie)).body.total).toBe(6);
      expect((await get<GamesPage>(t, url('games', `src=${w.src.H}`), cookie)).body.total).toBe(0);
      expect((await get<GamesPage>(t, url('games', `src=${w.src.H}`), w.users.owner.cookie)).body.total).toBe(1);
    });

    it('answers 400 for invalid filters and endpoint params', async () => {
      const bad = [
        url('games', 'tc=blitz,hyperbullet'),
        url('games', 'line=e2e5'),
        url('games', 'from=2026-02-30'),
        url('games', 'page=0'),
        url('games', 'pageSize=1000'),
        url('openings', 'side=red'),
        url('openings', 'minMoves=4&maxMoves=2'),
        url('openings', 'maxMoves=0'),
        url('opponents', 'view=famous'),
        url('activity', 'tz=Mars/Olympus'),
        url('activity', 'tz=%2B05:30'),
      ];
      for (const u of bad) {
        const res = await get<ApiErrorBody>(t, u, cookie);
        expect(res.status, u).toBe(400);
        expect(res.body.error.code, u).toBe('validation');
      }
    });
  });

  describe('games', () => {
    it('pages newest first with a W/D/L summary', async () => {
      const { body } = await get<GamesPage>(t, url('games'), cookie);
      expect(body).toMatchObject({ total: 5, page: 1, pageSize: 20, summary: { w: 2, d: 1, l: 2 } });
      expect(body.games.map(g => g.id)).toEqual([w.g.g1, w.g.g2, w.g.g3, w.g.g4, w.g.g5]);
      expect(body.games[0]).toMatchObject({
        sourceId: w.src.A,
        color: 'white',
        outcome: 'w',
        result: '1-0',
        termination: 'resign',
        timeClass: 'blitz',
        rated: true,
        rating: 1500,
        ratingAfter: 1508,
        accuracy: 91.5,
        url: 'https://lichess.org/g1aaaaaa',
        opponent: { name: 'bob', key: 'bob', rating: 1600, kind: 'lichess', country: 'NO', title: null },
        eco: 'C70',
        openingName: 'Ruy Lopez: Morphy Defense',
        plies: 6,
      });
      // dave's cached Chess.com code XE (England) is reported as the country GB.
      expect(body.games[2]!.opponent).toMatchObject({ key: 'dave', kind: 'chesscom', country: 'GB' });
      const page2 =(await get<GamesPage>(t, url('games', 'page=2&pageSize=2'), cookie)).body;
      expect(page2).toMatchObject({ total: 5, page: 2, pageSize: 2 });
      expect(page2.games.map(g => g.id)).toEqual([w.g.g3, w.g.g4]);
      const past = (await get<GamesPage>(t, url('games', 'page=9&pageSize=2'), cookie)).body;
      expect(past).toMatchObject({ total: 5, games: [] });
    });

    it('applies every filter', async () => {
      const ids = async (q: string) => (await get<GamesPage>(t, url('games', q), cookie)).body.games.map(g => g.id);
      expect(await ids('color=black')).toEqual([w.g.g2, w.g.g4]);
      expect(await ids('tc=rapid,blitz')).toEqual([w.g.g1, w.g.g2, w.g.g4, w.g.g5]);
      expect(await ids('rated=unrated')).toEqual([w.g.g3]);
      expect(await ids('outcome=w')).toEqual([w.g.g1, w.g.g5]);
      expect(await ids('opp=200')).toEqual([w.g.g2, w.g.g5]);
      expect(await ids('opp=eq')).toEqual([w.g.g1, w.g.g3, w.g.g4]);
      expect(await ids('oppName=CAR')).toEqual([w.g.g2, w.g.g5]);
      expect(await ids('event=titled')).toEqual([w.g.g4]);
      expect(await ids('line=e2e4,e7e5')).toEqual([w.g.g1, w.g.g4, w.g.g5]);
      expect(await ids('period=7d')).toEqual([w.g.g1, w.g.g2]);
      expect(await ids(`src=${w.src.C}`)).toEqual([w.g.g3, w.g.g4]);
      expect(await ids(`from=${isoDay(w.now - 45 * DAY)}&to=${isoDay(w.now - 5 * DAY)}`)).toEqual([w.g.g3, w.g.g4]);
      expect(await ids('color=white&tc=blitz&outcome=w&line=e2e4')).toEqual([w.g.g1, w.g.g5]);
      const sum = (await get<GamesPage>(t, url('games', 'color=white'), cookie)).body;
      expect(sum).toMatchObject({ total: 3, summary: { w: 2, d: 1, l: 0 } });
    });
  });

  it('overview', async () => {
    const { body: o } = await get<OverviewStats>(t, url('overview'), cookie);
    expect(o.totals).toEqual({ w: 2, d: 1, l: 2, games: 5 });
    expect(o.byColor).toEqual({ white: { w: 2, d: 1, l: 0, games: 3 }, black: { w: 0, d: 0, l: 2, games: 2 } });
    expect(o.timeClasses).toEqual([
      { timeClass: 'bullet', games: 1, w: 0, d: 1, l: 0, ratings: [] },
      {
        timeClass: 'blitz',
        games: 3,
        w: 2,
        d: 0,
        l: 1,
        ratings: [
          { sourceId: w.src.A, rating: 1508 },
          { sourceId: w.src.C, rating: 1390 },
        ],
      },
      { timeClass: 'rapid', games: 1, w: 0, d: 0, l: 1, ratings: [{ sourceId: w.src.A, rating: 1500 }] },
    ]);
    expect(o.terminations).toEqual([
      { termination: 'mate', w: 1, d: 0, l: 1 },
      { termination: 'resign', w: 1, d: 0, l: 0 },
      { termination: 'timeout', w: 0, d: 0, l: 1 },
      { termination: 'repetition', w: 0, d: 1, l: 0 },
    ]);
    expect(o.topOpenings.white.map(r => r.name)).toEqual(['Ruy Lopez: Morphy Defense', 'Ruy Lopez: Closed', "Queen's Gambit Declined"]);
    expect(o.topOpenings.black.map(r => [r.eco, r.games])).toEqual([
      ['B90', 1],
      ['C70', 1],
    ]);
    expect(o.latestGames.map(g => g.id)).toEqual([w.g.g1, w.g.g2, w.g.g3, w.g.g4, w.g.g5]);

    expect(o.activity).toHaveLength(90);
    expect(o.activity.at(-1)!.date).toBe(isoDay(w.now));
    expect(o.activity[0]!.date).toBe(isoDay(w.now - 89 * DAY));
    const active = o.activity.filter(d => d.games > 0);
    expect(active).toEqual([
      { date: isoDay(w.now - 40 * DAY), games: 1, score: 0 },
      { date: isoDay(w.now - 10 * DAY), games: 1, score: 0.5 },
      { date: isoDay(w.now - 3 * DAY), games: 1, score: 0 },
      { date: isoDay(w.now - DAY), games: 1, score: 1 },
    ]);
    expect(o.activity.find(d => d.games === 0)).toEqual({ date: expect.any(String), games: 0, score: null });

    // g5 (400 days ago) is outside the sparkline year.
    expect(o.ratingSparkline).toEqual([
      { sourceId: w.src.A, timeClass: 'blitz', points: [[w.now - DAY, 1508]] },
      { sourceId: w.src.A, timeClass: 'rapid', points: [[w.now - 3 * DAY, 1500]] },
      { sourceId: w.src.C, timeClass: 'blitz', points: [[w.now - 40 * DAY, 1390]] },
    ]);
  });

  it('overview honours the filters', async () => {
    const { body: o } = await get<OverviewStats>(t, url('overview', 'color=black'), cookie);
    expect(o.totals).toEqual({ w: 0, d: 0, l: 2, games: 2 });
    expect(o.byColor.white.games).toBe(0);
    expect(o.topOpenings.white).toEqual([]);
    expect(o.latestGames.map(g => g.id)).toEqual([w.g.g2, w.g.g4]);
    expect(o.ratingSparkline.map(s => s.timeClass)).toEqual(['rapid', 'blitz']);
  });

  it('behaviour', async () => {
    const { body } = await get<BehaviourStats>(t, url('behaviour'), cookie);
    expect(body).toEqual({
      w: [
        { termination: 'mate', count: 1, pct: 50, avgMoves: 5 },
        { termination: 'resign', count: 1, pct: 50, avgMoves: 3 },
      ],
      d: [{ termination: 'repetition', count: 1, pct: 100, avgMoves: 2 }],
      l: [
        { termination: 'mate', count: 1, pct: 50, avgMoves: 5 },
        { termination: 'timeout', count: 1, pct: 50, avgMoves: 3 },
      ],
    });
    const black = (await get<BehaviourStats>(t, url('behaviour', 'color=black'), cookie)).body;
    expect(black).toEqual({ w: [], d: [], l: black.l });
    expect(black.l).toHaveLength(2);
  });

  describe('openings', () => {
    it('groups by classified opening with the book line', async () => {
      const { body } = await get<OpeningsResponse>(t, url('openings'), cookie);
      expect(body.black).toEqual([
        {
          eco: 'B90',
          name: 'Sicilian Defense: Najdorf Variation',
          line: 'e2e4,c7c5,g1f3,d7d6,d2d4,c5d4,f3d4,g8f6,b1c3,a7a6',
          color: 'black',
          games: 1,
          w: 0,
          d: 0,
          l: 1,
          avgPly: 10,
        },
        { eco: 'C70', name: 'Ruy Lopez: Morphy Defense', line: 'e2e4,e7e5,g1f3,b8c6,f1b5,a7a6', color: 'black', games: 1, w: 0, d: 0, l: 1, avgPly: 6 },
      ]);
      expect(body.white.map(r => [r.eco, r.name, r.games])).toEqual([
        ['C70', 'Ruy Lopez: Morphy Defense', 1],
        ['C84', 'Ruy Lopez: Closed', 1],
        ['D30', "Queen's Gambit Declined", 1],
      ]);
      expect((await get<OpeningsResponse>(t, url('openings', 'side=white'), cookie)).body.black).toEqual([]);
      expect((await get<OpeningsResponse>(t, url('openings', 'side=black'), cookie)).body.white).toEqual([]);
    });

    it('re-classifies within maxMoves and drops lines shorter than minMoves', async () => {
      const three = (await get<OpeningsResponse>(t, url('openings', 'maxMoves=3'), cookie)).body;
      expect(three.white.map(r => [r.eco, r.name, r.games, r.w])).toEqual([
        ['C70', 'Ruy Lopez: Morphy Defense', 2, 2],
        ['D30', "Queen's Gambit Declined", 1, 0],
      ]);
      expect(three.black.map(r => [r.eco, r.name, r.line])).toEqual([
        ['B50', 'Sicilian Defense', 'e2e4,c7c5,g1f3,d7d6,d2d4'],
        ['C70', 'Ruy Lopez: Morphy Defense', 'e2e4,e7e5,g1f3,b8c6,f1b5,a7a6'],
      ]);
      const one = (await get<OpeningsResponse>(t, url('openings', 'maxMoves=1'), cookie)).body;
      expect(one.white.map(r => [r.eco, r.name, r.games])).toEqual([
        ['C20', "King's Pawn Game", 2],
        ['D00', "Queen's Pawn Game", 1],
      ]);
      expect(one.black.map(r => [r.eco, r.games])).toEqual([
        ['B20', 1],
        ['C20', 1],
      ]);
      const min3 = (await get<OpeningsResponse>(t, url('openings', 'minMoves=3'), cookie)).body;
      expect(min3.white.map(r => r.eco)).toEqual(['C70', 'C84']);
      // Four moves deep: g5's Closed Ruy Lopez falls back to the 3-move Morphy Defense (too short),
      // g2's Najdorf to the 4-move Sicilian main line (kept).
      const narrow = (await get<OpeningsResponse>(t, url('openings', 'minMoves=4&maxMoves=4'), cookie)).body;
      expect(narrow.white).toEqual([]);
      expect(narrow.black.map(r => [r.eco, r.name, r.line])).toEqual([
        ['B54', 'Sicilian Defense: Modern Variations, Main Line', 'e2e4,c7c5,g1f3,d7d6,d2d4,c5d4,f3d4,g8f6'],
      ]);
    });

    it('needs enough games for best and worst', async () => {
      const best = (await get<OpeningsResponse>(t, url('openings', 'order=best'), cookie)).body;
      expect(best).toEqual({ white: [], black: [] });
      const most = (await get<OpeningsResponse>(t, url('openings', 'minGames=2&maxMoves=3'), cookie)).body;
      expect(most.white.map(r => r.eco)).toEqual(['C70']);
    });
  });

  describe('opponents', () => {
    it('lists most played opponents with cache data and profile links', async () => {
      const { body } = await get<OpponentsPage>(t, url('opponents'), cookie);
      expect(body).toMatchObject({ total: 4, page: 1, pageSize: 20 });
      expect(body.rows.map(r => `${r.kind}:${r.key}`)).toEqual(['lichess:carol', 'lichess:bob', 'chesscom:dave', 'chesscom:bob']);
      expect(body.rows[0]).toEqual({
        key: 'carol',
        name: 'carol',
        kind: 'lichess',
        title: 'GM',
        country: 'US',
        games: 2,
        w: 1,
        d: 0,
        l: 1,
        lastRating: 2500,
        lastPlayed: w.now - 3 * DAY,
        profileSlug: 'carol-gm',
      });
      expect(body.rows[2]).toMatchObject({ key: 'dave', country: 'GB', d: 1, profileSlug: null });
      expect(body.rows[3]).toMatchObject({ key: 'bob', kind: 'chesscom', country: null, lastRating: 1450 });
    });

    it('pages and filters titled opponents', async () => {
      const p2 = (await get<OpponentsPage>(t, url('opponents', 'page=2&pageSize=2'), cookie)).body;
      expect(p2).toMatchObject({ total: 4, page: 2, pageSize: 2 });
      expect(p2.rows.map(r => r.key)).toEqual(['dave', 'bob']);
      const past = (await get<OpponentsPage>(t, url('opponents', 'page=5&pageSize=2'), cookie)).body;
      expect(past).toMatchObject({ total: 4, rows: [] });
      const titled = (await get<OpponentsPage>(t, url('opponents', 'view=titled'), cookie)).body;
      expect(titled.total).toBe(1);
      expect(titled.rows.map(r => r.key)).toEqual(['carol']);
      const filtered = (await get<OpponentsPage>(t, url('opponents', 'color=white'), cookie)).body;
      expect(filtered.rows.map(r => [r.key, r.games, r.lastRating])).toEqual([
        ['bob', 1, 1600],
        ['dave', 1, 1400],
        ['carol', 1, 2450],
      ]);
    });

    it('links an opponent to a private profile only for its owner', async () => {
      // Owner of private-p sees zed's link from carol-gm's opponents (g7: carol vs bob has no zed);
      // use the private profile's game g8 instead: carol-gm does not include it, so check bob.
      const asOwner = (await get<OpponentsPage>(t, url('opponents', '', 'private-p'), w.users.owner.cookie)).body;
      expect(asOwner.rows).toEqual([expect.objectContaining({ key: 'bob', profileSlug: null, w: 0, l: 1 })]);
      const fromCarol = (await get<OpponentsPage>(t, url('opponents', '', 'carol-gm'), w.users.owner.cookie)).body;
      expect(fromCarol.rows.map(r => [r.key, r.profileSlug])).toEqual([
        ['alice', 'alice'],
        ['bob', null],
      ]);
    });
  });

  it('world map', async () => {
    const { body } = await get<WorldMapStats>(t, url('worldmap'), cookie);
    expect(body).toEqual({
      countries: [
        { code: 'US', games: 2, opponents: 1, w: 1, d: 0, l: 1 },
        { code: 'GB', games: 1, opponents: 1, w: 0, d: 1, l: 0 },
        { code: 'NO', games: 1, opponents: 1, w: 1, d: 0, l: 0 },
      ],
      unknownGames: 1,
      pendingLookups: 1,
    });
    // The owner also sees the hidden source's game against erin, queued for a lookup.
    const owner = (await get<WorldMapStats>(t, url('worldmap'), w.users.owner.cookie)).body;
    expect(owner).toMatchObject({ unknownGames: 2, pendingLookups: 2 });
  });

  it('activity in UTC by default', async () => {
    const { body } = await get<ActivityStats>(t, url('activity'), cookie);
    expect(body.tz).toBe('UTC');
    expect(body.days[0]!.date).toBe(isoDay(w.now - 400 * DAY));
    expect(body.days.at(-1)!.date).toBe(isoDay(w.now - DAY));
    expect(body.days).toHaveLength(400);
    expect(body.days.reduce((s, d) => s + d.games, 0)).toBe(5);
    expect(body.byHour).toHaveLength(24);
    expect(body.byHour[new Date(w.now).getUTCHours()]!.games).toBe(5);
    expect(body.byWeekday.reduce((s, c) => s + c.games, 0)).toBe(5);
    expect(body.grid).toHaveLength(7);
    expect(body.grid.every(r => r.length === 24)).toBe(true);
    const tz = (await get<ActivityStats>(t, url('activity', 'tz=europe/oslo'), cookie)).body;
    expect(tz.tz).toBe('Europe/Oslo');
    expect((await get<ActivityStats>(t, url('activity', 'tz='), cookie)).body.tz).toBe('UTC');
    expect((await get<ActivityStats>(t, url('activity', 'tz=%20Asia/Tokyo%20'), cookie)).body.tz).toBe('Asia/Tokyo');
  });

  it('rating history and averages', async () => {
    const { body } = await get<RatingStats>(t, url('rating'), cookie);
    expect(body.series).toEqual([
      {
        sourceId: w.src.A,
        timeClass: 'blitz',
        points: [
          [w.now - 400 * DAY, 1460],
          [w.now - DAY, 1508],
        ],
      },
      { sourceId: w.src.A, timeClass: 'rapid', points: [[w.now - 3 * DAY, 1500]] },
      { sourceId: w.src.C, timeClass: 'blitz', points: [[w.now - 40 * DAY, 1390]] },
    ]);
    expect(body.averages).toEqual([{ n: null, games: 5, avgRating: 1452, avgOppRating: 1880, score: 0.5 }]);
    const narrowed = (await get<RatingStats>(t, url('rating', `src=${w.src.A}&tc=blitz`), cookie)).body;
    expect(narrowed.series).toHaveLength(1);
    expect(narrowed.averages).toEqual([{ n: null, games: 2, avgRating: 1475, avgOppRating: 2025, score: 1 }]);
  });
});

describe('stats endpoints on an empty profile', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    const w = seedAliceWorld(t);
    cookie = w.users.other.cookie;
    t.db.run("INSERT INTO profiles (slug, display_name, visibility, created_at, updated_at) VALUES ('nobody', 'Nobody', 'public', 0, 0)");
  });
  afterAll(async () => t.close());

  it('answers zeros, never errors', async () => {
    for (const slug of ['nobody', 'alice']) {
      const q = slug === 'alice' ? '?period=24h&tc=correspondence' : '';
      const o = (await get<OverviewStats>(t, `${API_ROUTES.stats.overview(slug)}${q}`, cookie)).body;
      expect(o.totals).toEqual({ w: 0, d: 0, l: 0, games: 0 });
      expect(o.timeClasses).toEqual([]);
      expect(o.activity).toHaveLength(90);
      expect(o.latestGames).toEqual([]);
      expect(o.ratingSparkline).toEqual([]);
      expect((await get<GamesPage>(t, `${API_ROUTES.stats.games(slug)}${q}`, cookie)).body).toEqual({
        total: 0,
        page: 1,
        pageSize: 20,
        summary: { w: 0, d: 0, l: 0 },
        games: [],
      });
      expect((await get(t, `${API_ROUTES.stats.openings(slug)}${q}`, cookie)).body).toEqual({ white: [], black: [] });
      expect((await get(t, `${API_ROUTES.stats.opponents(slug)}${q}`, cookie)).body).toEqual({ total: 0, page: 1, pageSize: 20, rows: [] });
      expect((await get(t, `${API_ROUTES.stats.behaviour(slug)}${q}`, cookie)).body).toEqual({ w: [], d: [], l: [] });
      expect((await get(t, `${API_ROUTES.stats.worldmap(slug)}${q}`, cookie)).body).toEqual({ countries: [], unknownGames: 0, pendingLookups: 0 });
      const a = (await get<ActivityStats>(t, `${API_ROUTES.stats.activity(slug)}${q}`, cookie)).body;
      expect(a.days).toEqual([]);
      expect(a.byHour.every(c => c.games === 0 && c.score === null)).toBe(true);
      expect((await get(t, `${API_ROUTES.stats.rating(slug)}${q}`, cookie)).body).toEqual({
        series: [],
        averages: [{ n: null, games: 0, avgRating: null, avgOppRating: null, score: null }],
      });
      const pgn = await get(t, `${API_ROUTES.stats.gamesPgn(slug)}${q}`, cookie);
      expect(pgn.status).toBe(200);
      expect(pgn.text).toBe('');
      expect(pgn.headers['x-outpost-total']).toBe('0');
    }
  });
});
