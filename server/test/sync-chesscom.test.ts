import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../src/http/upstream.ts';
import { writeSettings } from '../src/settings.ts';
import { chesscomEventName } from '../src/sync/chesscom.ts';
import {
  archiveMonth,
  chesscomMonthsToFetch,
  chesscomSnapshot,
  countryFromChesscom,
  mapChesscomGame,
  monthOf,
  parseSourceProfile,
  syncHandler,
  type ChesscomGame,
} from '../src/sync/index.ts';
import type { ChesscomProfile, ChesscomStats } from '../src/sync/chesscom.ts';
import { createSource, makeJobContext, makeTestApp, type TestApp } from './helpers.ts';
import { fakeFetch, fixtureJson, jsonResponse, statusResponse, type FakeFetch } from './sync-fakes.ts';

const PROFILE = fixtureJson<ChesscomProfile>('chesscom/hikaru-profile.json');
const STATS = fixtureJson<ChesscomStats>('chesscom/hikaru-stats.json');
const ARCHIVES = fixtureJson<{ archives: string[] }>('chesscom/hikaru-archives.json');
const MONTHS: Record<string, ChesscomGame[]> = {
  '2014/04': fixtureJson<{ games: ChesscomGame[] }>('chesscom/hikaru-games-2014-04.json').games,
  '2026/10': fixtureJson<{ games: ChesscomGame[] }>('chesscom/hikaru-games-2026-10.json').games,
  '2026/11': fixtureJson<{ games: ChesscomGame[] }>('chesscom/hikaru-games-2026-11.json').games,
};
const ME = { playerKey: 'hikaru', playerTitle: 'GM' as const };

const mapped = (g: ChesscomGame) => {
  const m = mapChesscomGame(g, ME);
  if ('skip' in m) throw new Error(`skipped: ${m.skip}`);
  return m;
};

describe('Chess.com mapping', () => {
  it('maps every result code pair to a result and termination', () => {
    const seen = [...MONTHS['2026/10']!, ...MONTHS['2026/11']!].map(g => {
      const { game } = mapped(g);
      return `${g.white.result}/${g.black.result} → ${game.result} ${game.termination}`;
    });
    expect(new Set(seen)).toEqual(
      new Set([
        'win/resigned → 1-0 resign',
        'resigned/win → 0-1 resign',
        'timeout/win → 0-1 timeout',
        'win/timeout → 1-0 timeout',
        'abandoned/win → 0-1 abandon',
        'checkmated/win → 0-1 mate',
        'win/checkmated → 1-0 mate',
        'insufficient/insufficient → 1/2-1/2 insufficient',
        'agreed/agreed → 1/2-1/2 agreement',
        'repetition/repetition → 1/2-1/2 repetition',
        'timevsinsufficient/timevsinsufficient → 1/2-1/2 timeout_vs_insufficient',
        'stalemate/stalemate → 1/2-1/2 stalemate',
        '50move/50move → 1/2-1/2 fifty',
      ]),
    );
  });

  it('maps a live game from the archive owner’s side', () => {
    const g = MONTHS['2026/10']![0]!;
    const { game, side } = mapChesscomGame(g, { ...ME, opponentTitle: k => (k === 'opponent01' ? 'IM' : null) }) as ReturnType<typeof mapped>;
    expect(side).toBe('white');
    expect(game).toMatchObject({
      origin: 'chesscom',
      originId: g.uuid,
      url: g.url,
      white: { name: 'Hikaru', rating: 3451, ratingAfter: 3451, title: 'GM' },
      black: { name: 'Opponent01', rating: 2864, ratingAfter: 2864, title: 'IM' },
      timeClass: 'blitz',
      timeControl: '180',
      rated: true,
      event: 'Live Chess',
      round: null,
      endedAt: g.end_time! * 1000,
      startedAt: Date.UTC(2026, 9, 2, 22, 5, 6),
    });
    expect(game.moves.slice(0, 4)).toEqual(['d4', 'Nf6', 'Nf3', 'g6']);
    expect(game.white.accuracy).toBe(g.accuracies?.white);
    expect(game.headers).toMatchObject({ ECO: 'E62', TimeControl: '180' });
  });

  it('keeps clock times and names events after their tournament', () => {
    const g = MONTHS['2026/10']![0]!;
    const { game } = mapped(g);
    expect(game.clocks!.slice(0, 4)).toEqual([18000, 18000, 17990, 17930]);
    expect(game.clocks).toHaveLength(game.moves.length);
    const url = 'https://www.chess.com/tournament/live/bullet-brawl-november-21-2026-31422095';
    const inBrawl = { ...g, pgn: g.pgn!.replace('[Event "Live Chess"]', `[Event "Live Chess"]\n[Tournament "${url}"]`) };
    expect(mapped(inBrawl).game.event).toBe('Bullet Brawl November 21 2026');
    expect(mapped({ ...g, tournament: 'https://api.chess.com/pub/tournament/titled-tuesday-blitz-november-03-2026-31201855' }).game.event).toBe(
      'Titled Tuesday Blitz November 03 2026',
    );
    expect(chesscomEventName('https://www.chess.com/tournament/live/first-3-0-thursday-november-05-2026-31201863')).toBe(
      'First 3|0 Thursday November 05 2026',
    );
    expect(chesscomEventName('https://www.chess.com/tournament/live/12345')).toBeNull();
    expect(chesscomEventName('https://www.chess.com/game/live/1')).toBeNull();
    expect(chesscomEventName(null)).toBeNull();
  });

  it('maps daily games as correspondence and keeps unrated games', () => {
    const [, daily, , unratedBullet, unratedDaily] = MONTHS['2014/04']!;
    expect(mapped(daily!).game).toMatchObject({ timeClass: 'correspondence', timeControl: '1/259200', rated: true, event: "Let's Play!" });
    expect(mapped(daily!).game.startedAt).toBe(daily!.start_time! * 1000);
    expect(mapped(daily!).side).toBe('black');
    expect(mapped(unratedBullet!).game).toMatchObject({ timeClass: 'bullet', rated: false, result: '1-0' });
    expect(mapped(unratedDaily!).game).toMatchObject({ timeClass: 'correspondence', timeControl: '1/1209600', rated: false });
  });

  it('skips variants, set-up positions and games of other players', () => {
    const [, , chess960] = MONTHS['2014/04']!;
    expect(mapChesscomGame(chess960!, ME)).toMatchObject({ skip: 'variant' });
    const g = MONTHS['2026/10']![0]!;
    expect(mapChesscomGame({ ...g, initial_setup: '4k3/8/8/8/8/8/8/4K2R w K - 0 1' }, ME)).toEqual({ skip: 'fromPosition' });
    expect(mapChesscomGame(g, { playerKey: 'someone-else', playerTitle: null })).toEqual({ skip: 'otherPlayer' });
    expect(mapChesscomGame({ ...g, pgn: '' }, ME)).toEqual({ skip: 'noMoves' });
  });

  it('counts unknown result codes as a loss and reports them', () => {
    const unknown: string[] = [];
    const g = MONTHS['2026/10']![0]!;
    const m = mapChesscomGame({ ...g, black: { ...g.black, result: 'bughousepartnerlose-ish' } }, { ...ME, onUnknownCode: c => unknown.push(c) });
    expect('skip' in m ? m : m.game.result).toBe('1-0');
    expect(unknown).toEqual(['bughousepartnerlose-ish']);
    // Inconsistent codes fall back to the PGN result and termination.
    const both = mapChesscomGame({ ...g, white: { ...g.white, result: 'resigned' } }, ME);
    expect('skip' in both ? both : [both.game.result, both.game.termination]).toEqual(['1-0', 'resign']);
  });

  it('builds the profile snapshot and maps countries', () => {
    const s = chesscomSnapshot(PROFILE, STATS, 1000);
    expect(s).toMatchObject({ site: 'chesscom', username: 'Hikaru', userId: '15448422', title: 'GM', country: 'US', closed: false });
    expect(s.ratings.map(r => [r.timeClass, r.rating, r.rd, r.best])).toEqual([
      ['bullet', 3394, 26, 3570],
      ['blitz', 3449, 30, 3503],
      ['rapid', 2838, 44, 2927],
      ['correspondence', 2239, 103, 2464],
    ]);
    expect(s.fide).toEqual({ standard: 2814, rapid: null, blitz: null });
    expect(chesscomSnapshot({ ...PROFILE, status: 'closed:fair_play_violations' }, null, 1)).toMatchObject({ closed: true, violation: true, fide: null });
    expect(countryFromChesscom('https://api.chess.com/pub/country/XE')).toBe('GB');
    expect(countryFromChesscom('https://api.chess.com/pub/country/XK')).toBe('XK');
    expect(countryFromChesscom('https://api.chess.com/pub/country/XX')).toBeNull();
    expect(countryFromChesscom('no')).toBe('NO');
    expect(countryFromChesscom('https://example.org/nowhere')).toBeNull();
    expect(archiveMonth('https://api.chess.com/pub/player/hikaru/games/2026/03')).toBe('2026/03');
    expect(monthOf(Date.UTC(2026, 0, 15), -1)).toBe('2025/12');
  });

  it('picks the months to fetch: unprocessed ones and everything since the last sync', () => {
    const archive = ['2014/04', '2026/09', '2026/10', '2026/11', '2026/12', '2027/01'];
    const done = { '2014/04': 'a', '2026/09': 'b', '2026/10': 'c', '2026/11': 'd' };
    const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
    // First sync: everything (or from the cutoff's month).
    expect(chesscomMonthsToFetch(archive, { months: {}, cutoff: null, lastSyncStartedAt: null }, at(2027, 1, 15))).toEqual(archive);
    expect(chesscomMonthsToFetch(archive, { months: {}, cutoff: at(2026, 10, 20), lastSyncStartedAt: null }, at(2027, 1, 15))).toEqual([
      '2026/10',
      '2026/11',
      '2026/12',
      '2027/01',
    ]);
    // Last sync on 23 Nov, next on 15 Jan: November (and October) are revalidated, not skipped.
    expect(chesscomMonthsToFetch(archive, { months: done, cutoff: null, lastSyncStartedAt: at(2026, 11, 23) }, at(2027, 1, 15))).toEqual([
      '2026/10',
      '2026/11',
      '2026/12',
      '2027/01',
    ]);
    // Again the same day: the current and previous month only.
    expect(chesscomMonthsToFetch(archive.slice(0, 4), { months: done, cutoff: null, lastSyncStartedAt: at(2026, 11, 23) }, at(2026, 11, 24))).toEqual([
      '2026/10',
      '2026/11',
    ]);
    expect(
      chesscomMonthsToFetch(archive, { months: { ...done, '2026/12': 'e', '2027/01': 'f' }, cutoff: null, lastSyncStartedAt: at(2027, 1, 2) }, at(2027, 1, 3)),
    ).toEqual(['2026/12', '2027/01']);
    // A month never processed (e.g. it answered 404) is fetched whatever its age.
    const { '2026/09': _skipped, ...gap } = { ...done, '2026/12': 'e', '2027/01': 'f' };
    expect(chesscomMonthsToFetch(archive, { months: gap, cutoff: null, lastSyncStartedAt: at(2027, 1, 2) }, at(2027, 1, 3))).toEqual([
      '2026/09',
      '2026/12',
      '2027/01',
    ]);
  });
});

describe('Chess.com sync', () => {
  let t: TestApp;
  let fake: FakeFetch;
  let months: Record<string, ChesscomGame[] | 'error' | 'missing'>;
  let archives: string[];
  let profile: ChesscomProfile | null;
  let etagVersion: number;
  let monthVersion: Record<string, number>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 23, 12));
    months = { ...MONTHS };
    archives = [...ARCHIVES.archives];
    profile = PROFILE;
    etagVersion = 1;
    monthVersion = {};
    fake = fakeFetch([
      ['api.chess.com/pub/player/hikaru', () => (profile ? jsonResponse(profile) : statusResponse(404))],
      ['api.chess.com/pub/player/hikaru/stats', () => jsonResponse(STATS)],
      ['api.chess.com/pub/player/hikaru/games/archives', () => jsonResponse({ archives })],
      [
        /^api\.chess\.com\/pub\/player\/hikaru\/games\/\d{4}\/\d{2}$/,
        (url, call) => {
          const month = url.pathname.slice(-7);
          const games = months[month];
          if (games === undefined) return jsonResponse({ games: [] });
          if (games === 'error') return jsonResponse({ code: 0, message: 'An internal error has occurred. Please contact us.' });
          if (games === 'missing') return statusResponse(404);
          const etag = `W/"${month}-v${monthVersion[month] ?? etagVersion}"`;
          if (call.headers.get('if-none-match') === etag) return statusResponse(304, { etag });
          return jsonResponse({ games }, { headers: { etag } });
        },
      ],
    ]);
    t = await makeTestApp({ fetch: fake.fetch });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const run = async (sourceId: number, opts: { full?: boolean; jobId?: number } = {}) => {
    const { ctx, updates } = makeJobContext(t, 'sync', opts.full ? { sourceId, full: true } : { sourceId }, { jobId: opts.jobId });
    await syncHandler(ctx);
    return updates;
  };
  const stateOf = (id: number) => JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!);
  const monthCalls = () => fake.callsTo(/\/games\/\d{4}\/\d{2}$/).map(c => [c.url.pathname.slice(-7), c.headers.get('if-none-match')]);
  const myGames = (id: number) =>
    t.db.all<{ origin_id: string; time_class: string; rated: number; rating: number; rating_after: number; ended_at: number }>(
      `SELECT g.origin_id, pg.time_class, pg.rated, pg.rating, pg.rating_after, pg.ended_at
         FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE pg.source_id = ? ORDER BY pg.ended_at`,
      [id],
    );

  it('imports every month in order, deriving pre-game ratings per time class', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    const updates = await run(id);
    expect(fake.calls.map(c => c.url.pathname)).toEqual([
      '/pub/player/hikaru',
      '/pub/player/hikaru/stats',
      '/pub/player/hikaru/games/archives',
      '/pub/player/hikaru/games/2014/04',
      '/pub/player/hikaru/games/2026/10',
      '/pub/player/hikaru/games/2026/11',
    ]);
    expect(fake.calls.every(c => /^Outpost\//.test(c.headers.get('user-agent') ?? ''))).toBe(true);
    expect(updates.at(-1)).toMatchObject({ done: 3, total: 3, counts: { imported: 21, duplicates: 0, skipped: 1 } });

    const src = t.db.get<Record<string, unknown>>('SELECT * FROM sources WHERE id = ?', [id])!;
    expect(src).toMatchObject({ display_name: 'Hikaru', site_user_id: '15448422', title: 'GM', country: 'US', last_sync_error: null });
    expect(parseSourceProfile(src.profile_json as string)?.ratings).toHaveLength(4);
    expect(JSON.parse(src.sync_state_json as string)).toEqual({
      v: 1,
      months: { '2014/04': 'W/"2014/04-v1"', '2026/10': 'W/"2026/10-v1"', '2026/11': 'W/"2026/11-v1"' },
      doneThrough: '2026/11',
      cutoff: null,
      lastSyncStartedAt: Date.UTC(2026, 10, 23, 12),
      tournamentEvents: true,
    });

    const rows = myGames(id);
    const chain = (tc: string) => rows.filter(r => r.time_class === tc && r.rated).map(r => [r.rating, r.rating_after]);
    expect(chain('blitz')).toEqual([
      [3451, 3451],
      [3451, 3452],
      [3452, 3454],
      [3454, 3455],
      [3455, 3456],
      [3456, 3460],
      [3460, 3483],
      [3483, 3455],
      [3455, 3432],
    ]);
    // The unrated 2014 bullet game (2911) is not part of the chain.
    expect(chain('bullet')).toEqual([
      [3395, 3395],
      [3395, 3374],
      [3374, 3347],
      [3347, 3348],
      [3348, 3357],
      [3357, 3368],
      [3368, 3435],
      [3435, 3431],
    ]);
    expect(rows.filter(r => !r.rated).map(r => [r.time_class, r.rating, r.rating_after])).toEqual([
      ['bullet', 2911, 2911],
      ['correspondence', 2306, 2306],
    ]);
    expect(chain('correspondence')).toEqual([
      [2361, 2361],
      [2361, 2361],
    ]);
    // Opponents are queued for a country lookup (the chess960 opponent never got a game row).
    expect(t.db.value("SELECT COUNT(*) FROM players_cache WHERE kind = 'chesscom' AND fetched_at IS NULL")).toBe(15);
    expect(t.db.value("SELECT dedupe_key FROM jobs WHERE kind = 'geo'")).toBe('geo:chesscom');
  });

  it('revalidates only the current and previous month with their ETags', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    fake.calls.length = 0;
    const updates = await run(id);
    const monthCalls = fake.callsTo(/\/games\/\d{4}\/\d{2}$/);
    expect(monthCalls.map(c => [c.url.pathname.slice(-7), c.headers.get('if-none-match')])).toEqual([
      ['2026/10', 'W/"2026/10-v1"'],
      ['2026/11', 'W/"2026/11-v1"'],
    ]);
    expect(updates.at(-1)?.counts).toMatchObject({ imported: 0, unchangedMonths: 2 });

    // A late daily game in the previous month: new ETag, one new game, the rest are duplicates.
    const late = { ...MONTHS['2026/10']![0]!, uuid: 'late-daily-game', url: 'https://www.chess.com/game/daily/1', end_time: 1792000000 };
    months['2026/10'] = [...MONTHS['2026/10']!, late];
    etagVersion = 2;
    const third = await run(id);
    expect(third.at(-1)?.counts).toMatchObject({ imported: 1, duplicates: 13 + 4 });
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE origin_id = 'late-daily-game'")).toBe(1);
  });

  it('picks up new months and revalidates the months of the last sync', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    vi.setSystemTime(Date.UTC(2027, 1, 3));
    archives = [...archives, 'https://api.chess.com/pub/player/hikaru/games/2026/12', 'https://api.chess.com/pub/player/hikaru/games/2027/02'];
    fake.calls.length = 0;
    const updates = await run(id);
    // October and November (the last sync ran on 23 Nov) are revalidated: 304, nothing re-read.
    expect(monthCalls()).toEqual([
      ['2026/10', 'W/"2026/10-v1"'],
      ['2026/11', 'W/"2026/11-v1"'],
      ['2026/12', null],
      ['2027/02', null],
    ]);
    expect(updates.at(-1)?.counts).toMatchObject({ imported: 0, duplicates: 0, unchangedMonths: 2 });
    expect(stateOf(id)).toMatchObject({ doneThrough: '2027/02', lastSyncStartedAt: Date.UTC(2027, 1, 3) });
  });

  it('finds games that ended in the last sync’s month however long the gap until the next one', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id); // 23 Nov 2026
    // A game ends on 28 Nov, after that sync; the next update only comes mid-January.
    const late = { ...MONTHS['2026/11']![0]!, uuid: 'late-november-game', url: 'https://www.chess.com/game/live/2', end_time: Date.UTC(2026, 10, 28) / 1000 };
    months['2026/11'] = [...MONTHS['2026/11']!, late];
    monthVersion['2026/11'] = 2;
    archives = [...archives, 'https://api.chess.com/pub/player/hikaru/games/2026/12', 'https://api.chess.com/pub/player/hikaru/games/2027/01'];
    vi.setSystemTime(Date.UTC(2027, 0, 15));
    fake.calls.length = 0;
    const updates = await run(id);
    expect(monthCalls().map(([m]) => m)).toEqual(['2026/10', '2026/11', '2026/12', '2027/01']);
    expect(updates.at(-1)?.counts).toMatchObject({ imported: 1, unchangedMonths: 1 });
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE origin_id = 'late-november-game'")).toBe(1);
  });

  it('uses the last sync time of states written before it was stored', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    const { lastSyncStartedAt: _dropped, ...old } = stateOf(id);
    t.db.run('UPDATE sources SET sync_state_json = ? WHERE id = ?', [JSON.stringify(old), id]);
    vi.setSystemTime(Date.UTC(2027, 0, 15));
    fake.calls.length = 0;
    await run(id);
    expect(monthCalls().map(([m]) => m)).toEqual(['2026/10', '2026/11']);
  });

  it('fetches a listed month that answered 404 again next time', async () => {
    months['2014/04'] = 'missing';
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    const first = await run(id);
    expect(first.at(-1)?.counts).toMatchObject({ imported: 17, missingMonths: 1 });
    let state = stateOf(id);
    expect(Object.keys(state.months)).toEqual(['2026/10', '2026/11']);
    expect(state.doneThrough).toBe('2026/11');
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toBeNull();

    months['2014/04'] = MONTHS['2014/04']!;
    vi.setSystemTime(Date.UTC(2027, 5, 1));
    fake.calls.length = 0;
    const second = await run(id);
    expect(monthCalls().map(([m]) => m)).toEqual(['2014/04', '2026/10', '2026/11']);
    expect(second.at(-1)?.counts).toMatchObject({ imported: 4 });
    state = stateOf(id);
    expect(Object.keys(state.months).sort()).toEqual(['2014/04', '2026/10', '2026/11']);
  });

  it('re-reads the whole history on a full resync, resuming the same job when interrupted', async () => {
    writeSettings(t.db, { initialSyncMonths: 1 });
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    expect(myGames(id)).toHaveLength(4);

    // A full resync ignores the window and the ETags; it breaks at November.
    months['2026/11'] = 'error';
    fake.calls.length = 0;
    await expect(run(id, { full: true, jobId: 31 })).rejects.toThrow(UpstreamError);
    expect(monthCalls()).toEqual([
      ['2014/04', null],
      ['2026/10', null],
      ['2026/11', null],
    ]);
    expect(stateOf(id)).toMatchObject({ cutoff: null, fullJob: 31, doneThrough: '2026/10' });

    // The same job continues where it stopped (2014 is not read again).
    months['2026/11'] = MONTHS['2026/11']!;
    fake.calls.length = 0;
    await run(id, { full: true, jobId: 31 });
    expect(monthCalls().map(([m]) => m)).toEqual(['2026/10', '2026/11']);
    expect(myGames(id)).toHaveLength(21);
    const state = stateOf(id);
    expect(state.fullJob).toBeUndefined();
    expect(state.cutoff).toBeNull();

    // A later full resync starts over.
    fake.calls.length = 0;
    await run(id, { full: true, jobId: 32 });
    expect(monthCalls()).toEqual([
      ['2014/04', null],
      ['2026/10', null],
      ['2026/11', null],
    ]);
  });

  it('limits the first import to initialSyncMonths but still chains ratings from earlier games', async () => {
    writeSettings(t.db, { initialSyncMonths: 1 });
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    // Cutoff 2026-10-23 12:00: 2014 is not fetched; October is fetched but all its games are older.
    expect(fake.callsTo(/\/games\/\d{4}\/\d{2}$/).map(c => c.url.pathname.slice(-7))).toEqual(['2026/10', '2026/11']);
    const rows = myGames(id);
    expect(rows).toHaveLength(4);
    expect(rows.every(r => r.ended_at >= Date.UTC(2026, 9, 23, 12))).toBe(true);
    expect(rows.find(r => r.time_class === 'blitz')).toMatchObject({ rating: 3483, rating_after: 3455 });
    const state = JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!);
    expect(state.cutoff).toBe(Date.UTC(2026, 9, 23, 12));
    // The cutoff sticks: re-polling October later still skips its older games.
    etagVersion = 2;
    await run(id);
    expect(myGames(id)).toHaveLength(4);
  });

  it('uses opponent titles already looked up', async () => {
    t.db.run("INSERT INTO players_cache (kind, key, country, title, name, fetched_at) VALUES ('chesscom', 'opponent01', 'NO', 'IM', 'Opponent01', 1)");
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    expect(t.db.all("SELECT DISTINCT opp_title FROM player_games WHERE opp_key = 'opponent01'")).toEqual([{ opp_title: 'IM' }]);
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE (white_key = 'opponent01' AND white_title = 'IM') OR (black_key = 'opponent01' AND black_title = 'IM')")).toBe(5);
    expect(t.db.value("SELECT COUNT(*) FROM players_cache WHERE key = 'opponent01' AND fetched_at IS NULL")).toBe(0);
  });

  it('fails cleanly for unknown accounts and retries Chess.com internal errors', async () => {
    profile = null;
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await expect(run(id)).rejects.toThrow(/does not exist/);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toMatch(/does not exist/);

    profile = PROFILE;
    months['2026/11'] = 'error';
    const err = await run(id).catch(e => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ reason: 'status', status: 503 });
    expect(err.message).toMatch(/internal error/);
    // Months before the failure are stored with the cursor; the next run resumes at 2026/11.
    expect(JSON.parse(t.db.value<string>('SELECT sync_state_json FROM sources WHERE id = ?', [id])!).doneThrough).toBe('2026/10');
    months['2026/11'] = MONTHS['2026/11']!;
    fake.calls.length = 0;
    await run(id);
    expect(fake.callsTo(/\/games\/\d{4}\/\d{2}$/).map(c => c.url.pathname.slice(-7))).toEqual(['2026/10', '2026/11']);
    expect(myGames(id)).toHaveLength(21);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toBeNull();
  });

  it('keeps a warning for closed accounts', async () => {
    profile = { ...PROFILE, status: 'closed:fair_play_violations' };
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    expect(t.db.value('SELECT last_sync_error FROM sources WHERE id = ?', [id])).toMatch(/fair-play/);
    expect(myGames(id)).toHaveLength(21);
  });

  it('lowercases usernames in URLs and rejects invalid ones', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    t.db.run("UPDATE sources SET key = 'Hikaru' WHERE id = ?", [id]);
    await run(id);
    expect(fake.calls[0]!.url.pathname).toBe('/pub/player/hikaru');
    const bad = createSource(t.db, { kind: 'chesscom', key: 'no spaces' });
    fake.calls.length = 0;
    await expect(run(bad)).rejects.toThrow(/not a valid Chess.com username/);
    expect(fake.calls).toHaveLength(0);
  });

  it('takes a pre-game rating from the stored games, never from an older month, when a month in between is not read', async () => {
    // First sync: October is listed but not served; November is read.
    months['2026/10'] = 'missing';
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    const blitz = () => myGames(id).filter(r => r.time_class === 'blitz' && r.rated);
    const novFirst = blitz().find(r => r.ended_at >= Date.UTC(2026, 10, 1))!;
    // Second sync, a month later: October is served now, November answers 304, December is new.
    months['2026/10'] = MONTHS['2026/10']!;
    const lastNov = MONTHS['2026/11']!.filter(g => g.time_class === 'blitz' && g.rated).at(-1)!;
    const novRating = lastNov.white.username.toLowerCase() === 'hikaru' ? lastNov.white.rating! : lastNov.black.rating!;
    const dec = { ...MONTHS['2026/11']![0]!, uuid: 'dec-game-1', end_time: Date.UTC(2026, 11, 5) / 1000, start_time: Date.UTC(2026, 11, 5) / 1000 - 300 };
    archives = [...archives, 'https://api.chess.com/pub/player/hikaru/games/2026/12'];
    months['2026/12'] = [dec];
    vi.setSystemTime(Date.UTC(2026, 11, 20, 12));
    await run(id);
    expect(monthCalls().slice(-3).map(([m]) => m)).toEqual(['2026/10', '2026/11', '2026/12']);
    const decRow = myGames(id).find(r => r.origin_id === 'dec-game-1')!;
    if (dec.time_class === 'blitz' && dec.rated) expect(decRow.rating).toBe(novRating);
    else expect(decRow.rating).not.toBe(novFirst.rating);
    // Whatever the class, the pre-game rating is the latest stored one of that class before it.
    const before = t.db.value<number>(
      `SELECT rating_after FROM player_games WHERE source_id = ? AND time_class = ? AND rated = 1 AND ended_at < ? ORDER BY ended_at DESC LIMIT 1`,
      [id, decRow.time_class, decRow.ended_at],
    );
    expect(decRow.rating).toBe(before);
  });

  it('keeps both sides of a game row as Chess.com reports them; the owner’s pre-game rating stays in player_games', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    const rows = t.db.all<{ white_rating: number; black_rating: number; headers_json: string; rating: number; rating_after: number; color: string }>(
      `SELECT g.white_rating, g.black_rating, g.headers_json, pg.rating, pg.rating_after, pg.color
         FROM games g JOIN player_games pg ON pg.game_id = g.id WHERE pg.source_id = ? AND pg.rated = 1`,
      [id],
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      const h = JSON.parse(r.headers_json) as Record<string, string>;
      expect([r.white_rating, r.black_rating]).toEqual([Number(h.WhiteElo), Number(h.BlackElo)]);
      expect(r.rating_after).toBe(r.color === 'w' ? r.white_rating : r.black_rating);
    }
    expect(rows.some(r => r.rating !== r.rating_after)).toBe(true);
  });

  it('names stored games after their tournaments once per source', async () => {
    const id = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    await run(id);
    const gameId = t.db.value<number>('SELECT game_id FROM player_games WHERE source_id = ? ORDER BY ended_at DESC LIMIT 1', [id])!;
    const url = 'https://www.chess.com/tournament/live/bullet-brawl-november-21-2026-31422095';
    t.db.run(`UPDATE games SET event = 'Live Chess', headers_json = json_set(headers_json, '$.Tournament', ?) WHERE id = ?`, [url, gameId]);
    // A state written before the backfill existed.
    const state = stateOf(id);
    delete state.tournamentEvents;
    t.db.run('UPDATE sources SET sync_state_json = ? WHERE id = ?', [JSON.stringify(state), id]);
    await run(id);
    expect(t.db.value('SELECT event FROM games WHERE id = ?', [gameId])).toBe('Bullet Brawl November 21 2026');
    expect(stateOf(id).tournamentEvents).toBe(true);
  });
});
