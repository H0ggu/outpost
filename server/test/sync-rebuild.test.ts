import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { rebuildHandler, syncHandler } from '../src/sync/index.ts';
import { createSource, makeJobContext, makeTestApp, testGame, type TestApp } from './helpers.ts';

describe('rebuild and local sync jobs', () => {
  let t: TestApp;
  let dbId: number;
  beforeAll(async () => {
    t = await makeTestApp();
    dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Club games', 'games', 0)").lastInsertRowid;
    insertGame(t.db, testGame({ origin: 'pgn', originId: `${dbId}:a`, databaseId: dbId, white: { name: 'Carol Smith' }, black: { name: 'Dave Jones', fideId: '999001' } }));
    insertGame(t.db, testGame({ origin: 'pgn', originId: `${dbId}:b`, databaseId: dbId, white: { name: 'Dave Jones', fideId: '999001' }, black: { name: 'Carol Smith' }, result: '0-1' }));
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
    t.db.run("UPDATE games SET eco = NULL, opening_name = NULL, opening_ply = NULL WHERE database_id = ?", [dbId]);
    t.db.run('DELETE FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [dbId]);
    const { ctx, updates } = makeJobContext(t, 'rebuild', { databaseId: dbId });
    await rebuildHandler(ctx);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(2);
    expect(t.db.all('SELECT DISTINCT eco, opening_name FROM games WHERE database_id = ?', [dbId])).toEqual([
      { eco: 'C70', opening_name: 'Ruy Lopez: Morphy Defense' },
    ]);
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id IN (SELECT id FROM games WHERE database_id = ?)', [dbId])).toBe(14);
    expect(updates.at(-1)).toMatchObject({ done: 2, total: 2, counts: { playerGames: 2, invalid: 0 } });
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
