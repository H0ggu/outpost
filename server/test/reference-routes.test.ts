import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportJobsResponse, ImportResponse, ReferenceInfo, ReferencePlayersResponse } from '@outpost/shared/api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getJobHandler } from '../src/jobs/index.ts';
import { ensureBroadcastDatabase, LICHESS_BROADCAST_ATTRIBUTION } from '../src/reference/databases.ts';
import { addMonths, monthOf } from '../src/reference/months.ts';
import { REFERENCE_LIMITS } from '../src/reference/stream.ts';
import { writeSettings } from '../src/settings.ts';
import { createSource, createUserSession, makeJobContext, makeTestApp, mutationHeaders, type TestApp } from './helpers.ts';

const FIXTURES = new URL('./fixtures/reference/', import.meta.url);
const fixture = (name: string): Buffer => readFileSync(new URL(name, FIXTURES));

/** A multipart/form-data body. */
function multipart(parts: Array<{ name: string; value: string } | { name: string; filename: string; content: Buffer }>) {
  const boundary = `----outpost${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        p.content,
        Buffer.from('\r\n'),
      );
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { ...mutationHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const lastMonth = addMonths(monthOf(Date.now()), -1);
const twoMonthsAgo = addMonths(monthOf(Date.now()), -2);

describe('reference routes', () => {
  let t: TestApp;
  let admin: string;
  let user: string;
  let listCalls = 0;

  beforeAll(async () => {
    t = await makeTestApp({
      fetch: async input => {
        const url = String(input);
        if (url === 'https://database.lichess.org/broadcast/list.txt') {
          listCalls++;
          return new Response(
            'https://database.lichess.org/broadcast/lichess_db_broadcast_2020-02.pgn.zst\n' +
              'https://database.lichess.org/broadcast/lichess_db_broadcast_2020-01.pgn.zst\n',
          );
        }
        if (url === 'https://database.lichess.org/broadcast/lichess_db_broadcast_2020-01.pgn.zst') {
          const b = fixture('broadcast-2026-01.pgn.zst');
          return new Response(new Uint8Array(b));
        }
        throw new Error(`unexpected request ${url}`);
      },
    });
    admin = createUserSession(t.db, { username: 'admin', role: 'admin' }).cookie;
    user = createUserSession(t.db, { username: 'user' }).cookie;
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    REFERENCE_LIMITS.uploadBytes = 2 * 1024 ** 3;
  });

  const post = (url: string, cookie: string | null, body: unknown) =>
    t.app.inject({ method: 'POST', url, headers: { ...mutationHeaders, ...(cookie ? { cookie } : {}) }, payload: body as object });

  it('admin endpoints need an admin; reads need a viewer', async () => {
    for (const url of ['/api/admin/reference/broadcast-months', '/api/admin/reference/import']) {
      expect((await post(url, null, { months: [lastMonth] })).statusCode).toBe(401);
      expect((await post(url, user, { months: [lastMonth] })).json().error.code).toBe('forbidden');
    }
    expect((await t.app.inject({ url: '/api/reference' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/reference/players?q=a' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/reference', headers: { cookie: user } })).statusCode).toBe(200);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      expect((await t.app.inject({ url: '/api/reference/players?q=a' })).statusCode).toBe(200);
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
  });

  it('queues broadcast months (validated, deduplicated) into the built-in database', async () => {
    const bad = await post('/api/admin/reference/broadcast-months', admin, { months: [lastMonth, '2019-12'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'validation', message: expect.stringMatching(/before the first/) });
    expect((await post('/api/admin/reference/broadcast-months', admin, { months: [monthOf(Date.now())] })).json().error.message).toMatch(/not over/);
    expect((await post('/api/admin/reference/broadcast-months', admin, { months: [] })).statusCode).toBe(400);
    expect((await post('/api/admin/reference/broadcast-months', admin, { months: ['2026-01'], extra: 1 })).statusCode).toBe(400);
    expect((await post('/api/admin/reference/broadcast-months', admin, { months: ['2026-01'], databaseId: 9999 })).statusCode).toBe(404);

    const res = await post('/api/admin/reference/broadcast-months', admin, { months: [lastMonth, twoMonthsAgo, lastMonth] });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json<ImportJobsResponse>();
    expect(jobs.map(j => [j.kind, j.lane, j.status, j.label])).toEqual([
      ['broadcastMonth', 'local', 'queued', `Lichess broadcasts ${twoMonthsAgo}`],
      ['broadcastMonth', 'local', 'queued', `Lichess broadcasts ${lastMonth}`],
    ]);
    // Asking again returns the queued jobs instead of new ones.
    const again = (await post('/api/admin/reference/broadcast-months', admin, { months: [lastMonth] })).json<ImportJobsResponse>();
    expect(again.jobs[0]!.id).toBe(jobs[1]!.id);

    const info = (await t.app.inject({ url: '/api/reference', headers: { cookie: admin } })).json<ReferenceInfo>();
    expect(info.databases).toHaveLength(1);
    expect(info.databases[0]).toMatchObject({
      name: 'Lichess broadcasts',
      kind: 'reference',
      visibility: 'public',
      licence: 'CC BY-SA 4.0',
      owner: null,
      canEdit: true,
      gameCount: 0,
      importJob: { kind: 'broadcastMonth', status: 'queued' },
    });
    expect(info.attribution).toEqual([LICHESS_BROADCAST_ATTRIBUTION]);
    const byMonth = new Map(info.broadcastMonths.map(m => [m.month, m.status]));
    expect(byMonth.get(lastMonth)).toBe('queued');
    expect(byMonth.get('2020-01')).toBe('available');
    expect(listCalls).toBe(1);
    // A non-admin sees the same (cached) list and cannot edit.
    const asUser = (await t.app.inject({ url: '/api/reference', headers: { cookie: user } })).json<ReferenceInfo>();
    expect(asUser.databases[0]!.canEdit).toBe(false);
    expect(listCalls).toBe(1);
    t.db.run("UPDATE jobs SET status = 'cancelled'");
  });

  it('shows imported months, counts and players after a month job ran', async () => {
    const dbId = ensureBroadcastDatabase(t.db);
    const { ctx } = makeJobContext(t, 'broadcastMonth', { databaseId: dbId, month: '2020-01' });
    await getJobHandler('broadcastMonth')!(ctx);
    const info = (await t.app.inject({ url: '/api/reference', headers: { cookie: user } })).json<ReferenceInfo>();
    expect(info.totalGames).toBe(4);
    expect(info.broadcastMonths.find(m => m.month === '2020-01')).toMatchObject({ status: 'imported', games: 4, importedAt: expect.any(Number), error: null });
    expect(info.broadcastMonths[0]!.month > info.broadcastMonths.at(-1)!.month).toBe(true);

    const players = (q: string, cookie = user) =>
      t.app.inject({ url: `/api/reference/players?q=${encodeURIComponent(q)}`, headers: { cookie } });
    const alpha = (await players('alpha')).json<ReferencePlayersResponse>().players;
    expect(alpha).toEqual([
      {
        fideId: '900001',
        name: 'Alpha, Test',
        title: 'GM',
        federation: null,
        games: 1,
        lastPlayed: Date.UTC(2026, 0, 10, 14),
        maxRating: 2650,
        lastRating: 2650,
        databaseId: null,
        profileSlug: null,
      },
    ]);
    expect((await players('9000')).json<ReferencePlayersResponse>().players.length).toBe(5);
    expect((await t.app.inject({ url: '/api/reference/players?limit=500', headers: { cookie: user } })).statusCode).toBe(400);

    // profileSlug: public profiles for everyone, private ones for their owner.
    const src = createSource(t.db, { kind: 'fide', key: '900001' });
    const { lastInsertRowid: pid } = t.db.run(
      "INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES ('alpha-test', 'Alpha', 1, 'private', 0, 0)",
    );
    t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?)', [pid, src]);
    expect((await players('alpha')).json<ReferencePlayersResponse>().players[0]!.profileSlug).toBeNull();
    expect((await players('alpha', admin)).json<ReferencePlayersResponse>().players[0]!.profileSlug).toBe('alpha-test');
    t.db.run("UPDATE profiles SET visibility = 'public'");
    expect((await players('alpha')).json<ReferencePlayersResponse>().players[0]!.profileSlug).toBe('alpha-test');
  });

  it('streams a multipart upload to disk and queues an import into a named database', async () => {
    const { payload, headers } = multipart([
      { name: 'databaseName', value: 'My OTB archive' },
      { name: 'file', filename: 'games.pgn.zst', content: fixture('broadcast-2026-02.pgn.zst') },
      { name: 'licence', value: 'CC0' },
      { name: 'sourceLabel', value: 'Club bulletins' },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/reference/import', headers: { ...headers, cookie: admin }, payload });
    expect(res.statusCode).toBe(200);
    const { job } = res.json<ImportResponse>();
    expect(job).toMatchObject({ kind: 'referenceImport', lane: 'local', status: 'queued', label: 'Reference import into My OTB archive' });
    const payloadJson = JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [job.id])!);
    expect(payloadJson.file).toMatch(/^reference-\d+-[0-9a-f]{16}\.upload$/);
    expect(readFileSync(join(t.config.uploadsDir, payloadJson.file))).toEqual(fixture('broadcast-2026-02.pgn.zst'));
    const db = t.db.get<Record<string, unknown>>('SELECT kind, visibility, licence, source_label, owner_user_id FROM databases WHERE id = ?', [
      payloadJson.databaseId,
    ]);
    expect(db).toEqual({ kind: 'reference', visibility: 'public', licence: 'CC0', source_label: 'Club bulletins', owner_user_id: null });

    const { ctx } = makeJobContext(t, 'referenceImport', payloadJson);
    await getJobHandler('referenceImport')!(ctx);
    expect(existsSync(join(t.config.uploadsDir, payloadJson.file))).toBe(false);
    const info = (await t.app.inject({ url: '/api/reference', headers: { cookie: admin } })).json<ReferenceInfo>();
    expect(info.databases.map(d => [d.name, d.gameCount])).toEqual([
      ['Lichess broadcasts', 4],
      ['My OTB archive', 3],
    ]);
    expect(info.attribution).toEqual([LICHESS_BROADCAST_ATTRIBUTION, 'My OTB archive (Club bulletins): CC0']);

    // The same name reuses the database (case-insensitive).
    const again = multipart([
      { name: 'file', filename: 'more.pgn', content: fixture('broadcast-2026-02.pgn') },
      { name: 'databaseName', value: 'my otb ARCHIVE' },
    ]);
    const r2 = await t.app.inject({ method: 'POST', url: '/api/admin/reference/import', headers: { ...again.headers, cookie: admin }, payload: again.payload });
    expect(JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [r2.json<ImportResponse>().job.id])!).databaseId).toBe(
      payloadJson.databaseId,
    );
  });

  it('rejects bad uploads and leaves nothing on disk', async () => {
    const before = readdirSync(t.config.uploadsDir).length;
    const send = async (parts: Parameters<typeof multipart>[0]) => {
      const { payload, headers } = multipart(parts);
      return t.app.inject({ method: 'POST', url: '/api/admin/reference/import', headers: { ...headers, cookie: admin }, payload });
    };
    const noTarget = await send([{ name: 'file', filename: 'a.pgn', content: fixture('broadcast-2026-02.pgn') }]);
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json().error.message).toMatch(/databaseId or databaseName/);
    expect((await send([{ name: 'databaseName', value: 'X' }])).json().error.message).toMatch(/field "file"/);
    expect((await send([{ name: 'file', filename: 'a.pgn', content: Buffer.alloc(0) }, { name: 'databaseName', value: 'X' }])).json().error.message).toMatch(
      /empty/,
    );
    expect(
      (await send([{ name: 'other', filename: 'a.pgn', content: Buffer.from('x') }, { name: 'databaseName', value: 'X' }])).statusCode,
    ).toBe(400);
    expect(
      (
        await send([
          { name: 'file', filename: 'a.pgn', content: fixture('broadcast-2026-02.pgn') },
          { name: 'databaseName', value: 'X' },
          { name: 'url', value: 'https://example.com/a.pgn' },
        ])
      ).json().error.message,
    ).toMatch(/not both/);
    expect(
      (await send([{ name: 'file', filename: 'a.pgn', content: fixture('broadcast-2026-02.pgn') }, { name: 'databaseId', value: '424242' }]))
        .statusCode,
    ).toBe(404);

    REFERENCE_LIMITS.uploadBytes = 1000;
    const tooBig = await send([
      { name: 'databaseName', value: 'X' },
      { name: 'file', filename: 'a.pgn', content: Buffer.alloc(5000, 'a') },
    ]);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('payload_too_large');
    expect(readdirSync(t.config.uploadsDir).length).toBe(before);
    expect(t.db.value("SELECT COUNT(*) FROM databases WHERE name = 'X'")).toBe(0);
  });

  it('queues URL imports: generic https, Lichess tours and rounds (token required for rounds)', async () => {
    const json = (body: unknown) => post('/api/admin/reference/import', admin, body);
    expect((await json({})).json().error.message).toMatch(/file .* or a url/);
    expect((await json({ url: 'http://example.com/a.pgn', databaseName: 'Web' })).json().error.message).toMatch(/https/);
    expect((await json({ url: 'https://192.168.1.5/a.pgn', databaseName: 'Web' })).json().error.message).toMatch(/public host/);
    expect((await json({ url: 'https://example.com/a.pgn' })).json().error.message).toMatch(/databaseId or databaseName/);
    expect((await json({ url: 'https://example.com/a.pgn', databaseName: 'Web', bogus: true })).statusCode).toBe(400);

    const generic = (await json({ url: 'https://example.com/a.pgn', databaseName: 'Web' })).json<ImportResponse>();
    expect(generic.job).toMatchObject({ kind: 'referenceImport', status: 'queued' });
    expect(JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [generic.job.id])!)).toMatchObject({
      url: 'https://example.com/a.pgn',
    });

    const tour = (await json({ url: 'https://lichess.org/broadcast/outpost-test-open-2026/TourAAAA' })).json<ImportResponse>();
    expect(JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [tour.job.id])!)).toEqual({
      databaseId: ensureBroadcastDatabase(t.db),
      url: 'https://lichess.org/api/broadcast/TourAAAA.pgn',
    });

    const round = await json({ url: 'https://lichess.org/broadcast/outpost-test-open-2026/round-3/Rnd5EEEE' });
    expect(round.statusCode).toBe(503);
    expect(round.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'no_token' } });
    writeSettings(t.db, { lichessToken: 'lip_testtoken' });
    try {
      const ok = (await json({ url: 'https://lichess.org/broadcast/outpost-test-open-2026/round-3/Rnd5EEEE/Game0008' })).json<ImportResponse>();
      expect(ok.job).toMatchObject({ kind: 'broadcastRound', lane: 'lichess', label: 'Broadcast round Rnd5EEEE' });
      const dup = (await json({ url: 'https://lichess.org/api/broadcast/round/Rnd5EEEE.pgn' })).json<ImportResponse>();
      expect(dup.job.id).toBe(ok.job.id);
    } finally {
      writeSettings(t.db, { lichessToken: null });
    }
  });
});
