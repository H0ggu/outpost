import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/http/types.ts';
import { loadDatabaseForViewer, loadProfileByIdForViewer, loadProfileForViewer } from '../src/profiles/access.ts';
import { parsePrefs } from '../src/auth/session.ts';
import { insertGame, rebuildPlayerGames } from '../src/chess/store.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';

const asUser = (id: number, role: 'admin' | 'user' = 'user'): AuthUser => ({
  id,
  username: `u${id}`,
  role,
  totpEnabled: false,
  prefs: parsePrefs(null),
});

describe('profile and database access', () => {
  let t: TestApp;
  let owner: AuthUser;
  let other: AuthUser;
  let admin: AuthUser;
  let visible: number;
  let hidden: number;

  beforeAll(async () => {
    t = await makeTestApp();
    owner = asUser(createUserSession(t.db, { username: 'owner' }).userId);
    other = asUser(createUserSession(t.db, { username: 'other' }).userId);
    admin = asUser(createUserSession(t.db, { username: 'boss', role: 'admin' }).userId, 'admin');
    const now = Date.now();
    for (const [slug, visibility] of [
      ['private-one', 'private'],
      ['public-one', 'public'],
    ] as const) {
      t.db.run(
        'INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [slug, slug, owner.id, visibility, now, now],
      );
    }
    visible = createSource(t.db, { kind: 'lichess', key: 'shown' });
    hidden = createSource(t.db, { kind: 'chesscom', key: 'secret' });
    const pub = t.db.value<number>("SELECT id FROM profiles WHERE slug = 'public-one'")!;
    t.db.run('INSERT INTO profile_sources (profile_id, source_id, hidden) VALUES (?, ?, 0), (?, ?, 1)', [pub, visible, pub, hidden]);
  });
  afterAll(async () => t.close());

  it('hides private profiles from everyone but the owner and admins', () => {
    expect(loadProfileForViewer(t.db, 'private-one', owner).canEdit).toBe(true);
    expect(loadProfileForViewer(t.db, 'private-one', admin).canEdit).toBe(true);
    expect(() => loadProfileForViewer(t.db, 'private-one', other)).toThrow(/not found/);
    expect(() => loadProfileForViewer(t.db, 'private-one', null)).toThrow(/not found/);
    expect(() => loadProfileForViewer(t.db, 'missing', owner)).toThrow(/not found/);
  });

  it('shows hidden sources only to editors', () => {
    expect(loadProfileForViewer(t.db, 'public-one', other)).toMatchObject({ canEdit: false, sourceIds: [visible] });
    expect(loadProfileForViewer(t.db, 'public-one', null).sourceIds).toEqual([visible]);
    expect(loadProfileForViewer(t.db, 'public-one', owner).sourceIds).toEqual([visible, hidden]);
  });

  it('applies database visibility', () => {
    const mine = t.db.run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'mine', 'games', 'private', 0)", [owner.id]).lastInsertRowid;
    const ref = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('ref', 'reference', 'private', 0)").lastInsertRowid;
    expect(loadDatabaseForViewer(t.db, mine, owner).canEdit).toBe(true);
    expect(() => loadDatabaseForViewer(t.db, mine, other)).toThrow(/not found/);
    expect(loadDatabaseForViewer(t.db, ref, null)).toMatchObject({ kind: 'reference', canEdit: false });
    expect(loadDatabaseForViewer(t.db, ref, admin).canEdit).toBe(true);
  });

  it('counts pgn sources only while the viewer may read their database', () => {
    const now = Date.now();
    const privateDb = t.db.run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'club', 'games', 'private', 0)", [
      owner.id,
    ]).lastInsertRowid;
    const refDb = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('ref2', 'reference', 'private', 0)").lastInsertRowid;
    const fromPrivate = createSource(t.db, { kind: 'pgn', key: `${privateDb}:anna`, databaseId: privateDb });
    const fromRef = createSource(t.db, { kind: 'pgn', key: `${refDb}:anna`, databaseId: refDb });
    const lichess = createSource(t.db, { kind: 'lichess', key: 'anna' });
    // A public profile of `other` that uses the owner's private database.
    const p = t.db.run(
      "INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES ('anna', 'Anna', ?, 'public', ?, ?)",
      [other.id, now, now],
    ).lastInsertRowid;
    for (const s of [fromPrivate, fromRef, lichess]) t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?)', [p, s]);
    const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
    expect(loadProfileForViewer(t.db, 'anna', other).sourceIds).toEqual(sorted([fromRef, lichess]));
    expect(loadProfileForViewer(t.db, 'anna', null).sourceIds).toEqual(sorted([fromRef, lichess]));
    expect(loadProfileForViewer(t.db, 'anna', owner).sourceIds).toEqual(sorted([fromPrivate, fromRef, lichess]));
    expect(loadProfileForViewer(t.db, 'anna', admin).sourceIds).toEqual(sorted([fromPrivate, fromRef, lichess]));
    t.db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [privateDb]);
    expect(loadProfileForViewer(t.db, 'anna', other).sourceIds).toEqual(sorted([fromPrivate, fromRef, lichess]));
  });

  it("never reaches a private database's games through a FIDE source", () => {
    const privateDb = t.db.run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'notes', 'games', 'private', 0)", [
      owner.id,
    ]).lastInsertRowid;
    const fide = createSource(t.db, { kind: 'fide', key: '7000007' });
    const p = t.db.run(
      "INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES ('fide-7', 'F', ?, 'public', 0, 0)",
      [other.id],
    ).lastInsertRowid;
    t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?)', [p, fide]);
    insertGame(t.db, testGame({ origin: 'pgn', originId: `${privateDb}:x`, databaseId: privateDb, white: { name: 'Owner', fideId: '7000007' } }));
    expect(rebuildPlayerGames(t.db, fide)).toBe(0);
    for (const viewer of [null, other, owner, admin]) {
      const { sourceIds } = loadProfileForViewer(t.db, 'fide-7', viewer);
      expect(sourceIds).toEqual([fide]);
      expect(t.db.value(`SELECT COUNT(*) FROM player_games WHERE source_id IN (${sourceIds.map(() => '?').join(',')})`, sourceIds)).toBe(0);
    }
  });

  it('loads profiles by id with the same rules', () => {
    const id = t.db.value<number>("SELECT id FROM profiles WHERE slug = 'private-one'")!;
    expect(loadProfileByIdForViewer(t.db, id, owner).slug).toBe('private-one');
    expect(() => loadProfileByIdForViewer(t.db, id, other)).toThrow(/not found/);
    expect(() => loadProfileByIdForViewer(t.db, 987654, owner)).toThrow(/not found/);
  });
});
