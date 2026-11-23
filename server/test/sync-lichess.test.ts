import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSettings } from '../src/settings.ts';
import { UpstreamError } from '../src/http/upstream.ts';
import {
  initialCutoff,
  lichessSnapshot,
  mapLichessGame,
  parseSourceProfile,
  syncHandler,
  type LichessGame,
  type LichessUser,
} from '../src/sync/index.ts';
import { createSource, makeJobContext, makeTestApp, type TestApp } from './helpers.ts';
import { fakeFetch, fixtureJson, fixtureNdjson, jsonResponse, ndjsonResponse, statusResponse, type FakeFetch } from './sync-fakes.ts';

const GAMES = fixtureNdjson<LichessGame>('lichess/synthplayer-games.ndjson');
const IDS_EXPORT = fixtureNdjson<LichessGame>('lichess/synthplayer-ids-export.ndjson');
const USER = fixtureJson<LichessUser>('lichess/synthplayer-user.json');
const byId = (id: string): LichessGame => GAMES.find(g => g.id === id)!;

describe('mapLichessGame', () => {
  it('maps a rated game with pre-game ratings, rating after, accuracy and headers', () => {
    const g = mapLichessGame(byId('synth001'));
    if ('skip' in g) throw new Error(g.skip);
    expect(g).toMatchObject({
      origin: 'lichess',
      originId: 'synth001',
      url: 'https://lichess.org/synth001',
      white: { name: 'SynthPlayer', rating: 2100, ratingAfter: 2108, title: 'FM', accuracy: 91 },
      black: { name: 'SynthRival', rating: 2200, ratingAfter: 2192, title: 'IM', accuracy: 42 },
      result: '1-0',
      termination: 'mate',
      timeClass: 'blitz',
      timeControl: '180+2',
      rated: true,
      event: 'Rated Blitz game',
      moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'],
    });
    expect(g.endedAt! - g.startedAt!).toBe(300_000);
    expect(g.headers).toMatchObject({
      Site: 'https://lichess.org/synth001',
      WhiteElo: '2100',
      WhiteRatingDiff: '+8',
      BlackRatingDiff: '-8',
      WhiteTitle: 'FM',
      ECO: 'C23',
      Termination: 'Normal',
      TimeControl: '180+2',
    });
  });

  it('folds UltraBullet into bullet and names arenas', () => {
    const g = mapLichessGame(byId('synth002'));
    if ('skip' in g) throw new Error(g.skip);
    expect(g).toMatchObject({ timeClass: 'bullet', timeControl: '15+0', result: '0-1', termination: 'resign', event: 'Synthetic UltraBullet Arena' });
  });

  it('tells draws apart from the final position', () => {
    const rep = mapLichessGame(byId('synth003'));
    const agreed = mapLichessGame(byId('synth004'));
    expect('skip' in rep ? rep : rep.termination).toBe('repetition');
    expect('skip' in agreed ? agreed : agreed.termination).toBe('agreement');
  });

  it('maps time forfeits, abandoned games, correspondence and casual games', () => {
    const term = (id: string): unknown => {
      const g = mapLichessGame(byId(id));
      return 'skip' in g ? g.skip : [g.result, g.termination, g.timeClass, g.timeControl, g.rated];
    };
    expect(term('synth005')).toEqual(['0-1', 'timeout', 'bullet', '60+0', true]);
    expect(term('synth006')).toEqual(['1/2-1/2', 'timeout_vs_insufficient', 'bullet', '60+0', true]);
    expect(term('synth007')).toEqual(['1-0', 'abandon', 'blitz', '300+0', true]);
    expect(term('synth014')).toEqual(['0-1', 'resign', 'correspondence', '1/259200', true]);
    expect(term('synth015')).toEqual(['1/2-1/2', 'stalemate', 'rapid', '600+5', false]);
    const casual = mapLichessGame(byId('synth015'));
    if ('skip' in casual) throw new Error(casual.skip);
    expect(casual.white).toMatchObject({ rating: 1500, ratingAfter: null });
    expect(casual.event).toBe('Casual Rapid game');
    const swiss = mapLichessGame(byId('synth016'));
    expect('skip' in swiss ? swiss : swiss.event).toBe('Rated Classical swiss');
  });

  it('skips variants, set-up positions, AI, anonymous, aborted and ongoing games', () => {
    const skip = (id: string): unknown => {
      const g = mapLichessGame(byId(id));
      return 'skip' in g ? g.skip : null;
    };
    expect(skip('synth008')).toBe('variant');
    expect(skip('synth009')).toBe('fromPosition');
    expect(skip('synth010')).toBe('ai');
    expect(skip('synth011')).toBe('anonymous');
    expect(skip('synth012')).toBe('noResult');
    expect(skip('synth013')).toBe('ongoing');
  });
});

describe('lichessSnapshot', () => {
  it('keeps played perfs, ultraBullet apart, the FIDE rating and the country of a regional flag', () => {
    const s = lichessSnapshot(USER, 1000);
    expect(s).toMatchObject({ username: 'SynthPlayer', userId: 'synthplayer', title: 'FM', country: 'GB', countryRaw: 'GB-SCT' });
    expect(s.ratings.map(r => [r.timeClass, r.rating, r.provisional])).toEqual([
      ['bullet', 2044, false],
      ['blitz', 2108, false],
      ['classical', 1912, true],
      ['correspondence', 1807, false],
    ]);
    expect(s.extraRatings.ultraBullet).toMatchObject({ rating: 1705, games: 30 });
    expect(s.fide).toEqual({ standard: 2050, rapid: null, blitz: null });
  });
});

describe('Lichess sync', () => {
  let t: TestApp;
  let fake: FakeFetch;
  let games: LichessGame[];
  let user: LichessUser | null;
  let streamOpts: { failAfter?: number };
  let idsExport: LichessGame[];
  let idsOpts: { failAfter?: number };

  beforeEach(async () => {
    games = GAMES;
    user = USER;
    streamOpts = {};
    idsExport = IDS_EXPORT;
    idsOpts = {};
    fake = fakeFetch([
      ['lichess.org/api/user/synthplayer', () => (user ? jsonResponse(user) : statusResponse(404))],
      [
        'lichess.org/api/games/user/synthplayer',
        url => {
          const since = Number(url.searchParams.get('since') ?? 0);
          const max = Number(url.searchParams.get('max') ?? Infinity);
          return ndjsonResponse(games.filter(g => (g.createdAt ?? 0) >= since).slice(0, max), streamOpts);
        },
      ],
      [
        'lichess.org/api/games/export/_ids',
        (_url, call) => {
          const ids = new Set((call.body ?? '').split(','));
          return ndjsonResponse(idsExport.filter(g => ids.has(g.id)), idsOpts);
        },
      ],
    ]);
    t = await makeTestApp({ fetch: fake.fetch });
  });
  afterEach(async () => t.close());

  const run = async (sourceId: number, opts: { full?: boolean } = {}) => {
    const { ctx, updates } = makeJobContext(t, 'sync', opts.full ? { sourceId, full: true } : { sourceId });
    await syncHandler(ctx);
    return updates;
  };

  it('imports the standard games, updates the source and remembers ongoing games', async () => {
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    const updates = await run(id);

    const call = fake.callsTo('/api/games/user/synthplayer')[0]!;
    expect(call.headers.get('accept')).toBe('application/x-ndjson');
    expect(call.headers.get('user-agent')).toMatch(/^Outpost\//);
    expect(Object.fromEntries(call.url.searchParams)).toMatchObject({
      sort: 'dateAsc',
      opening: 'true',
      accuracy: 'true',
      moves: 'true',
      ongoing: 'true',
      perfType: 'ultraBullet,bullet,blitz,rapid,classical,correspondence',
    });
    expect(call.url.searchParams.has('since')).toBe(false); // initialSyncMonths = 0: everything

    const src = t.db.get<Record<string, unknown>>('SELECT * FROM sources WHERE id = ?', [id])!;
    expect(src).toMatchObject({ display_name: 'SynthPlayer', site_user_id: 'synthplayer', title: 'FM', country: 'GB', last_sync_error: null });
    expect(src.last_synced_at).toBeTypeOf('number');
    expect(parseSourceProfile(src.profile_json as string)?.ratings).toHaveLength(4);
    const state = JSON.parse(src.sync_state_json as string);
    expect(state).toEqual({ v: 1, since: GAMES.at(-1)!.createdAt! + 1, pendingIds: ['synth013'] });

    // 16 lines: 10 stored, 5 skipped (960, from position, AI, anonymous, aborted), 1 ongoing.
    expect(updates.at(-1)).toMatchObject({ done: 16, counts: { imported: 10, duplicates: 0, skipped: 5, ongoing: 1 } });
    const rows = t.db.all<{ origin_id: string; color: string; outcome: string; rating: number; rating_after: number | null; time_class: string }>(
      `SELECT g.origin_id, pg.color, pg.outcome, pg.rating, pg.rating_after, pg.time_class
         FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE pg.source_id = ? ORDER BY pg.ended_at`,
      [id],
    );
    expect(rows.map(r => r.origin_id)).toEqual(['synth001', 'synth002', 'synth003', 'synth004', 'synth005', 'synth006', 'synth007', 'synth014', 'synth015', 'synth016']);
    expect(rows[0]).toMatchObject({ color: 'w', outcome: 'w', rating: 2100, rating_after: 2108, time_class: 'blitz' });
    expect(rows[1]).toMatchObject({ color: 'b', outcome: 'w', rating: 1700, rating_after: 1705, time_class: 'bullet' });
    const titles = t.db.get('SELECT opp_title, opp_source_kind FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE g.origin_id = ?', ['synth001']);
    expect(titles).toEqual({ opp_title: 'IM', opp_source_kind: 'lichess' });

    // Own players_cache row from the profile; opponents queued for a geo lookup.
    expect(t.db.get("SELECT country, title, fetched_at IS NOT NULL AS fetched FROM players_cache WHERE kind = 'lichess' AND key = 'synthplayer'")).toEqual({
      country: 'GB',
      title: 'FM',
      fetched: 1,
    });
    expect(t.db.all("SELECT key FROM players_cache WHERE kind = 'lichess' AND fetched_at IS NULL ORDER BY key").map(r => r.key)).toEqual([
      'examplefoe',
      'samplepal',
      'synthrival',
    ]);
    expect(t.db.get("SELECT kind, lane, status, priority, dedupe_key FROM jobs WHERE kind = 'geo'")).toEqual({
      kind: 'geo',
      lane: 'lichess',
      status: 'queued',
      priority: -10,
      dedupe_key: 'geo:lichess',
    });
  });

  it('continues from the cursor and re-checks games that were ongoing', async () => {
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    await run(id);
    const updates = await run(id);
    const idsCall = fake.callsTo('/api/games/export/_ids')[0]!;
    expect(idsCall.method).toBe('POST');
    expect(idsCall.body).toBe('synth013');
    const second = fake.callsTo('/api/games/user/synthplayer')[1]!;
    expect(Number(second.url.searchParams.get('since'))).toBe(GAMES.at(-1)!.createdAt! + 1);
    expect(updates.at(-1)?.counts).toMatchObject({ imported: 1, skipped: 0, ongoing: 0 });
    expect(t.db.get("SELECT result, termination, time_class FROM games WHERE origin_id = 'synth013'")).toEqual({
      result: '1-0',
      termination: 'resign',
      time_class: 'correspondence',
    });
    expect(JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!).pendingIds).toEqual([]);
  });

  it('keeps games still in progress pending until Lichess reports them finished or forgets them', async () => {
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    const base = IDS_EXPORT[0]!;
    const ids = Array.from({ length: 150 }, (_, i) => `pend${String(i).padStart(4, '0')}`);
    idsExport = ids.map((gid, i) => ({ ...base, id: gid, createdAt: base.createdAt! + i }));
    games = [];
    const saveState = (pendingIds: string[]) =>
      t.db.run('UPDATE sources SET sync_state_json = ? WHERE id = ?', [JSON.stringify({ v: 1, since: 1793600000000, pendingIds }), id]);

    // The re-check breaks after 120 games: the first batch of 100 is stored, and the 50 games not
    // stored yet stay pending (with the cursor unchanged).
    saveState(ids);
    idsOpts = { failAfter: 120 };
    await expect(run(id)).rejects.toThrow(UpstreamError);
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE origin_id LIKE 'pend%'")).toBe(100);
    let state = JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!);
    expect(state.since).toBe(1793600000000);
    expect(state.pendingIds).toEqual(ids.slice(100));

    // The next run finishes them; an id Lichess no longer returns is dropped.
    idsOpts = {};
    saveState([...state.pendingIds, 'gone0001']);
    await run(id);
    expect(fake.callsTo('/api/games/export/_ids').at(-1)!.body).toBe([...ids.slice(100), 'gone0001'].join(','));
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE origin_id LIKE 'pend%'")).toBe(150);
    state = JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!);
    expect(state.pendingIds).toEqual([]);
  });

  it('limits the first import to initialSyncMonths', async () => {
    writeSettings(t.db, { initialSyncMonths: 3 });
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    const before = Date.now();
    await run(id);
    const since = Number(fake.callsTo('/api/games/user/synthplayer')[0]!.url.searchParams.get('since'));
    expect(since).toBeGreaterThanOrEqual(initialCutoff(before, 3)!);
    expect(since).toBeLessThanOrEqual(initialCutoff(Date.now(), 3)!);
  });

  it('resumes after a dropped connection from the last stored batch', async () => {
    const base = GAMES[0]!;
    games = Array.from({ length: 150 }, (_, i) => ({ ...base, id: `bulk${String(i).padStart(4, '0')}`, createdAt: base.createdAt! + i * 1000 }));
    streamOpts = { failAfter: 120 };
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    const err = await run(id).catch(e => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.reason).toBe('network');
    // The first batch of 100 and its cursor were committed together.
    expect(t.db.value('SELECT COUNT(*) FROM games')).toBe(100);
    const state = JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!);
    expect(state.since).toBe(games[99]!.createdAt! + 1);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toMatch(/connection/);

    streamOpts = {};
    await run(id);
    expect(Number(fake.callsTo('/api/games/user/synthplayer')[1]!.url.searchParams.get('since'))).toBe(games[99]!.createdAt! + 1);
    expect(t.db.value('SELECT COUNT(*) FROM games')).toBe(150);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toBeNull();
  });

  it('re-imports from the start on a full sync without duplicating games', async () => {
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    await run(id);
    const updates = await run(id, { full: true });
    expect(fake.callsTo('/api/games/user/synthplayer')[1]!.url.searchParams.has('since')).toBe(false);
    expect(updates.at(-1)?.counts).toMatchObject({ imported: 0, duplicates: 10 });
  });

  it('records unknown and closed accounts on the source', async () => {
    user = null;
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    await expect(run(id)).rejects.toThrow(/does not exist/);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toMatch(/does not exist/);
    expect(fake.callsTo('/api/games/user/synthplayer')).toHaveLength(0);

    user = { id: 'synthplayer', username: 'SynthPlayer', disabled: true };
    await expect(run(id)).rejects.toThrow(/closed/);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toMatch(/closed/);
    expect(parseSourceProfile(t.db.value<string>('SELECT profile_json FROM sources WHERE id = ?', [id]))?.closed).toBe(true);
  });

  it('imports accounts marked for a ToS violation but keeps a warning', async () => {
    user = { ...USER, tosViolation: true };
    const id = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    await run(id);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toMatch(/Terms of Service/);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [id])).toBe(10);
  });

  it('rejects invalid usernames without calling Lichess', async () => {
    const id = createSource(t.db, { kind: 'lichess', key: 'bad name!' });
    await expect(run(id)).rejects.toThrow(/not a valid Lichess username/);
    expect(fake.calls).toHaveLength(0);
  });

  it('lets rate limits through to the worker without blaming the source', async () => {
    const limited = fakeFetch([['lichess.org/api/user/synthplayer', () => statusResponse(429, { 'retry-after': '90' })]]);
    const t2 = await makeTestApp({ fetch: limited.fetch });
    try {
      const id = createSource(t2.db, { kind: 'lichess', key: 'synthplayer' });
      const { ctx } = makeJobContext(t2, 'sync', { sourceId: id });
      const err = await syncHandler(ctx).catch(e => e);
      expect(err).toBeInstanceOf(UpstreamError);
      expect(err.reason).toBe('rate_limited');
      expect(err.retryAt).toBeGreaterThan(Date.now() + 80_000);
      expect(t2.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toBeNull();
    } finally {
      await t2.close();
    }
  });
});
