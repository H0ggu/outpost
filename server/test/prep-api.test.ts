import type { PrepListResponse, PrepReport, PrepSet } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOpeningBook } from '../src/chess/openings.ts';
import { insertGame } from '../src/chess/store.ts';
import type { AuthUser } from '../src/http/types.ts';
import { activityBuckets, buildSide, prepReport } from '../src/prep/index.ts';
import { createSource, createUserSession, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';

type Session = { userId: number; cookie: string };

const RUY8 = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
const NAJDORF8 = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
const QGD = ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'];

describe('prep API', () => {
  let t: TestApp;
  let me: Session;
  let other: Session;
  let admin: Session;
  let carolProfile: number;
  let daveProfile: number;
  let privateOfOther: number;

  const req = (s: Session | null, method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(method === 'GET' ? {} : mutationHeaders), ...(s ? { cookie: s.cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const profile = (slug: string, ownerId: number, visibility: 'public' | 'private', sourceIds: number[]): number => {
    const id = t.db.run(
      'INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
      [slug, slug, ownerId, visibility],
    ).lastInsertRowid;
    for (const s of sourceIds) t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?)', [id, s]);
    return id;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    me = createUserSession(t.db, { username: 'me' });
    other = createUserSession(t.db, { username: 'other' });
    admin = createUserSession(t.db, { username: 'boss', role: 'admin' });
    const carol = createSource(t.db, { kind: 'lichess', key: 'carol', displayName: 'Carol' });
    const dave = createSource(t.db, { kind: 'lichess', key: 'dave' });
    carolProfile = profile('carol', other.userId, 'public', [carol]);
    daveProfile = profile('dave', me.userId, 'private', [dave]);
    privateOfOther = profile('secret', other.userId, 'private', [dave]);
    const at = (day: number, hourUtc: number) => Date.UTC(2026, 0, day, hourUtc);
    // Carol as White: Ruy Lopez 2/3, Najdorf 0/2. As Black: one QGD draw.
    const games: Array<[string[], '1-0' | '0-1' | '1/2-1/2', 'white' | 'black', number]> = [
      [RUY8, '1-0', 'white', at(1, 12)],
      [RUY8, '1-0', 'white', at(2, 12)],
      [RUY8, '0-1', 'white', at(3, 18)],
      [NAJDORF8, '0-1', 'white', at(4, 18)],
      [NAJDORF8, '0-1', 'white', at(5, 18)],
      [QGD, '1/2-1/2', 'black', at(6, 9)],
    ];
    for (const [moves, result, color, startedAt] of games) {
      insertGame(
        t.db,
        testGame({
          moves,
          result,
          startedAt,
          endedAt: startedAt + 600_000,
          white: { name: color === 'white' ? 'carol' : 'zoe', rating: 1800, ratingAfter: 1810 },
          black: { name: color === 'black' ? 'carol' : 'zoe' },
        }),
      );
    }
  });
  afterAll(async () => t.close());

  it('creates, lists, reads, updates and deletes prep sets (owner only)', async () => {
    const created = await req(me, 'POST', '/api/prep', { name: 'Club final', profileIds: [carolProfile, daveProfile, carolProfile] });
    expect(created.statusCode, created.body).toBe(200);
    const set = created.json<PrepSet>();
    expect(set).toMatchObject({ name: 'Club final' });
    expect(set.opponents.map(o => o.slug)).toEqual(['carol', 'dave']);
    expect(set.opponents[0]).toMatchObject({ visibility: 'public', owner: { username: 'other' }, gameCount: 6, sources: [{ kind: 'lichess', key: 'carol', displayName: 'Carol' }] });

    const invisible = await req(me, 'POST', '/api/prep', { name: 'x', profileIds: [privateOfOther, 999_999] });
    expect(invisible.statusCode).toBe(400);
    expect(invisible.json().error.message).toBe(`Unknown profiles ${privateOfOther}, 999999`);
    expect((await req(me, 'POST', '/api/prep', { name: '', profileIds: [] })).statusCode).toBe(400);
    expect((await req(null, 'POST', '/api/prep', { name: 'x', profileIds: [] })).statusCode).toBe(401);
    for (const url of ['/api/prep', `/api/prep/${set.id}`, `/api/prep/${set.id}/report`]) expect((await req(null, 'GET', url)).statusCode, url).toBe(401);

    expect((await req(me, 'GET', '/api/prep')).json<PrepListResponse>().sets.map(s => s.id)).toEqual([set.id]);
    expect((await req(other, 'GET', '/api/prep')).json<PrepListResponse>().sets).toEqual([]);
    for (const s of [other, admin]) {
      expect((await req(s, 'GET', `/api/prep/${set.id}`)).statusCode).toBe(404);
      expect((await req(s, 'GET', `/api/prep/${set.id}/report`)).statusCode).toBe(404);
      expect((await req(s, 'PUT', `/api/prep/${set.id}`, { name: 'mine' })).statusCode).toBe(404);
      expect((await req(s, 'DELETE', `/api/prep/${set.id}`)).statusCode).toBe(404);
    }

    const updated = await req(me, 'PUT', `/api/prep/${set.id}`, { name: 'Club final (round 2)', profileIds: [daveProfile, carolProfile] });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<PrepSet>()).toMatchObject({ name: 'Club final (round 2)' });
    expect(updated.json<PrepSet>().opponents.map(o => o.slug)).toEqual(['dave', 'carol']);
    expect(updated.json<PrepSet>().updatedAt).toBeGreaterThan(set.updatedAt);
    const renamed = (await req(me, 'PUT', `/api/prep/${set.id}`, { name: 'Final' })).json<PrepSet>();
    expect(renamed.opponents.map(o => o.slug)).toEqual(['dave', 'carol']);
    expect((await req(me, 'PUT', `/api/prep/${set.id}`, { profileIds: [privateOfOther] })).statusCode).toBe(400);

    const gone = await req(me, 'POST', '/api/prep', { name: 'Temp', profileIds: [] });
    expect((await req(me, 'DELETE', `/api/prep/${gone.json<PrepSet>().id}`)).json()).toEqual({ ok: true });
    expect((await req(me, 'GET', `/api/prep/${gone.json<PrepSet>().id}`)).statusCode).toBe(404);
  });

  it('reports repertoire lines, recent games, activity and ratings per opponent', async () => {
    const set = (await req(me, 'POST', '/api/prep', { name: 'Report', profileIds: [carolProfile] })).json<PrepSet>();
    const res = await req(me, 'GET', `/api/prep/${set.id}/report?tz=Asia/Tokyo&minGames=2`);
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json<PrepReport>();
    expect(report.prep).toEqual({ id: set.id, name: 'Report' });
    expect(report.generatedAt).toBeGreaterThan(0);
    const [carol] = report.opponents;
    expect(carol!.profile.slug).toBe('carol');

    expect(carol!.asWhite).toMatchObject({ games: 5, wdl: { w: 2, d: 0, l: 3 } });
    expect(carol!.asWhite.topLines.map(l => [l.san, l.games, l.score])).toEqual([
      ['1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6', 3, 2 / 3],
      ['1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6', 2, 0],
    ]);
    const ruy = carol!.asWhite.topLines[0]!;
    expect(ruy).toMatchObject({ line: 'e2e4,e7e5,g1f3,b8c6,f1b5,a7a6,b5a4,g8f6', w: 2, d: 0, l: 1, lastPlayed: Date.UTC(2026, 0, 3, 18) });
    expect(ruy.eco).toMatch(/^C\d\d$/);
    expect(ruy.name).toMatch(/^Ruy Lopez/);
    // Worst first; each shown at its longest form (every Sicilian game went the same 8 plies).
    expect(carol!.asWhite.worstLines.map(l => [l.san, l.games, l.score])).toEqual([
      ['1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6', 2, 0],
      ['1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6', 3, 2 / 3],
    ]);
    expect(carol!.asBlack).toMatchObject({ games: 1, wdl: { w: 0, d: 1, l: 0 }, worstLines: [] });
    expect(carol!.asBlack.topLines.map(l => l.san)).toEqual(['1. d4 d5 2. c4 e6 3. Nc3 Nf6']);

    expect(carol!.recentGames.map(g => g.startedAt)).toEqual([6, 5, 4, 3, 2, 1].map(d => Date.UTC(2026, 0, d, d === 6 ? 9 : d >= 3 ? 18 : 12)));
    expect(carol!.recentGames[0]).toMatchObject({ color: 'black', outcome: 'd', opponent: { name: 'zoe' } });

    // 12:00 UTC is 21:00 in Tokyo, 18:00 UTC is 03:00 the next day.
    expect(carol!.activity.tz).toBe('Asia/Tokyo');
    expect(carol!.activity.byHour[21]).toEqual({ games: 2, score: 1 });
    expect(carol!.activity.byHour[3]).toEqual({ games: 3, score: 0 });
    expect(carol!.activity.byHour[18]).toEqual({ games: 1, score: 0.5 });
    expect(carol!.activity.byHour.reduce((n, c) => n + c.games, 0)).toBe(6);
    expect(carol!.activity.byWeekday).toHaveLength(7);
    // 1 Jan 2026 (Thursday) 21:00 in Tokyo.
    expect(carol!.activity.byWeekday[3]!.games).toBeGreaterThanOrEqual(1);
    expect(carol!.ratings).toEqual([{ sourceId: expect.any(Number), kind: 'lichess', ratings: [{ timeClass: 'blitz', rating: 1500, games: 6, rd: null, provisional: false }] }]); // the newest game (as Black, 1500)
    expect(carol!.sampledGames).toBeNull();
  });

  it('samples the most recent games of opponents with long histories (totals count all)', async () => {
    const set = (await req(me, 'POST', '/api/prep', { name: 'Sampled', profileIds: [carolProfile, daveProfile] })).json<PrepSet>();
    const viewer = { id: me.userId, username: 'me', role: 'user', totpEnabled: false, prefs: {} } as AuthUser;
    const pending = prepReport(t.db, t.config, viewer, set.id, {}, { tz: 'UTC', plies: 8, minGames: 1, maxGames: 3 });
    expect(pending).toBeInstanceOf(Promise);
    const report = await pending;
    const carol = report.opponents[0]!;
    expect(carol.sampledGames).toBe(3);
    // W/D/L over all six games; lines and activity over the newest three (QGD as Black, two Najdorfs as White).
    expect(carol.asWhite).toMatchObject({ games: 5, wdl: { w: 2, d: 0, l: 3 } });
    expect(carol.asWhite.topLines.map(l => [l.san, l.games])).toEqual([['1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6', 2]]);
    expect(carol.asBlack).toMatchObject({ games: 1, wdl: { w: 0, d: 1, l: 0 } });
    expect(carol.activity.byHour.reduce((n, c) => n + c.games, 0)).toBe(3);
    expect(carol.recentGames).toHaveLength(6);
    expect(report.opponents[1]!.sampledGames).toBeNull();
  });

  it('applies the filters and validates the report parameters', async () => {
    const set = (await req(me, 'POST', '/api/prep', { name: 'Filtered', profileIds: [carolProfile, daveProfile] })).json<PrepSet>();
    const white = (await req(me, 'GET', `/api/prep/${set.id}/report?color=white&plies=4`)).json<PrepReport>();
    expect(white.opponents.map(o => o.profile.slug)).toEqual(['carol', 'dave']);
    expect(white.opponents[0]!.asBlack.games).toBe(0);
    expect(white.opponents[0]!.asWhite.topLines.map(l => l.san)).toEqual(['1. e4 e5 2. Nf3 Nc6', '1. e4 c5 2. Nf3 d6']);
    expect(white.opponents[0]!.activity.tz).toBe('UTC');
    expect(white.opponents[1]!.asWhite.games).toBe(0);
    const lost = (await req(me, 'GET', `/api/prep/${set.id}/report?outcome=l&line=e2e4,c7c5`)).json<PrepReport>();
    expect(lost.opponents[0]!.asWhite.games).toBe(2);
    for (const q of ['tz=Mars/Base', 'plies=1', 'minGames=0', 'color=green', 'line=e2e5']) {
      expect((await req(me, 'GET', `/api/prep/${set.id}/report?${q}`)).statusCode, q).toBe(400);
    }
    // An opponent turned private by its owner drops out.
    t.db.run("UPDATE profiles SET visibility = 'private' WHERE id = ?", [carolProfile]);
    expect((await req(me, 'GET', `/api/prep/${set.id}`)).json<PrepSet>().opponents.map(o => o.slug)).toEqual(['dave']);
    expect((await req(me, 'GET', `/api/prep/${set.id}/report`)).json<PrepReport>().opponents.map(o => o.profile.slug)).toEqual(['dave']);
    t.db.run("UPDATE profiles SET visibility = 'public' WHERE id = ?", [carolProfile]);
  });

  it('builds sides from move lists', () => {
    const book = getOpeningBook();
    const side = buildSide(
      book,
      [
        { outcome: 'w', at: 1, sans: ['e4', 'e5'] },
        { outcome: 'l', at: 2, sans: ['e4', 'e5', 'Nf3'] },
        { outcome: 'l', at: 3, sans: ['e4', 'e5', 'Nf3'] },
        { outcome: 'd', at: 4, sans: ['d4', 'Bad'] },
      ],
      { plies: 3, minGames: 2 },
    );
    // Short games end their own line; an illegal move drops the line.
    expect(side.topLines.map(l => [l.san, l.games])).toEqual([
      ['1. e4 e5 2. Nf3', 2],
      ['1. e4 e5', 1],
    ]);
    expect(side.worstLines.map(l => [l.san, l.score])).toEqual([
      ['1. e4 e5 2. Nf3', 0],
      ['1. e4 e5', 1 / 3],
    ]);
    expect(activityBuckets([{ outcome: 'w', at: null }], 'UTC').byHour.every(c => c.games === 0 && c.score === null)).toBe(true);
  });
});
