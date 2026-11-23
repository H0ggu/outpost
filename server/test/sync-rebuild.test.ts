import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { enqueueJob, JOB_PRIORITY, loadJobCheckpoint, RequeueJob } from '../src/jobs/index.ts';
import { rebuildHandler, syncHandler } from '../src/sync/index.ts';
import { createSource, makeJobContext, makeTestApp, testGame, type TestApp } from './helpers.ts';

describe('rebuild and local sync jobs', () => {
  let t: TestApp;
  let dbId: number;
  let refDb: number;
  beforeAll(async () => {
    t = await makeTestApp();
    dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Club games', 'games', 0)").lastInsertRowid;
    insertGame(t.db, testGame({ origin: 'pgn', originId: `${dbId}:a`, databaseId: dbId, white: { name: 'Carol Smith' }, black: { name: 'Dave Jones', fideId: '999001' } }));
    insertGame(t.db, testGame({ origin: 'pgn', originId: `${dbId}:b`, databaseId: dbId, white: { name: 'Dave Jones', fideId: '999001' }, black: { name: 'Carol Smith' }, result: '0-1' }));
    // The same player in a reference database: FIDE sources link these games only (decision 1).
    refDb = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('OTB', 'reference', 'public', 0)").lastInsertRowid;
    insertGame(t.db, testGame({ origin: 'reference', originId: `${refDb}:a`, databaseId: refDb, white: { name: 'Erin Park' }, black: { name: 'Jones, Dave', fideId: '999001' } }));
    insertGame(t.db, testGame({ origin: 'reference', originId: `${refDb}:b`, databaseId: refDb, white: { name: 'Jones, Dave', fideId: '999001' }, black: { name: 'Erin Park' }, result: '0-1' }));
  });
  afterAll(async () => t.close());

  it('links a pgn source added after the import (sync of a local source)', async () => {
    const carol = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(dbId, 'Carol Smith'), databaseId: dbId });
    const { ctx, updates } = makeJobContext(t, 'sync', { sourceId: carol });
    expect(ctx.job.lane).toBe('local');
    await syncHandler(ctx);
    expect(t.db.all('SELECT color, outcome FROM player_games WHERE source_id = ? ORDER BY game_id', [carol])).toEqual([
      { color: 'w', outcome: 'w' },
      { color: 'b', outcome: 'w' },
    ]);
    expect(updates.at(-1)).toMatchObject({ done: 2, counts: { imported: 2 } });
    expect(t.db.get('SELECT last_synced_at IS NOT NULL AS synced, last_sync_error FROM sources WHERE id = ?', [carol])).toEqual({ synced: 1, last_sync_error: null });
  });

  it('rebuilds a database: player links for its fide players, openings and positions', async () => {
    const fide = createSource(t.db, { kind: 'fide', key: '999001' });
    const fideGames = () => t.db.all('SELECT g.database_id, pg.color FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE pg.source_id = ? ORDER BY g.id', [fide]);
    for (const id of [dbId, refDb]) {
      t.db.run("UPDATE games SET eco = NULL, opening_name = NULL, opening_ply = NULL WHERE database_id = ?", [id]);
      t.db.run('DELETE FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [id]);
    }
    const { ctx, updates } = makeJobContext(t, 'rebuild', { databaseId: refDb });
    await rebuildHandler(ctx);
    expect(fideGames()).toEqual([
      { database_id: refDb, color: 'b' },
      { database_id: refDb, color: 'w' },
    ]);
    expect(t.db.all('SELECT DISTINCT eco, opening_name FROM games WHERE database_id = ?', [refDb])).toEqual([
      { eco: 'C70', opening_name: 'Ruy Lopez: Morphy Defense' },
    ]);
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [refDb])).toBe(14);
    expect(updates.at(-1)).toMatchObject({ done: 2, total: 2, counts: { playerGames: 2, invalid: 0 } });

    // A user database re-indexes its games, but its FideId tags never link the FIDE source.
    const club = makeJobContext(t, 'rebuild', { databaseId: dbId });
    await rebuildHandler(club.ctx);
    expect(fideGames()).toHaveLength(2);
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [dbId])).toBe(14);
    expect(club.updates.at(-1)).toMatchObject({ done: 2, total: 2, counts: { playerGames: 0, invalid: 0 } });
  });

  it('rebuilds one source and rejects bad payloads', async () => {
    const dave = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(dbId, 'Dave Jones'), databaseId: dbId });
    const { ctx } = makeJobContext(t, 'rebuild', { sourceId: dave });
    await rebuildHandler(ctx);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [dave])).toBe(2);
    await expect(rebuildHandler(makeJobContext(t, 'rebuild', {}).ctx)).rejects.toThrow(/sourceId or a databaseId/);
    await expect(rebuildHandler(makeJobContext(t, 'rebuild', { sourceId: 98765 }).ctx)).rejects.toThrow(/does not exist/);
    await expect(rebuildHandler(makeJobContext(t, 'rebuild', { databaseId: 98765 }).ctx)).rejects.toThrow(/does not exist/);
  });

  it('finishes quietly when the source was removed before its sync ran', async () => {
    const { ctx, updates } = makeJobContext(t, 'sync', { sourceId: 424242 });
    await syncHandler(ctx);
    expect(updates.at(-1)?.message).toMatch(/removed/);
  });
});

describe('rebuild in batches', () => {
  let t: TestApp;
  let dbId: number;
  let gameIds: number[];
  const positions = () => t.db.value<number>('SELECT COUNT(*) FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [dbId]);
  const wipe = () => {
    t.db.run('UPDATE games SET eco = NULL, opening_name = NULL, opening_ply = NULL WHERE database_id = ?', [dbId]);
    t.db.run('DELETE FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [dbId]);
  };
  const indexed = () => t.db.all<{ id: number }>('SELECT id FROM games WHERE database_id = ? AND eco IS NOT NULL ORDER BY id', [dbId]).map(r => r.id);

  beforeAll(async () => {
    t = await makeTestApp();
    dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Big', 'games', 0)").lastInsertRowid;
    const other = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Other', 'games', 0)").lastInsertRowid;
    gameIds = [];
    for (let i = 0; i < 7; i++) {
      gameIds.push(insertGame(t.db, testGame({ origin: 'pgn', originId: `${dbId}:g${i}`, databaseId: dbId })).gameId);
      // Games of another database in between: skipped by the walk.
      insertGame(t.db, testGame({ origin: 'pgn', originId: `${other}:g${i}`, databaseId: other }));
    }
  });
  afterAll(async () => t.close());

  it('yields the local lane to a job waiting ahead of it and resumes from its checkpoint', async () => {
    wipe();
    const job = enqueueJob(t.db, 'rebuild', { databaseId: dbId }, { priority: JOB_PRIORITY.background });
    // Nothing else waits: the first run would go on; now a PGN import arrives with a higher priority.
    enqueueJob(t.db, 'pgnImport', { databaseId: dbId, file: '/tmp/none.pgn', originalName: null }, { priority: JOB_PRIORITY.manual });
    const first = makeJobContext(t, 'rebuild', { databaseId: dbId }, { jobId: job.id });
    const err = await rebuildHandler(first.ctx, { batchSize: 2, batchesPerRun: 2 }).catch(e => e);
    expect(err).toBeInstanceOf(RequeueJob);
    expect(err.message).toMatch(/4 of 7 games; yielding/);
    expect(indexed()).toEqual(gameIds.slice(0, 4));
    expect(loadJobCheckpoint(t.db, job.id)).toMatchObject({ linked: true, afterId: gameIds[3], done: 4, total: 7 });

    // The import ran; the next run continues after game 4 and finishes.
    t.db.run("UPDATE jobs SET status = 'done' WHERE kind = 'pgnImport'");
    const second = makeJobContext(t, 'rebuild', { databaseId: dbId }, { jobId: job.id });
    await rebuildHandler(second.ctx, { batchSize: 2, batchesPerRun: 2 });
    expect(second.updates[0]).toMatchObject({ done: 4, total: 7, message: 'Resuming after 4 of 7 games' });
    expect(second.updates.at(-1)).toMatchObject({ done: 7, total: 7, message: expect.stringMatching(/^Rebuilt 7 games/) });
    expect(indexed()).toEqual(gameIds);
    expect(positions()).toBe(7 * 7);
    expect(loadJobCheckpoint(t.db, job.id)).toBeNull();
  });

  it('does not yield to jobs that would run after it', async () => {
    wipe();
    const job = enqueueJob(t.db, 'rebuild', { databaseId: dbId }, { priority: JOB_PRIORITY.manual });
    enqueueJob(t.db, 'pgnImport', { databaseId: dbId, file: '/tmp/later.pgn', originalName: null }, { priority: JOB_PRIORITY.background });
    const { ctx, updates } = makeJobContext(t, 'rebuild', { databaseId: dbId }, { jobId: job.id });
    await rebuildHandler(ctx, { batchSize: 2, batchesPerRun: 1 });
    expect(updates.at(-1)).toMatchObject({ done: 7, total: 7 });
    expect(indexed()).toEqual(gameIds);
  });

  it('resumes after an interruption without re-indexing what was done', async () => {
    wipe();
    const job = enqueueJob(t.db, 'rebuild', { databaseId: dbId });
    const first = makeJobContext(t, 'rebuild', { databaseId: dbId }, { jobId: job.id });
    first.ctx.progress = p => {
      first.updates.push(p);
      if (p.done >= 3) first.abort(); // e.g. the server stops
    };
    await expect(rebuildHandler(first.ctx, { batchSize: 3 })).rejects.toThrow();
    expect(indexed()).toEqual(gameIds.slice(0, 3));
    expect(loadJobCheckpoint(t.db, job.id)).toMatchObject({ afterId: gameIds[2], done: 3 });

    // Game 1 is wiped again: a resumed run does not go back to it.
    t.db.run('UPDATE games SET eco = NULL WHERE id = ?', [gameIds[0]!]);
    const second = makeJobContext(t, 'rebuild', { databaseId: dbId }, { jobId: job.id });
    await rebuildHandler(second.ctx, { batchSize: 3 });
    expect(indexed()).toEqual(gameIds.slice(1));
    expect(second.updates.at(-1)).toMatchObject({ done: 7, total: 7 });
  });

  it('walks a source’s games and a database’s together', async () => {
    wipe();
    const alice = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(dbId, 'alice'), databaseId: dbId });
    const { ctx, updates } = makeJobContext(t, 'rebuild', { sourceId: alice, databaseId: dbId });
    await rebuildHandler(ctx, { batchSize: 4 });
    expect(updates.at(-1)).toMatchObject({ done: 7, total: 7, counts: { playerGames: 7 } });
    expect(indexed()).toEqual(gameIds);
  });
});
