import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import type { JobProgress } from '@outpost/shared/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertGame, pgnSourceKey, rebuildPlayerGames } from '../src/chess/index.ts';
import { getJobHandler } from '../src/jobs/index.ts';
import { ensureBroadcastDatabase, findOrCreateReferenceDatabase } from '../src/reference/databases.ts';
import { linkFideSources } from '../src/reference/importer.ts';
import { DOWNLOAD_IDLE_MS } from '../src/reference/jobs.ts';
import { indexReferencePlayer, referencePlayerByFideId, searchReferencePlayers } from '../src/reference/players.ts';
import { sweepReferenceUploads } from '../src/reference/upload.ts';
import { IMPORT_DNS } from '../src/reference/urls.ts';
import { createSource, makeJobContext, makeTestApp, testGame, type TestApp } from './helpers.ts';

const FIXTURES = new URL('./fixtures/reference/', import.meta.url);
const fixture = (name: string): Buffer => readFileSync(new URL(name, FIXTURES));
const MONTH_URL = (m: string) => `https://database.lichess.org/broadcast/lichess_db_broadcast_${m}.pgn.zst`;

/** A fake network: exact URL (without query) → response factory. Records every call. */
function fakeNetwork(routes: Record<string, (url: URL, init: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, auth: new Headers(init.headers).get('authorization') });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const route = routes[`${url.origin}${url.pathname}`];
    if (!route) return new Response('not found', { status: 404 });
    return route(url, init);
  };
  return { fetch, calls, routes };
}

const bytes = (b: Buffer, headers: Record<string, string> = {}) => () =>
  new Response(new Uint8Array(b), { headers: { 'content-length': String(b.length), ...headers } });

const ROUND_JSON = {
  round: { id: 'Rnd5EEEE', name: 'Round 3', slug: 'round-3', startsAt: Date.UTC(2026, 0, 13, 17), finished: true },
  tour: {
    id: 'TourAAAA',
    name: 'Outpost Test Open 2026 | Blitz',
    slug: 'outpost-test-open-2026',
    info: { fideTC: 'blitz' },
  },
  games: [
    { id: 'Game0008', players: [{ name: 'Beta, Test', fideId: 900002, fed: 'NOR' }, { name: 'Epsilon, Test', fideId: 900005 }], status: '1-0' },
    { id: 'Game0009', players: [{ name: 'Zeta, Test', fideId: 900006, fed: 'ESP' }, { name: 'Alpha, Test', fideId: 900001 }], status: '½-½' },
  ],
};

/** Tests have no network: host names resolve through this table (unknown names do not resolve). */
const DNS: Record<string, string[]> = {
  'files.example.org': ['93.184.215.14'],
  'mirror.example.net': ['2606:2800:21f:cb07::1'],
  'lichess.org': ['37.187.205.99'],
  'intranet.example.org': ['10.0.0.5'],
  'sneaky.example.org': ['93.184.215.14', '::1'],
};
const realLookup = IMPORT_DNS.lookup;

describe('reference imports', () => {
  let t: TestApp;
  let net: ReturnType<typeof fakeNetwork>;
  const lookups: string[] = [];

  beforeEach(async () => {
    lookups.length = 0;
    IMPORT_DNS.lookup = async host => {
      lookups.push(host);
      const a = DNS[host];
      if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return a.map(address => ({ address }));
    };
    net = fakeNetwork({
      [MONTH_URL('2026-01')]: bytes(fixture('broadcast-2026-01.pgn.zst')),
      [MONTH_URL('2026-02')]: bytes(fixture('broadcast-2026-02.pgn.zst')),
      'https://lichess.org/api/broadcast/-/-/Rnd5EEEE': () => Response.json(ROUND_JSON),
      'https://lichess.org/api/broadcast/round/Rnd5EEEE.pgn': bytes(fixture('round-Rnd5EEEE.pgn')),
    });
    t = await makeTestApp({ fetch: net.fetch, env: { LICHESS_TOKEN: 'lip_testtoken' } });
  });
  afterEach(async () => {
    IMPORT_DNS.lookup = realLookup;
    await t.close();
  });

  const runMonth = async (databaseId: number, month: string) => {
    const { ctx, updates } = makeJobContext(t, 'broadcastMonth', { databaseId, month });
    await getJobHandler('broadcastMonth')!(ctx);
    return updates.at(-1)!;
  };
  const runRound = async (databaseId: number, roundId: string) => {
    const { ctx, updates } = makeJobContext(t, 'broadcastRound', { databaseId, roundId });
    await getJobHandler('broadcastRound')!(ctx);
    return updates.at(-1)!;
  };

  it('the .zst fixtures are the synthetic PGNs, compressed with zstdCompressSync', () => {
    for (const name of ['broadcast-2026-01', 'broadcast-2026-02']) {
      expect(zstdDecompressSync(fixture(`${name}.pgn.zst`)).toString()).toBe(fixture(`${name}.pgn`).toString());
    }
  });

  it('streams a broadcast month: zstd → PGN → games, with counts and progress', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    const last = await runMonth(dbId, '2026-01');
    expect(last.counts).toEqual({
      imported: 4,
      duplicates: 0,
      skipped: 5,
      engine: 1,
      unplayed: 1,
      noResult: 1,
      illegalMove: 1,
      fromPosition: 1, // Chess960 (chessops reads it as chess from a set-up position)
    });
    expect(last.done).toBe(9);
    expect(last.message).toMatch(/^2026-01: 4 new, 0 duplicates, 5 skipped \(100% of 1 kB\)$/);
    expect(net.calls.map(c => c.url)).toEqual([MONTH_URL('2026-01')]);
    expect(net.calls[0]!.auth).toBeNull(); // database.lichess.org never gets the token

    const games = t.db.all<Record<string, unknown>>(
      `SELECT origin, database_id, white, black, white_fide_id, black_fide_id, white_title, white_rating, result, termination,
              time_class, time_control, event, round, url, ended_at, eco FROM games ORDER BY id`,
    );
    expect(games).toHaveLength(4);
    expect(games[0]).toMatchObject({
      origin: 'reference',
      database_id: dbId,
      white: 'Alpha, Test',
      white_fide_id: '900001',
      black_fide_id: '900002',
      white_title: 'GM',
      white_rating: 2650,
      result: '1-0',
      time_class: 'classical',
      time_control: '5400+30',
      event: 'Outpost Test Open 2026 | Masters',
      round: '1.1',
      url: 'https://lichess.org/broadcast/outpost-test-open-2026/round-1/Rnd1AAAA/Game0001',
      ended_at: Date.UTC(2026, 0, 10, 14),
    });
    expect(games[1]).toMatchObject({ termination: 'repetition', result: '1/2-1/2' });
    expect(games[2]).toMatchObject({ white: 'Club Player', white_rating: 1850, time_class: 'rapid', time_control: '900+5' });
    expect(games[3]).toMatchObject({ termination: 'mate', time_class: 'blitz', eco: expect.stringMatching(/^C/) });
    expect(t.db.value('SELECT game_count FROM databases WHERE id = ?', [dbId])).toBe(4);
    expect(t.db.value('SELECT COUNT(*) FROM positions')).toBeGreaterThan(20);
    expect(t.db.get('SELECT status, games, imported, duplicates, skipped FROM reference_broadcast_months WHERE month = ?', ['2026-01'])).toEqual({
      status: 'imported',
      games: 4,
      imported: 4,
      duplicates: 0,
      skipped: 5,
    });
  });

  it('dedupes across months and re-imports; a later dump corrects a game stored earlier', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    await runMonth(dbId, '2026-01');
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE white = 'Gamma, Testy'")).toBe(1);
    const firstId = t.db.value<number>("SELECT id FROM games WHERE white = 'Gamma, Testy'")!;
    // February's dump has chapter Game0002 again, with the name corrected: it replaces the stored game.
    const feb = await runMonth(dbId, '2026-02');
    expect(feb.counts).toEqual({ imported: 1, duplicates: 1, corrected: 1, skipped: 0 });
    expect(feb.message).toMatch(/^2026-02: 1 new, 1 duplicate, 1 corrected, 0 skipped/);
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE white = 'Gamma, Testy'")).toBe(0);
    const corrected = t.db.get<{ id: number }>("SELECT id FROM games WHERE white = 'Gamma, Test'")!;
    expect(corrected.id).not.toBe(firstId);
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id = ?', [firstId])).toBe(0);
    expect(t.db.get('SELECT game_id, rank FROM reference_broadcast_games WHERE chapter_id = ?', ['Rnd1AAAA/Game0002'])).toEqual({
      game_id: corrected.id,
      rank: 202602,
    });
    expect(t.db.get('SELECT games, imported, duplicates FROM reference_broadcast_months WHERE month = ?', ['2026-02'])).toEqual({
      games: 3,
      imported: 1,
      duplicates: 1,
    });
    // An older dump never undoes a correction; a re-import only finds duplicates.
    const again = await runMonth(dbId, '2026-01');
    expect(again.counts).toEqual({ imported: 0, duplicates: 4, skipped: 5, engine: 1, unplayed: 1, noResult: 1, illegalMove: 1, fromPosition: 1 });
    expect((await runMonth(dbId, '2026-02')).counts).toEqual({ imported: 0, duplicates: 3, skipped: 0 });
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE white = 'Gamma, Testy'")).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games')).toBe(5);
    expect(t.db.value('SELECT game_count FROM databases WHERE id = ?', [dbId])).toBe(5);
    expect(t.db.value('SELECT COUNT(*) FROM reference_broadcast_games WHERE database_id = ?', [dbId])).toBe(5);
    // The index follows the corrected game: one game for 900003, under the corrected name.
    expect(referencePlayerByFideId(t.db, '900003')).toMatchObject({ name: 'Gamma, Test', games: 1 });
    expect(searchReferencePlayers(t.db, 'testy')).toEqual([]);
    // Another reference database keeps its own copy.
    const other = findOrCreateReferenceDatabase(t.db, { name: 'Mirror' });
    expect((await runMonth(other, '2026-02')).counts).toMatchObject({ imported: 3, duplicates: 0 });
  });

  it('lets a monthly dump correct a round imported right after it ended, never the other way round', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    // The round import (rank 0) stores Game0008 as broadcast live: Beta won.
    await runRound(dbId, 'Rnd5EEEE');
    const fide = createSource(t.db, { kind: 'fide', key: '900005' });
    linkFideSources(t.db, new Set(['900005']));
    expect(t.db.value('SELECT outcome FROM player_games WHERE source_id = ?', [fide])).toBe('l');
    // The month's dump has the board fixed (a DGT error during the round): other moves, Epsilon won.
    const fixedPgn = fixture('round-Rnd5EEEE.pgn')
      .toString()
      .replace('[Result "1-0"]', '[Result "0-1"]')
      .replace('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0', '1. e4 e5 2. Bc4 Nc6 3. Qh5 g6 4. Qf3 Nf6 0-1');
    net.routes[MONTH_URL('2025-12')] = bytes(zstdCompressSync(Buffer.from(fixedPgn)));
    const dump = await runMonth(dbId, '2025-12');
    expect(dump.counts).toMatchObject({ imported: 0, corrected: 1, duplicates: 1 });
    expect(t.db.value("SELECT result FROM games WHERE white = 'Beta, Test' AND black = 'Epsilon, Test'")).toBe('0-1');
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE database_id = ?', [dbId])).toBe(2);
    // The FIDE profile follows: the corrected game replaced the old row.
    expect(t.db.all('SELECT outcome FROM player_games WHERE source_id = ?', [fide])).toEqual([{ outcome: 'w' }]);
    expect(referencePlayerByFideId(t.db, '900005')?.games).toBe(1);
    // A later round import of the same chapter does not undo the dump's correction.
    expect((await runRound(dbId, 'Rnd5EEEE')).counts).toMatchObject({ imported: 0, duplicates: 2 });
    expect(t.db.value("SELECT result FROM games WHERE white = 'Beta, Test' AND black = 'Epsilon, Test'")).toBe('0-1');
  });

  it('imports a finished round through the API with the token, deduped against the month dumps', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    await runMonth(dbId, '2026-01');
    const last = await runRound(dbId, 'Rnd5EEEE');
    expect(last.counts).toMatchObject({ imported: 1, duplicates: 1, skipped: 1, noResult: 1 });
    expect(net.calls.slice(1).map(c => [c.url, c.auth])).toEqual([
      ['https://lichess.org/api/broadcast/-/-/Rnd5EEEE', 'Bearer lip_testtoken'],
      ['https://lichess.org/api/broadcast/round/Rnd5EEEE.pgn?clocks=false&comments=false', 'Bearer lip_testtoken'],
    ]);
    const zeta = t.db.get<Record<string, unknown>>("SELECT event, time_class, ended_at FROM games WHERE white = 'Zeta, Test'");
    // No UTCDate: the round's start wins over the Date tag; no TimeControl: the tour's fideTC.
    expect(zeta).toEqual({ event: 'Outpost Test Open 2026 | Blitz', time_class: 'blitz', ended_at: ROUND_JSON.round.startsAt });
    expect(t.db.get('SELECT tour_id, tour_name, round_name, status, games FROM reference_broadcast_rounds')).toEqual({
      tour_id: 'TourAAAA',
      tour_name: 'Outpost Test Open 2026 | Blitz',
      round_name: 'Round 3',
      status: 'imported',
      games: 2,
    });
    // Federations from the round previews: a new player at insert, a known one updated.
    expect(referencePlayerByFideId(t.db, '900006')?.federation).toBe('ESP');
    expect(referencePlayerByFideId(t.db, '900002')?.federation).toBe('NOR');
    // Importing the round again only finds duplicates.
    expect((await runRound(dbId, 'Rnd5EEEE')).counts).toMatchObject({ imported: 0, duplicates: 2 });
  });

  it('marks unfinished rounds partial and fails cleanly without a token', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    ROUND_JSON.round.finished = false;
    try {
      await runRound(dbId, 'Rnd5EEEE');
    } finally {
      ROUND_JSON.round.finished = true;
    }
    expect(t.db.value('SELECT status FROM reference_broadcast_rounds')).toBe('partial');

    const noToken = await makeTestApp({ fetch: net.fetch });
    try {
      const id = ensureBroadcastDatabase(noToken.db);
      const { ctx } = makeJobContext(noToken, 'broadcastRound', { databaseId: id, roundId: 'Rnd5EEEE' });
      await expect(getJobHandler('broadcastRound')!(ctx)).rejects.toMatchObject({ name: 'UpstreamError', reason: 'no_token' });
      expect(noToken.db.get('SELECT status, error FROM reference_broadcast_rounds')).toMatchObject({ status: 'error', error: expect.stringMatching(/token/) });
    } finally {
      await noToken.close();
    }
    const { ctx } = makeJobContext(t, 'broadcastRound', { databaseId: dbId, roundId: 'bad id!' });
    await expect(getJobHandler('broadcastRound')!(ctx)).rejects.toThrow(/Invalid broadcast round id/);
  });

  it('maintains the player index: FIDE players across databases, name-only players per database', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    await runMonth(dbId, '2026-01');
    await runMonth(dbId, '2026-02');
    await runRound(dbId, 'Rnd5EEEE');
    expect(referencePlayerByFideId(t.db, '900001')).toMatchObject({
      fideId: '900001',
      name: 'Alpha, Test',
      title: 'GM',
      games: 3,
      lastPlayed: Date.UTC(2026, 1, 2, 15),
      lastRating: 2672,
      maxRating: 2672,
      databaseId: null,
      profileSlug: null,
    });
    expect(referencePlayerByFideId(t.db, '900003')).toMatchObject({ name: 'Gamma, Test', games: 1 });
    expect(referencePlayerByFideId(t.db, '900005')).toMatchObject({ title: 'FM', games: 2, lastRating: 2310, maxRating: 2310 });

    const names = (q: string) => searchReferencePlayers(t.db, q).map(p => p.name);
    expect(names('alpha')).toEqual(['Alpha, Test']);
    expect(names('test alpha')).toEqual(['Alpha, Test']);
    expect(names('ALPHA, t')).toEqual(['Alpha, Test']);
    expect(names('lpha')).toEqual([]);
    expect(names('900001')[0]).toBe('Alpha, Test');
    expect(names('9000')).toHaveLength(6);
    expect(names('')[0]).toBe('Alpha, Test'); // most games first
    const club = searchReferencePlayers(t.db, 'club player');
    expect(club.map(p => [p.name, p.fideId, p.databaseId, p.maxRating])).toEqual([
      ['Club Player', null, dbId, 1850],
      ['Second Club Player', null, dbId, 1790],
    ]);
    expect(searchReferencePlayers(t.db, '', { limit: 2 })).toHaveLength(2);
    expect(searchReferencePlayers(t.db, '%_')).toEqual([]);

    // Deleting games (or a whole database) counts down through the trigger.
    const gameId = t.db.value<number>("SELECT id FROM games WHERE white = 'Alpha, Test' ORDER BY id LIMIT 1")!;
    t.db.run('DELETE FROM games WHERE id = ?', [gameId]);
    expect(referencePlayerByFideId(t.db, '900001')?.games).toBe(2);
    expect(referencePlayerByFideId(t.db, '900002')?.games).toBe(1);
    t.db.run('DELETE FROM databases WHERE id = ?', [dbId]);
    expect(searchReferencePlayers(t.db, '')).toEqual([]);
    expect(t.db.value("SELECT COUNT(*) FROM reference_players WHERE fide_id IS NULL")).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM reference_player_words WHERE player_id NOT IN (SELECT id FROM reference_players)')).toBe(0);
  });

  it("follows a FIDE player's latest spelling in the index and its search words", () => {
    const dbId = ensureBroadcastDatabase(t.db);
    const hikaru = { fideId: '2016192', title: 'GM' as const };
    t.db.tx(() => {
      indexReferencePlayer(t.db, dbId, { ...hikaru, name: 'Nakamura, H.', rating: 2780, federation: null }, Date.UTC(2025, 0, 1));
      indexReferencePlayer(t.db, dbId, { ...hikaru, name: 'Nakamura, Hikaru', rating: 2800, federation: 'USA' }, Date.UTC(2026, 0, 1));
      // An older game keeps the newer spelling.
      indexReferencePlayer(t.db, dbId, { ...hikaru, name: 'Nakamura Hik.', rating: 2700, federation: null }, Date.UTC(2024, 0, 1));
    });
    expect(searchReferencePlayers(t.db, 'hikaru nakamura')).toMatchObject([
      { fideId: '2016192', name: 'Nakamura, Hikaru', games: 3, lastRating: 2800, maxRating: 2800, federation: 'USA', title: 'GM' },
    ]);
    expect(searchReferencePlayers(t.db, 'Nakamura, H')).toHaveLength(1);
    expect(searchReferencePlayers(t.db, 'hik')).toHaveLength(1);
    expect(t.db.all('SELECT word FROM reference_player_words ORDER BY word').map(r => (r as { word: string }).word)).toEqual(['hikaru', 'nakamura']);
  });

  it('links FIDE sources: insertGame matches by FIDE id, and sources created mid-way are rebuilt', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    const alpha = createSource(t.db, { kind: 'fide', key: '900001', displayName: 'Alpha, Test' });
    await runMonth(dbId, '2026-01');
    expect(t.db.all('SELECT color, outcome, opp_name, opp_key, opp_source_kind, time_class FROM player_games WHERE source_id = ?', [alpha])).toEqual([
      { color: 'w', outcome: 'w', opp_name: 'Beta, Test', opp_key: '900002', opp_source_kind: 'fide', time_class: 'classical' },
    ]);
    // A source added after its first games were stored: the next import touching it backfills them.
    const epsilon = createSource(t.db, { kind: 'fide', key: '900005' });
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [epsilon])).toBe(0);
    await runMonth(dbId, '2026-02');
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [epsilon])).toBe(2);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [alpha])).toBe(2);
    expect(linkFideSources(t.db, new Set(['900005', '900001']))).toBe(0);
    // A pgn source for a name-only player of the reference DB (ReferencePlayer.databaseId) matches too.
    const club = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(dbId, 'Second Club Player'), databaseId: dbId });
    expect(rebuildPlayerGames(t.db, club)).toBe(1);
    expect(t.db.get('SELECT color, outcome, opp_source_kind FROM player_games WHERE source_id = ?', [club])).toEqual({
      color: 'b',
      outcome: 'w',
      opp_source_kind: 'pgn',
    });
  });

  it('records failures: unpublished months, corrupt downloads; cancellation stops without a record', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    await expect(runMonth(dbId, '2026-03')).rejects.toThrow(/not published/);
    expect(t.db.get('SELECT status, error FROM reference_broadcast_months WHERE month = ?', ['2026-03'])).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/not published/),
    });
    await expect(runMonth(dbId, '2026-13')).rejects.toThrow(/not a month/);
    const { ctx } = makeJobContext(t, 'broadcastMonth', { databaseId: 999, month: '2026-01' });
    await expect(getJobHandler('broadcastMonth')!(ctx)).rejects.toThrow(/no longer exists/);

    // Cancel mid-stream: a big month, aborted after the first batch.
    const many: string[] = [];
    for (let i = 0; i < 400; i++) {
      many.push(`[White "Player ${i}"]\n[Black "Opponent ${i}"]\n[Date "2025.12.01"]\n[Result "1-0"]\n[BroadcastName "Big"]\n\n1. e4 e5 2. Nf3 1-0\n`);
    }
    const big = zstdCompressSync(Buffer.from(many.join('\n')));
    const net2 = fakeNetwork({ [MONTH_URL('2025-12')]: bytes(big) });
    const t2 = await makeTestApp({ fetch: net2.fetch });
    try {
      const id = ensureBroadcastDatabase(t2.db);
      const job = makeJobContext(t2, 'broadcastMonth', { databaseId: id, month: '2025-12' });
      const seen: JobProgress[] = [];
      job.ctx.progress = p => {
        seen.push(p);
        if (p.done >= 100) job.abort();
      };
      await expect(getJobHandler('broadcastMonth')!(job.ctx)).rejects.toMatchObject({ name: 'AbortError' });
      const stored = t2.db.value<number>('SELECT COUNT(*) FROM games')!;
      expect(stored).toBeGreaterThanOrEqual(100);
      expect(stored).toBeLessThan(400);
      expect(t2.db.value('SELECT COUNT(*) FROM reference_broadcast_months')).toBe(0);
      expect(t2.db.value('SELECT game_count FROM databases WHERE id = ?', [id])).toBe(stored);
    } finally {
      await t2.close();
    }
  });

  it('aborts a stalled download with a retryable network error', async () => {
    const zst = fixture('broadcast-2026-01.pgn.zst');
    const stalled = fakeNetwork({
      [MONTH_URL('2025-11')]: (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(zst.subarray(0, 100)));
              init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
        ),
    });
    const t2 = await makeTestApp({ fetch: stalled.fetch });
    DOWNLOAD_IDLE_MS.value = 50;
    try {
      const id = ensureBroadcastDatabase(t2.db);
      const { ctx } = makeJobContext(t2, 'broadcastMonth', { databaseId: id, month: '2025-11' });
      await expect(getJobHandler('broadcastMonth')!(ctx)).rejects.toMatchObject({
        name: 'UpstreamError',
        reason: 'network',
        message: 'database.lichess.org sent no data for 0 s',
      });
      expect(t2.db.value('SELECT status FROM reference_broadcast_months')).toBe('error');
    } finally {
      DOWNLOAD_IDLE_MS.value = 120_000;
      await t2.close();
    }
  });

  it('turns a connection that breaks off mid-body into a retryable network error', async () => {
    const zst = fixture('broadcast-2026-01.pgn.zst');
    const broken = fakeNetwork({
      [MONTH_URL('2025-10')]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(zst.subarray(0, 200)));
              controller.error(new TypeError('terminated'));
            },
          }),
        ),
    });
    const t2 = await makeTestApp({ fetch: broken.fetch });
    try {
      const id = ensureBroadcastDatabase(t2.db);
      const { ctx } = makeJobContext(t2, 'broadcastMonth', { databaseId: id, month: '2025-10' });
      await expect(getJobHandler('broadcastMonth')!(ctx)).rejects.toMatchObject({
        name: 'UpstreamError',
        reason: 'network',
        message: 'The download from database.lichess.org broke off: terminated',
      });
      expect(t2.db.get('SELECT status, error FROM reference_broadcast_months')).toEqual({
        status: 'error',
        error: 'The download from database.lichess.org broke off: terminated',
      });
    } finally {
      await t2.close();
    }
  });

  it('imports an uploaded file (zstd or plain) and deletes it afterwards', async () => {
    const dbId = findOrCreateReferenceDatabase(t.db, { name: 'TWIC', licence: 'Free for non-commercial use' });
    mkdirSync(t.config.uploadsDir, { recursive: true });
    const file = 'reference-1-0123456789abcdef.upload';
    writeFileSync(join(t.config.uploadsDir, file), fixture('broadcast-2026-02.pgn.zst'));
    const { ctx, updates } = makeJobContext(t, 'referenceImport', { databaseId: dbId, file });
    await getJobHandler('referenceImport')!(ctx);
    expect(updates.at(-1)!.counts).toMatchObject({ imported: 3, duplicates: 0 });
    expect(updates.at(-1)!.message).toMatch(/^Upload: 3 new/);
    expect(existsSync(join(t.config.uploadsDir, file))).toBe(false);

    // A missing file, or a name outside the uploads naming scheme, fails cleanly.
    await expect(getJobHandler('referenceImport')!(makeJobContext(t, 'referenceImport', { databaseId: dbId, file }).ctx)).rejects.toThrow(/gone/);
    await expect(
      getJobHandler('referenceImport')!(makeJobContext(t, 'referenceImport', { databaseId: dbId, file: '../outpost.db' }).ctx),
    ).rejects.toThrow(/Invalid upload/);

    // A broken file is removed too (the failure is final).
    const broken = 'reference-2-0123456789abcdef.upload';
    writeFileSync(join(t.config.uploadsDir, broken), Buffer.from('PK\x03\x04zip'));
    await expect(getJobHandler('referenceImport')!(makeJobContext(t, 'referenceImport', { databaseId: dbId, file: broken }).ctx)).rejects.toThrow(
      /ZIP/,
    );
    expect(existsSync(join(t.config.uploadsDir, broken))).toBe(false);
  });

  it('imports a URL (gzip) without sending the token off Lichess, and refuses bad URLs in the job too', async () => {
    const dbId = findOrCreateReferenceDatabase(t.db, { name: 'Club archive' });
    const redirected = (to: string) => () => {
      const res = bytes(fixture('broadcast-2026-02.pgn'))();
      Object.defineProperty(res, 'url', { value: to });
      return res;
    };
    const net3 = fakeNetwork({
      'https://files.example.org/club.pgn.gz': bytes(gzipSync(fixture('broadcast-2026-02.pgn'))),
      'https://lichess.org/api/broadcast/TourAAAA.pgn': bytes(fixture('round-Rnd5EEEE.pgn')),
      'https://files.example.org/moved.pgn': redirected('https://mirror.example.net/moved.pgn'),
      'https://files.example.org/to-http.pgn': redirected('http://files.example.org/to-http.pgn'),
      'https://files.example.org/to-lan.pgn': redirected('https://10.1.2.3/secret.pgn'),
    });
    const t3 = await makeTestApp({ fetch: net3.fetch, env: { LICHESS_TOKEN: 'lip_testtoken' } });
    try {
      const id = findOrCreateReferenceDatabase(t3.db, { name: 'Club archive' });
      const run = async (url: string) => {
        const { ctx, updates } = makeJobContext(t3, 'referenceImport', { databaseId: id, url });
        await getJobHandler('referenceImport')!(ctx);
        return updates.at(-1)!;
      };
      expect((await run('https://files.example.org/club.pgn.gz')).counts).toMatchObject({ imported: 3 });
      expect((await run('https://lichess.org/api/broadcast/TourAAAA.pgn')).counts).toMatchObject({ imported: 2, skipped: 1 });
      expect(net3.calls.map(c => c.auth)).toEqual([null, 'Bearer lip_testtoken']);
      await expect(run('http://files.example.org/club.pgn')).rejects.toThrow(/https/);
      await expect(run('https://files.example.org/missing.pgn')).rejects.toMatchObject({ name: 'UpstreamError', status: 404 });
      // Redirects: another public https host is fine; plain http or a private address is refused.
      expect((await run('https://files.example.org/moved.pgn')).counts).toMatchObject({ imported: 0, duplicates: 3 });
      await expect(run('https://files.example.org/to-http.pgn')).rejects.toThrow(/redirected .*https/);
      await expect(run('https://files.example.org/to-lan.pgn')).rejects.toThrow(/redirected .*not a public host/);
    } finally {
      await t3.close();
    }
    expect(dbId).toBeGreaterThan(0);
  });

  it('refuses URLs whose host resolves to a non-public address, before downloading (redirects too)', async () => {
    const redirected = (to: string) => () => {
      const res = bytes(fixture('broadcast-2026-02.pgn'))();
      Object.defineProperty(res, 'url', { value: to });
      return res;
    };
    const net4 = fakeNetwork({
      'https://files.example.org/to-intranet.pgn': redirected('https://intranet.example.org/secret.pgn'),
      'https://nowhere.example.org/club.pgn': bytes(fixture('broadcast-2026-02.pgn')),
    });
    const t4 = await makeTestApp({ fetch: net4.fetch });
    try {
      const id = findOrCreateReferenceDatabase(t4.db, { name: 'Club archive' });
      const run = async (url: string) => {
        const { ctx, updates } = makeJobContext(t4, 'referenceImport', { databaseId: id, url });
        await getJobHandler('referenceImport')!(ctx);
        return updates.at(-1)!;
      };
      await expect(run('https://intranet.example.org/secret.pgn')).rejects.toThrow('intranet.example.org resolves to a non-public address (10.0.0.5)');
      await expect(run('https://sneaky.example.org/x.pgn')).rejects.toThrow(/non-public address \(::1\)/);
      expect(net4.calls).toEqual([]);
      await expect(run('https://files.example.org/to-intranet.pgn')).rejects.toThrow(/redirected .*non-public address/);
      // A name that does not resolve here (e.g. egress through a proxy) is left to the download.
      expect((await run('https://nowhere.example.org/club.pgn')).counts).toMatchObject({ imported: 3 });
      expect(lookups).toContain('nowhere.example.org');
    } finally {
      await t4.close();
    }
  });

  it('keeps games of user PGN databases off FIDE profiles, whoever writes player_games', () => {
    const priv = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Private prep', 'games', 'private', 0)").lastInsertRowid;
    const ref = ensureBroadcastDatabase(t.db);
    const fide = createSource(t.db, { kind: 'fide', key: '1503014' });
    const carlsen = { name: 'Carlsen, Magnus', fideId: '1503014' };
    const secret = insertGame(t.db, testGame({ origin: 'pgn', originId: `${priv}:secret`, databaseId: priv, white: carlsen, black: { name: 'Somebody' } }));
    expect(secret.inserted).toBe(true);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(0);
    expect(rebuildPlayerGames(t.db, fide)).toBe(0);
    // The database's own pgn source still gets the game.
    const pgnSrc = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(priv, 'Carlsen, Magnus'), databaseId: priv });
    expect(rebuildPlayerGames(t.db, pgnSrc)).toBe(1);
    insertGame(t.db, testGame({ origin: 'reference', originId: `${ref}:public`, databaseId: ref, white: carlsen }));
    expect(t.db.all('SELECT g.origin FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE pg.source_id = ?', [fide])).toEqual([
      { origin: 'reference' },
    ]);
  });

  it('counts a game held by two reference databases once for FIDE players and FIDE profiles', async () => {
    const lichess = ensureBroadcastDatabase(t.db);
    const otb = findOrCreateReferenceDatabase(t.db, { name: 'Licensed OTB', licence: 'Licensed, not for redistribution' });
    const fide = createSource(t.db, { kind: 'fide', key: '900002' });
    await runMonth(lichess, '2026-01');
    expect((await runMonth(otb, '2026-01')).counts).toMatchObject({ imported: 4 });
    expect(t.db.value('SELECT game_count FROM databases WHERE id = ?', [otb])).toBe(4);
    // Beta (900002) played two of the month's games, stored twice each.
    expect(referencePlayerByFideId(t.db, '900002')?.games).toBe(2);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(2);
    expect(rebuildPlayerGames(t.db, fide)).toBe(0);
    expect(linkFideSources(t.db, new Set(['900002']))).toBe(0);
    // Players without a FIDE id are per database.
    expect(searchReferencePlayers(t.db, 'club player').map(p => p.databaseId)).toEqual([lichess, otb, lichess, otb]);
    // Dropping the copies that were counted keeps the count while the other copies remain; the
    // FIDE profile picks those up on its next rebuild.
    t.db.run('DELETE FROM databases WHERE id = ?', [lichess]);
    expect(referencePlayerByFideId(t.db, '900002')?.games).toBe(2);
    expect(rebuildPlayerGames(t.db, fide)).toBe(2);
    t.db.run('DELETE FROM databases WHERE id = ?', [otb]);
    expect(referencePlayerByFideId(t.db, '900002')?.games).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(0);
  });

  it('skips a game too large or too complex for the PGN parser and imports the rest', async () => {
    const dbId = findOrCreateReferenceDatabase(t.db, { name: 'Messy' });
    const huge = `[Event "Huge"]\n[White "Huge, A"]\n[Black "Huge, B"]\n[Result "1-0"]\n\n1. e4 { ${'x'.repeat(1_100_000)} } e5 1-0\n`;
    const complex = `[Event "Complex"]\n[White "Complex, A"]\n[Black "Complex, B"]\n[Result "1-0"]\n\n1. e4 ${'(1. d4) '.repeat(12_000)}e5 1-0\n`;
    mkdirSync(t.config.uploadsDir, { recursive: true });
    const file = 'reference-3-0123456789abcdef.upload';
    writeFileSync(join(t.config.uploadsDir, file), `${huge}\n${complex}\n${fixture('broadcast-2026-02.pgn').toString()}`);
    const { ctx, updates } = makeJobContext(t, 'referenceImport', { databaseId: dbId, file });
    await getJobHandler('referenceImport')!(ctx);
    expect(updates.at(-1)!.counts).toEqual({ imported: 3, duplicates: 0, skipped: 2, tooLarge: 1, tooComplex: 1 });
    expect(updates.at(-1)!.done).toBe(5);
    expect(t.db.value("SELECT COUNT(*) FROM games WHERE white LIKE 'Huge%' OR white LIKE 'Complex%'")).toBe(0);
  });

  it('sweeps orphaned uploads but keeps those of queued jobs and fresh ones', async () => {
    mkdirSync(t.config.uploadsDir, { recursive: true });
    const old = (name: string) => {
      const p = join(t.config.uploadsDir, name);
      writeFileSync(p, 'x');
      utimesSync(p, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    };
    old('reference-1-aaaaaaaaaaaaaaaa.upload');
    old('reference-2-bbbbbbbbbbbbbbbb.upload');
    old('someone-elses.pgn');
    writeFileSync(join(t.config.uploadsDir, 'reference-3-cccccccccccccccc.upload'), 'fresh');
    const dbId = ensureBroadcastDatabase(t.db);
    t.db.run(
      "INSERT INTO jobs (kind, lane, payload_json, status, created_at) VALUES ('referenceImport', 'local', ?, 'queued', ?)",
      [JSON.stringify({ databaseId: dbId, file: 'reference-2-bbbbbbbbbbbbbbbb.upload' }), Date.now()],
    );
    expect(await sweepReferenceUploads(t.db, t.config)).toBe(1);
    expect(readdirSync(t.config.uploadsDir).sort()).toEqual([
      'reference-2-bbbbbbbbbbbbbbbb.upload',
      'reference-3-cccccccccccccccc.upload',
      'someone-elses.pgn',
    ]);
  });
});
