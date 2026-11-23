/**
 * A small hand-checked world for the stats and games tests (synthetic players only).
 *
 * Profile `alice` (public, owned by `owner`, display name "Alice Liddell"):
 *   A = lichess `alice`, C = chesscom `alice_cc`, H = lichess `alice_alt` (hidden).
 * Profile `carol-gm` (public, owned by `other`): lichess `carol`.
 * Profile `private-p` (private, owned by `owner`): lichess `zed`.
 *
 * Games (days before `now`):
 *   g1  1d  lichess  alice(W 1500→1508) – bob 1600          1-0 resign      blitz rated   Ruy Lopez (6 plies)
 *   g2  3d  lichess  carol GM 2500 – alice(B 1508→1500)     1-0 mate        rapid rated   Najdorf (10 plies)
 *   g3 10d  chesscom alice_cc(W 1400→1400) – dave 1400      ½   repetition  bullet casual QGD (4 plies)
 *   g4 40d  chesscom bob 1450 – alice_cc(B 1400→1390)       1-0 timeout     blitz rated   Ruy Lopez (6), "Titled Tuesday"
 *   g5 400d lichess  alice(W 1450→1460) – carol GM 2450     1-0 mate        blitz rated   Ruy Lopez Closed (10 plies)
 *   g6  5d  lichess  alice_alt(W 1700) – erin 1700          0-1 resign      classical     (hidden source)
 *   g7  2d  lichess  bob – carol                            1-0 (carol-gm's game, not alice's)
 *   g8  2d  lichess  zed – bob                              0-1 (private-p's game)
 *
 * players_cache: lichess bob → NO, lichess carol → US (GM), chesscom dave → XE (England → GB),
 * lichess erin queued (fetched_at NULL); chesscom bob has no row.
 */
import type { Id } from '@outpost/shared/api';
import { insertGame } from '../src/chess/store.ts';
import type { Db } from '../src/db/index.ts';
import { createSource, createUserSession, testGame, type TestApp } from './helpers.ts';

export const DAY = 86_400_000;

export const RUY = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
export const NAJDORF = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
export const QGD = ['d4', 'd5', 'c4', 'e6'];
export const RUY_CLOSED = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];

/** Inserts a profile with sources (`hidden` per source); returns its id. */
export function createProfile(
  db: Db,
  p: { slug: string; displayName?: string; ownerUserId: Id | null; visibility?: 'public' | 'private'; sources: Array<{ id: Id; hidden?: boolean }> },
): Id {
  const now = Date.now();
  const id = db.run(
    'INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [p.slug, p.displayName ?? p.slug, p.ownerUserId, p.visibility ?? 'public', now, now],
  ).lastInsertRowid;
  for (const s of p.sources) db.run('INSERT INTO profile_sources (profile_id, source_id, hidden) VALUES (?, ?, ?)', [id, s.id, s.hidden ?? false]);
  return id;
}

export interface AliceWorld {
  now: number;
  users: { owner: { id: Id; cookie: string }; other: { id: Id; cookie: string }; admin: { id: Id; cookie: string } };
  src: { A: Id; C: Id; H: Id; carol: Id; zed: Id };
  g: Record<'g1' | 'g2' | 'g3' | 'g4' | 'g5' | 'g6' | 'g7' | 'g8', Id>;
}

/** Seeds the world described in the module comment. */
export function seedAliceWorld(t: TestApp, now = Date.now()): AliceWorld {
  const db = t.db;
  const owner = createUserSession(db, { username: 'owner' });
  const other = createUserSession(db, { username: 'other' });
  const admin = createUserSession(db, { username: 'boss', role: 'admin' });
  const A = createSource(db, { kind: 'lichess', key: 'alice', displayName: 'Alice' });
  const C = createSource(db, { kind: 'chesscom', key: 'alice_cc' });
  const H = createSource(db, { kind: 'lichess', key: 'alice_alt' });
  const carol = createSource(db, { kind: 'lichess', key: 'carol' });
  const zed = createSource(db, { kind: 'lichess', key: 'zed' });
  createProfile(db, {
    slug: 'alice',
    displayName: 'Alice Liddell',
    ownerUserId: owner.userId,
    sources: [{ id: A }, { id: C }, { id: H, hidden: true }],
  });
  createProfile(db, { slug: 'carol-gm', ownerUserId: other.userId, sources: [{ id: carol }] });
  createProfile(db, { slug: 'private-p', ownerUserId: owner.userId, visibility: 'private', sources: [{ id: zed }] });

  const at = (days: number) => ({ startedAt: now - days * DAY - 600_000, endedAt: now - days * DAY });
  const g = {
    g1: insertGame(
      db,
      testGame({
        ...at(1),
        white: { name: 'alice', rating: 1500, ratingAfter: 1508, accuracy: 91.5 },
        black: { name: 'bob', rating: 1600 },
        result: '1-0',
        termination: 'resign',
        timeClass: 'blitz',
        moves: RUY,
        url: 'https://lichess.org/g1aaaaaa',
      }),
    ).gameId,
    g2: insertGame(
      db,
      testGame({
        ...at(3),
        white: { name: 'carol', rating: 2500, title: 'GM' },
        black: { name: 'alice', rating: 1508, ratingAfter: 1500 },
        result: '1-0',
        termination: 'mate',
        timeClass: 'rapid',
        timeControl: '600+0',
        moves: NAJDORF,
      }),
    ).gameId,
    g3: insertGame(
      db,
      testGame({
        ...at(10),
        origin: 'chesscom',
        white: { name: 'alice_cc', rating: 1400, ratingAfter: 1400 },
        black: { name: 'dave', rating: 1400 },
        result: '1/2-1/2',
        termination: 'repetition',
        timeClass: 'bullet',
        timeControl: '60',
        rated: false,
        moves: QGD,
      }),
    ).gameId,
    g4: insertGame(
      db,
      testGame({
        ...at(40),
        origin: 'chesscom',
        white: { name: 'bob', rating: 1450 },
        black: { name: 'alice_cc', rating: 1400, ratingAfter: 1390 },
        result: '1-0',
        termination: 'timeout',
        timeClass: 'blitz',
        event: 'Titled Tuesday',
        moves: RUY,
      }),
    ).gameId,
    g5: insertGame(
      db,
      testGame({
        ...at(400),
        white: { name: 'alice', rating: 1450, ratingAfter: 1460 },
        black: { name: 'carol', rating: 2450, title: 'GM' },
        result: '1-0',
        termination: 'mate',
        timeClass: 'blitz',
        moves: RUY_CLOSED,
      }),
    ).gameId,
    g6: insertGame(
      db,
      testGame({
        ...at(5),
        white: { name: 'alice_alt', rating: 1700 },
        black: { name: 'erin', rating: 1700 },
        result: '0-1',
        termination: 'resign',
        timeClass: 'classical',
        moves: ['e4', 'e5'],
      }),
    ).gameId,
    g7: insertGame(db, testGame({ ...at(2), white: { name: 'bob' }, black: { name: 'carol' } })).gameId,
    g8: insertGame(db, testGame({ ...at(2), white: { name: 'zed' }, black: { name: 'bob' }, result: '0-1' })).gameId,
  };

  const cache = 'INSERT INTO players_cache (kind, key, country, title, name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)';
  db.run(cache, ['lichess', 'bob', 'NO', null, 'bob', now]);
  db.run(cache, ['lichess', 'carol', 'US', 'GM', 'carol', now]);
  db.run(cache, ['chesscom', 'dave', 'XE', null, 'dave', now]);
  db.run(cache, ['lichess', 'erin', null, null, null, null]);

  return {
    now,
    users: {
      owner: { id: owner.userId, cookie: owner.cookie },
      other: { id: other.userId, cookie: other.cookie },
      admin: { id: admin.userId, cookie: admin.cookie },
    },
    src: { A, C, H, carol, zed },
    g,
  };
}

/** GET helper returning status and parsed JSON (or text for non-JSON). */
export async function get<T = unknown>(t: TestApp, url: string, cookie?: string): Promise<{ status: number; body: T; headers: Record<string, unknown>; text: string }> {
  const res = await t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const isJson = String(res.headers['content-type'] ?? '').includes('json');
  return { status: res.statusCode, body: (isJson ? res.json() : undefined) as T, headers: res.headers, text: res.body };
}
