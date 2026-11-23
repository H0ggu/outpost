import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginUserDeletion } from '../src/auth/admin.ts';
import { createUserPurger } from '../src/auth/purge.ts';
import { insertGame } from '../src/chess/store.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createUserSession, testGame } from './helpers.ts';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => {
  db.close();
});

const fakeLog = () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log, logger: log as unknown as FastifyBaseLogger };
};

const count = (sql: string, params: Array<number | string> = []): number => db.value<number>(sql, params) ?? 0;

/** A user with two games databases of `perDb` games each, plus a reference database and small rows. */
function seedUser(name: string, perDb = 5) {
  const { userId } = createUserSession(db, { username: name });
  const now = Date.now();
  const dbs: number[] = [];
  for (const label of ['A', 'B']) {
    const id = db.run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, ?, 'games', 'public', ?)", [
      userId,
      `${name}-${label}`,
      now,
    ]).lastInsertRowid;
    for (let i = 0; i < perDb; i++) insertGame(db, testGame({ origin: 'pgn', originId: `${id}:g${i}`, databaseId: id }));
    dbs.push(id);
  }
  const refDb = db.run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'ref', 'reference', 'public', ?)", [
    userId,
    now,
  ]).lastInsertRowid;
  insertGame(db, testGame({ origin: 'reference', originId: `ref:${name}`, databaseId: refDb }));
  db.run("INSERT INTO profiles (slug, display_name, owner_user_id, created_at, updated_at) VALUES (?, 'P', ?, ?, ?)", [`${name}-p`, userId, now, now]);
  db.run("INSERT INTO files (owner_user_id, name, kind, pgn, created_at, updated_at) VALUES (?, 'rep', 'repertoire', '*', ?, ?)", [userId, now, now]);
  db.run("INSERT INTO prep_sets (owner_user_id, name, created_at, updated_at) VALUES (?, 'Open', ?, ?)", [userId, now, now]);
  db.run("INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)", [`${name}-unused`, userId, now]);
  db.run('INSERT INTO known_devices (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)', [`dev-${name}`, userId, now, now]);
  return { userId, dbs, refDb };
}

describe('beginUserDeletion', () => {
  it('disables, signs out and hides the user at once and removes their small rows', () => {
    const { userId: adminId } = createUserSession(db, { username: 'root', role: 'admin' });
    const bob = seedUser('bob');
    const used = db.run("INSERT INTO invites (code, created_by, created_at, used_by, used_at) VALUES ('bob-used', ?, 1, ?, 2)", [bob.userId, adminId]);
    expect(used.changes).toBe(1);
    beginUserDeletion(db, adminId, bob.userId, 1234);

    expect(db.get('SELECT deleting_at, disabled FROM users WHERE id = ?', [bob.userId])).toEqual({ deleting_at: 1234, disabled: 1 });
    expect(count('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [bob.userId])).toBe(0);
    expect(count('SELECT COUNT(*) FROM known_devices WHERE user_id = ?', [bob.userId])).toBe(0);
    expect(count('SELECT COUNT(*) FROM profiles WHERE owner_user_id = ?', [bob.userId])).toBe(0);
    expect(count('SELECT COUNT(*) FROM files WHERE owner_user_id = ?', [bob.userId])).toBe(0);
    expect(count('SELECT COUNT(*) FROM prep_sets WHERE owner_user_id = ?', [bob.userId])).toBe(0);
    // Unused invites they created are cancelled; used ones keep their history.
    expect(count("SELECT COUNT(*) FROM invites WHERE code = 'bob-unused'")).toBe(0);
    expect(count("SELECT COUNT(*) FROM invites WHERE code = 'bob-used'")).toBe(1);
    // The reference database is handed to the system; personal databases wait for the purge, private.
    expect(db.get('SELECT owner_user_id FROM databases WHERE id = ?', [bob.refDb])).toEqual({ owner_user_id: null });
    expect(db.all("SELECT visibility FROM databases WHERE owner_user_id = ? AND kind = 'games'", [bob.userId])).toEqual([
      { visibility: 'private' },
      { visibility: 'private' },
    ]);
    expect(count('SELECT COUNT(*) FROM games WHERE database_id IN (?, ?)', bob.dbs)).toBe(10);

    // Idempotent (a purge that gave up is restarted by deleting again).
    beginUserDeletion(db, adminId, bob.userId, 9999);
    expect(db.value('SELECT deleting_at FROM users WHERE id = ?', [bob.userId])).toBe(1234);
  });

  it('keeps the guards: not yourself, never the last active admin, 404 when unknown', () => {
    const { userId: adminId } = createUserSession(db, { username: 'root', role: 'admin' });
    const { userId: other } = createUserSession(db, { username: 'other', role: 'admin', disabled: true });
    expect(() => beginUserDeletion(db, adminId, adminId)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => beginUserDeletion(db, other, adminId)).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => beginUserDeletion(db, adminId, 999)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(count('SELECT COUNT(*) FROM users WHERE deleting_at IS NOT NULL')).toBe(0);
  });
});

describe('user purger', () => {
  it('removes the games databases in small batches, then the user row; other data stays', async () => {
    const { userId: adminId } = createUserSession(db, { username: 'root', role: 'admin' });
    const bob = seedUser('bob', 5);
    const carol = seedUser('carol', 3);
    const lichessGame = insertGame(db, testGame());
    expect(lichessGame).toBeTruthy();
    beginUserDeletion(db, adminId, bob.userId);

    let pauses = 0;
    const sizes: number[] = [];
    const { logger, log } = fakeLog();
    const purger = createUserPurger({
      db,
      log: logger,
      batchSize: 2,
      pause: async () => {
        pauses++;
        sizes.push(count('SELECT COUNT(*) FROM games WHERE database_id IN (?, ?)', bob.dbs));
      },
    });
    expect(await purger.schedule(bob.userId)).toBe(true);
    // 5 games per database in batches of 2: 3 batches + 1 database delete each.
    expect(pauses).toBe(8);
    expect(sizes.slice(0, 3)).toEqual([8, 6, 5]);
    expect(count('SELECT COUNT(*) FROM users WHERE id = ?', [bob.userId])).toBe(0);
    expect(count('SELECT COUNT(*) FROM databases WHERE id IN (?, ?)', bob.dbs)).toBe(0);
    expect(count("SELECT COUNT(*) FROM games WHERE origin = 'pgn' AND database_id IN (?, ?)", bob.dbs)).toBe(0);
    expect(count('SELECT COUNT(*) FROM positions WHERE game_id NOT IN (SELECT id FROM games)')).toBe(0);
    expect(count('SELECT COUNT(*) FROM player_games WHERE game_id NOT IN (SELECT id FROM games)')).toBe(0);
    // Shared and other users' data stays.
    expect(count('SELECT COUNT(*) FROM databases WHERE id = ?', [bob.refDb])).toBe(1);
    expect(count("SELECT COUNT(*) FROM games WHERE origin = 'reference'")).toBe(2);
    expect(count("SELECT COUNT(*) FROM games WHERE origin = 'lichess'")).toBe(1);
    expect(count('SELECT COUNT(*) FROM games WHERE database_id IN (?, ?)', carol.dbs)).toBe(6);
    expect(count('SELECT COUNT(*) FROM users WHERE id = ?', [carol.userId])).toBe(1);
    expect(log.info).toHaveBeenCalledWith({ userId: bob.userId }, 'deleted user purged');
    await purger.close();
  });

  it('never touches a user that is not marked for deletion; a vanished user counts as done', async () => {
    const bob = seedUser('bob', 1);
    const { logger, log } = fakeLog();
    const purger = createUserPurger({ db, log: logger });
    expect(await purger.schedule(bob.userId)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith({ userId: bob.userId }, 'not purging a user that is not marked for deletion');
    expect(count('SELECT COUNT(*) FROM users WHERE id = ?', [bob.userId])).toBe(1);
    expect(count('SELECT COUNT(*) FROM games WHERE database_id IN (?, ?)', bob.dbs)).toBe(2);
    expect(await purger.schedule(424242)).toBe(true);
    await purger.close();
  });

  it('runs one purge at a time; scheduling the same user twice shares the run', async () => {
    const { userId: adminId } = createUserSession(db, { username: 'root', role: 'admin' });
    const bob = seedUser('bob', 2);
    const carol = seedUser('carol', 2);
    beginUserDeletion(db, adminId, bob.userId);
    beginUserDeletion(db, adminId, carol.userId);
    const order: string[] = [];
    const purger = createUserPurger({
      db,
      log: fakeLog().logger,
      pause: async () => {
        const left = (ids: number[]) => count('SELECT COUNT(*) FROM databases WHERE id IN (?, ?)', ids);
        order.push(`${left(bob.dbs)}/${left(carol.dbs)}`);
      },
    });
    const a = purger.schedule(bob.userId);
    expect(purger.schedule(bob.userId)).toBe(a);
    const b = purger.schedule(carol.userId);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    // bob's databases were all gone before carol's purge touched hers.
    const firstCarol = order.findIndex(s => !s.endsWith('/2'));
    expect(order.slice(firstCarol).every(s => s.startsWith('0/'))).toBe(true);
    expect(count('SELECT COUNT(*) FROM users WHERE deleting_at IS NOT NULL')).toBe(0);
    await purger.close();
  });

  it('stops on close and resumes after a restart', async () => {
    const { userId: adminId } = createUserSession(db, { username: 'root', role: 'admin' });
    const bob = seedUser('bob', 4);
    beginUserDeletion(db, adminId, bob.userId);
    let release: (() => void) | null = null;
    const first = createUserPurger({
      db,
      log: fakeLog().logger,
      batchSize: 1,
      pause: () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    });
    const run = first.schedule(bob.userId);
    await vi.waitFor(() => expect(release).not.toBeNull());
    const closing = first.close();
    release!();
    expect(await run).toBe(false);
    await closing;
    // Partly purged: the user is still marked, some games remain.
    expect(count('SELECT COUNT(*) FROM users WHERE id = ? AND deleting_at IS NOT NULL', [bob.userId])).toBe(1);
    expect(count('SELECT COUNT(*) FROM games WHERE database_id IN (?, ?)', bob.dbs)).toBeGreaterThan(0);
    // A closed purger does nothing more.
    expect(await first.schedule(bob.userId)).toBe(false);

    const second = createUserPurger({ db, log: fakeLog().logger });
    second.resumePending();
    await vi.waitFor(() => expect(count('SELECT COUNT(*) FROM users WHERE id = ?', [bob.userId])).toBe(0));
    expect(count('SELECT COUNT(*) FROM databases WHERE id IN (?, ?)', bob.dbs)).toBe(0);
    await second.close();
  });

  it('retries after an error (e.g. a busy database) and gives up after a few attempts', async () => {
    const { userId: adminId } = createUserSession(db, { username: 'root', role: 'admin' });
    const bob = seedUser('bob', 2);
    beginUserDeletion(db, adminId, bob.userId);
    let failures = 1;
    const flaky = {
      get: db.get.bind(db),
      value: db.value.bind(db),
      all: db.all.bind(db),
      run: db.run.bind(db),
      tx: <T>(fn: () => T): T => {
        if (failures > 0) {
          failures--;
          throw new Error('database is locked');
        }
        return db.tx(fn);
      },
    } as unknown as Db;
    const { logger, log } = fakeLog();
    expect(await createUserPurger({ db: flaky, log: logger, retryMs: 1 }).schedule(bob.userId)).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(count('SELECT COUNT(*) FROM users WHERE id = ?', [bob.userId])).toBe(0);

    const carol = seedUser('carol', 1);
    beginUserDeletion(db, adminId, carol.userId);
    failures = Number.POSITIVE_INFINITY;
    const gaveUp = fakeLog();
    expect(await createUserPurger({ db: flaky, log: gaveUp.logger, retryMs: 1 }).schedule(carol.userId)).toBe(false);
    expect(gaveUp.log.error).toHaveBeenCalledTimes(1);
    expect(count('SELECT COUNT(*) FROM users WHERE id = ? AND deleting_at IS NOT NULL', [carol.userId])).toBe(1);
  });
});
