import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/http/types.ts';
import { loadDatabaseForViewer, loadProfileForViewer } from '../src/profiles/access.ts';
import { parsePrefs } from '../src/auth/session.ts';
import { createSource, createUserSession, makeTestApp, type TestApp } from './helpers.ts';

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
});
