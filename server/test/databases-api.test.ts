import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DatabaseInfo, DatabasesResponse, DbGamesPage, ImportResponse, JobProgress, ProfileHeader } from '@outpost/shared/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  importSummary,
  MAX_GAMES_PER_USER,
  MAX_PASTE_BYTES,
  MAX_PENDING_IMPORTS,
  runPgnImport,
  saveUploadStream,
  sweepUploads,
} from '../src/databases/index.ts';
import { insertGame } from '../src/chess/index.ts';
import { writeSettings } from '../src/settings.ts';
import { createSource, createUserSession, makeJobContext, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';
import { MIXED_PGN, pgnGame, RUY } from './fixtures/profiles/pgn.ts';

type Session = { userId: number; cookie: string };

const multipart = (filename: string, content: string | Buffer, mimetype = 'application/x-chess-pgn', field = 'file') => {
  const boundary = `----outpost${Math.random().toString(16).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};

describe('databases API', () => {
  let t: TestApp;
  let owner: Session;
  let other: Session;
  let admin: Session;

  /** Client address of the requests (the import route is throttled per IP: tests that import a lot use their own). */
  let clientIp = '127.0.0.1';
  const req = (s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({
      method: method as 'GET',
      url,
      remoteAddress: clientIp,
      headers: { ...(method === 'GET' ? {} : mutationHeaders), ...(s ? { cookie: s.cookie } : {}), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const createDb = async (s: Session, body: Record<string, unknown>): Promise<DatabaseInfo> => {
    const res = await req(s, 'POST', '/api/databases', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<DatabaseInfo>();
  };

  /** Imports pasted PGN and runs the queued job like the worker would. */
  const importPgn = async (s: Session, databaseId: number, pgn: string) => {
    const res = await req(s, 'POST', `/api/databases/${databaseId}/import`, { pgn });
    expect(res.statusCode, res.body).toBe(200);
    const { job } = res.json<ImportResponse>();
    const payload = JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [job.id])!);
    const { ctx, updates } = makeJobContext(t, 'pgnImport', payload, { jobId: job.id, userId: s.userId });
    let error: Error | null = null;
    await runPgnImport(ctx).catch((e: Error) => (error = e));
    const last = updates[updates.length - 1] ?? null;
    // What the worker does with the outcome.
    t.db.run('UPDATE jobs SET status = ?, progress_json = ?, error = ?, finished_at = ? WHERE id = ?', [
      error ? 'error' : 'done',
      last ? JSON.stringify(last) : null,
      error ? (error as Error).message : null,
      Date.now(),
      job.id,
    ]);
    return { job, payload, updates, last: last as JobProgress | null, error: error as Error | null };
  };

  beforeAll(async () => {
    t = await makeTestApp();
    owner = createUserSession(t.db, { username: 'owner' });
    other = createUserSession(t.db, { username: 'other' });
    admin = createUserSession(t.db, { username: 'boss', role: 'admin' });
  });
  afterAll(async () => t.close());
  // Tests run their import jobs directly; settle every leftover so the per-user cap starts fresh.
  beforeEach(() => {
    t.db.run("UPDATE jobs SET status = 'done', finished_at = 0 WHERE kind = 'pgnImport' AND status IN ('queued', 'running')");
  });

  it('creates, lists, reads and edits databases with ownership and visibility', async () => {
    const mine = await createDb(owner, { name: 'My games', sourceLabel: 'OTB scoresheets' });
    expect(mine).toMatchObject({
      name: 'My games',
      kind: 'games',
      visibility: 'private',
      owner: { id: owner.userId, username: 'owner' },
      sourceLabel: 'OTB scoresheets',
      licence: null,
      gameCount: 0,
      canEdit: true,
      importJob: null,
      lastImport: null,
    });
    const shared = await createDb(owner, { name: 'Shared', visibility: 'public', licence: 'CC0' });
    const theirs = await createDb(other, { name: 'Theirs' });

    const ownerList = (await req(owner, 'GET', '/api/databases')).json<DatabasesResponse>().databases;
    expect(ownerList.map(d => d.name)).toEqual(['My games', 'Shared']);
    const otherList = (await req(other, 'GET', '/api/databases')).json<DatabasesResponse>().databases;
    expect(otherList.map(d => [d.name, d.canEdit])).toEqual([
      ['Theirs', true],
      ['Shared', false],
    ]);
    expect((await req(null, 'GET', '/api/databases')).statusCode).toBe(401);
    // Databases need a session even with anonymous browsing on (PLAN §10: only public profiles and their stats are open).
    writeSettings(t.db, { anonymousBrowsing: true });
    for (const url of ['/api/databases', `/api/databases/${shared.id}`, `/api/databases/${shared.id}/games`, `/api/databases/${shared.id}/export.pgn`]) {
      expect((await req(null, 'GET', url)).statusCode, url).toBe(401);
    }
    writeSettings(t.db, { anonymousBrowsing: false });

    expect((await req(other, 'GET', `/api/databases/${mine.id}`)).statusCode).toBe(404);
    expect((await req(other, 'GET', `/api/databases/${shared.id}`)).json<DatabaseInfo>().canEdit).toBe(false);
    expect((await req(other, 'PATCH', `/api/databases/${shared.id}`, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await req(other, 'PATCH', `/api/databases/${mine.id}`, { name: 'Mine now' })).statusCode).toBe(404);
    expect((await req(other, 'DELETE', `/api/databases/${shared.id}`)).statusCode).toBe(403);
    expect((await req(other, 'POST', `/api/databases/${shared.id}/import`, { pgn: RUY })).statusCode).toBe(403);

    const patched = await req(owner, 'PATCH', `/api/databases/${mine.id}`, { name: 'Renamed', visibility: 'public', sourceLabel: null, licence: 'CC BY 4.0' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<DatabaseInfo>()).toMatchObject({ name: 'Renamed', visibility: 'public', sourceLabel: null, licence: 'CC BY 4.0' });
    const byAdmin = await req(admin, 'PATCH', `/api/databases/${theirs.id}`, { visibility: 'public' });
    expect(byAdmin.json<DatabaseInfo>()).toMatchObject({ canEdit: true, visibility: 'public' });
    expect((await req(owner, 'POST', '/api/databases', { name: '' })).statusCode).toBe(400);
    expect((await req(null, 'POST', '/api/databases', { name: 'x' })).statusCode).toBe(401);
  });

  it('imports pasted PGN as a job: inserts, counts duplicates and skipped games by reason', async () => {
    const d = await createDb(owner, { name: 'Import target' });
    const res = await req(owner, 'POST', `/api/databases/${d.id}/import`, { pgn: MIXED_PGN });
    const { job } = res.json<ImportResponse>();
    expect(job).toMatchObject({ kind: 'pgnImport', lane: 'local', status: 'queued', userId: owner.userId, label: 'Import PGN into Import target' });
    const payload = JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [job.id])!);
    expect(payload).toMatchObject({ databaseId: d.id, originalName: null, file: expect.stringMatching(/^pgn-[0-9a-f-]+\.pgn$/) });
    const upload = join(t.config.uploadsDir, payload.file);
    expect(existsSync(upload)).toBe(true);
    // While queued, the database shows it.
    expect((await req(owner, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>().importJob?.id).toBe(job.id);

    const { ctx, updates } = makeJobContext(t, 'pgnImport', payload, { jobId: job.id });
    await runPgnImport(ctx);
    const last = updates[updates.length - 1]!;
    expect(last.counts).toEqual({
      imported: 2,
      duplicates: 1,
      skipped: 4,
      'skip:variant': 1,
      'skip:fromPosition': 1,
      'skip:noResult': 1,
      'skip:illegalMove': 1,
    });
    expect(last).toMatchObject({ done: 7, total: null });
    expect(last.message).toBe('2 imported, 1 duplicate, 4 skipped (1 variant, 1 from a set-up position, 1 unfinished, 1 illegal move)');
    expect(existsSync(upload)).toBe(false);
    expect(t.db.value('SELECT file FROM database_imports WHERE job_id = ?', [job.id])).toBeNull();

    t.db.run("UPDATE jobs SET status = 'done', progress_json = ? WHERE id = ?", [JSON.stringify(last), job.id]);
    const info = (await req(owner, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>();
    expect(info).toMatchObject({ gameCount: 2, importJob: null, lastImport: { id: job.id, status: 'done', progress: { counts: { imported: 2 } } } });

    // Importing the same text again only finds duplicates.
    const again = await importPgn(owner, d.id, MIXED_PGN);
    expect(again.last?.counts).toMatchObject({ imported: 0, duplicates: 3, skipped: 4 });
    expect((await req(owner, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>().gameCount).toBe(2);
    // Stored with origin pgn, the database id and a per-database duplicate key.
    const rows = t.db.all<{ origin: string; origin_id: string; white: string; time_class: string; event: string }>(
      'SELECT origin, origin_id, white, time_class, event FROM games WHERE database_id = ? ORDER BY id',
      [d.id],
    );
    expect(rows.map(r => [r.origin, r.white, r.time_class])).toEqual([
      ['pgn', 'Åsen, Åse', 'classical'],
      ['pgn', 'Berg, Bjørn', 'unknown'],
    ]);
    expect(rows.every(r => r.origin_id.startsWith(`${d.id}:`))).toBe(true);
  });

  it('accepts multipart .pgn uploads and rejects other files', async () => {
    const d = await createDb(owner, { name: 'Uploads' });
    const mp = multipart('club.pgn', MIXED_PGN);
    const res = await req(owner, 'POST', `/api/databases/${d.id}/import`, mp.payload, mp.headers);
    expect(res.statusCode, res.body).toBe(200);
    const { job } = res.json<ImportResponse>();
    expect(job.label).toBe('Import club.pgn into Uploads');
    const payload = JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [job.id])!);
    expect(payload.originalName).toBe('club.pgn');
    const { ctx, updates } = makeJobContext(t, 'pgnImport', payload);
    await runPgnImport(ctx);
    expect(updates.at(-1)?.counts?.imported).toBe(2);

    const exe = multipart('virus.exe', 'MZ...', 'application/x-msdownload');
    const bad = await req(owner, 'POST', `/api/databases/${d.id}/import`, exe.payload, exe.headers);
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error.code).toBe('unsupported_media_type');
    const empty = multipart('empty.pgn', '');
    expect((await req(owner, 'POST', `/api/databases/${d.id}/import`, empty.payload, empty.headers)).statusCode).toBe(400);
    const wrongField = multipart('a.pgn', RUY, 'application/x-chess-pgn', 'upload');
    expect((await req(owner, 'POST', `/api/databases/${d.id}/import`, wrongField.payload, wrongField.headers)).statusCode).toBe(400);
    expect((await req(owner, 'POST', `/api/databases/${d.id}/import`, { pgn: '' })).statusCode).toBe(400);
    // Only the import that ran left nothing behind; refused uploads were never written.
    expect(readdirSync(t.config.uploadsDir).filter(f => f.startsWith('pgn-'))).toEqual([]);
  });

  it('refuses uploads over the size limit', async () => {
    const big = Object.assign(Readable.from([Buffer.from('[Event "x"]\n')]), { truncated: true });
    await expect(saveUploadStream(t.config, big)).rejects.toMatchObject({ statusCode: 413, code: 'payload_too_large' });
    expect(readdirSync(t.config.uploadsDir).filter(f => f.startsWith('pgn-'))).toEqual([]);
  });

  it('reads Windows-1252 files and stops cleanly on an unreadable game', async () => {
    const d = await createDb(owner, { name: 'Legacy' });
    const latin = Buffer.from(pgnGame({ Event: 'Café blitz', White: 'Müller', Black: 'Nuñez', Result: '0-1', Date: '2001.01.01' }, RUY), 'latin1');
    const mp = multipart('legacy.pgn', latin);
    const { job } = (await req(owner, 'POST', `/api/databases/${d.id}/import`, mp.payload, mp.headers)).json<ImportResponse>();
    const payload = JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [job.id])!);
    await runPgnImport(makeJobContext(t, 'pgnImport', payload).ctx);
    expect(t.db.all('SELECT white, black, event FROM games WHERE database_id = ?', [d.id])).toEqual([
      { white: 'Müller', black: 'Nuñez', event: 'Café blitz' },
    ]);

    // A game beyond the parser's complexity budget ends the import with an error; earlier games stay.
    const hostile = `${pgnGame({ Event: 'ok', White: 'P', Black: 'Q', Result: '1-0', Date: '2020.01.01' }, RUY)}\n[Event "huge"]\n[White "P"]\n[Black "Q"]\n[Result "1-0"]\n\n1. e4 {${'x'.repeat(1_100_000)}} e5 1-0\n`;
    const r = await importPgn(owner, d.id, hostile);
    expect(r.error?.message).toMatch(/^Stopped after 1 games: the PGN could not be read further/);
    expect(r.last?.counts?.imported).toBe(1);
    expect(existsSync(join(t.config.uploadsDir, r.payload.file))).toBe(false);
    const info = (await req(owner, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>();
    expect(info.gameCount).toBe(2);
    expect(info.importJob).toMatchObject({ id: r.job.id, status: 'error' });
  });

  it('skips the import when the database is gone and sweeps stale uploads', async () => {
    const d = await createDb(owner, { name: 'Doomed' });
    const { job } = (await req(owner, 'POST', `/api/databases/${d.id}/import`, { pgn: RUY })).json<ImportResponse>();
    const payload = JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [job.id])!);
    expect(existsSync(join(t.config.uploadsDir, payload.file))).toBe(true);
    expect((await req(owner, 'DELETE', `/api/databases/${d.id}`)).statusCode).toBe(200);
    // Deleting the database removed its pending upload; the job then has nothing to do.
    expect(existsSync(join(t.config.uploadsDir, payload.file))).toBe(false);
    const { ctx, updates } = makeJobContext(t, 'pgnImport', payload);
    await runPgnImport(ctx);
    expect(updates.at(-1)?.message).toMatch(/deleted/);

    mkdirSync(t.config.uploadsDir, { recursive: true });
    const stale = join(t.config.uploadsDir, 'pgn-00000000-0000-4000-8000-000000000000.pgn');
    const fresh = join(t.config.uploadsDir, 'pgn-00000000-0000-4000-8000-000000000001.pgn');
    const foreign = join(t.config.uploadsDir, 'keep-me.txt');
    for (const f of [stale, fresh, foreign]) writeFileSync(f, 'x');
    const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    utimesSync(stale, old, old);
    utimesSync(foreign, old, old);
    expect(await sweepUploads(t.db, t.config)).toBe(1);
    expect([existsSync(stale), existsSync(fresh), existsSync(foreign)]).toEqual([false, true, true]);
  });

  it('lists games with paging and search, exports PGN that re-imports, deletes single games', async () => {
    const d = await createDb(owner, { name: 'Browse', visibility: 'public' });
    const games = Array.from({ length: 7 }, (_, i) =>
      pgnGame(
        { Event: i % 2 ? 'Spring Open' : 'Autumn Cup', Date: `2023.0${i + 1}.15`, White: `Player ${i}`, Black: 'Rival, Rita', Result: '1-0', WhiteElo: '1900' },
        RUY,
      ),
    ).join('\n');
    await importPgn(owner, d.id, games);
    const page1 = (await req(other, 'GET', `/api/databases/${d.id}/games?pageSize=3`)).json<DbGamesPage>();
    expect(page1).toMatchObject({ total: 7, page: 1, pageSize: 3 });
    expect(page1.games.map(g => g.white.name)).toEqual(['Player 6', 'Player 5', 'Player 4']);
    expect(page1.games[0]).toMatchObject({ origin: 'pgn', black: { name: 'Rival, Rita', rating: null, title: null }, white: { rating: 1900 }, result: '1-0', plies: 10 });
    const page3 = (await req(other, 'GET', `/api/databases/${d.id}/games?pageSize=3&page=3`)).json<DbGamesPage>();
    expect(page3.games.map(g => g.white.name)).toEqual(['Player 0']);
    expect((await req(other, 'GET', `/api/databases/${d.id}/games?q=spring`)).json<DbGamesPage>().total).toBe(3);
    expect((await req(other, 'GET', `/api/databases/${d.id}/games?q=RITA`)).json<DbGamesPage>().total).toBe(7);
    expect((await req(other, 'GET', `/api/databases/${d.id}/games?q=player%203`)).json<DbGamesPage>().total).toBe(1);
    expect((await req(other, 'GET', `/api/databases/${d.id}/games?q=100%25`)).json<DbGamesPage>().total).toBe(0);
    expect((await req(other, 'GET', `/api/databases/${d.id}/games?pageSize=500`)).statusCode).toBe(400);

    const exp = await req(other, 'GET', `/api/databases/${d.id}/export.pgn`);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toBe('application/x-chess-pgn; charset=utf-8');
    expect(exp.headers['content-disposition']).toBe('attachment; filename="browse.pgn"');
    expect(exp.body).toContain('[Event "Autumn Cup"]\n[Site "?"]\n[Date "2023.01.15"]\n[Round "?"]\n[White "Player 0"]\n[Black "Rival, Rita"]\n[Result "1-0"]');
    expect(exp.body).toContain('\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0\n');
    const copy = await createDb(owner, { name: 'Copy' });
    const re = await importPgn(owner, copy.id, exp.body);
    expect(re.last?.counts).toMatchObject({ imported: 7, duplicates: 0, skipped: 0 });

    const victim = page1.games[0]!.id;
    expect((await req(other, 'DELETE', `/api/databases/${d.id}/games/${victim}`)).statusCode).toBe(403);
    expect((await req(owner, 'DELETE', `/api/databases/${copy.id}/games/${victim}`)).statusCode).toBe(404);
    const del = await req(owner, 'DELETE', `/api/databases/${d.id}/games/${victim}`);
    expect(del.json()).toEqual({ ok: true });
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id = ?', [victim])).toBe(0);
    expect((await req(owner, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>().gameCount).toBe(6);
    expect((await req(owner, 'GET', `/api/databases/${d.id}/games`)).json<DbGamesPage>().total).toBe(6);
  });

  it('feeds pgn sources of profiles and removes them with the database', async () => {
    const d = await createDb(owner, { name: 'Club', visibility: 'public' });
    await importPgn(owner, d.id, MIXED_PGN);
    const create = await req(other, 'POST', '/api/profiles', {
      displayName: 'Åse',
      visibility: 'public',
      sources: [{ kind: 'pgn', key: 'Åsen, Åse', databaseId: d.id }],
    });
    expect(create.statusCode, create.body).toBe(200);
    const h = create.json<ProfileHeader>();
    expect(h.sources[0]).toMatchObject({ kind: 'pgn', key: `${d.id}:åsen, åse`, displayName: 'Åsen, Åse', url: null, databaseId: d.id, gameCount: 2 });
    expect(h.sources[0]!.sync.state).toBe('idle');
    expect(h.totals).toEqual({ w: 1, d: 1, l: 0, games: 2 });

    // New games of that player are picked up by the next import.
    await importPgn(owner, d.id, pgnGame({ Event: 'Later', Date: '2025.01.01', White: 'Zed', Black: 'Åsen, Åse', Result: '0-1' }, RUY));
    expect((await req(other, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>().totals).toEqual({ w: 2, d: 1, l: 0, games: 3 });

    // Turning the database private hides its games from the other user's public profile.
    await req(owner, 'PATCH', `/api/databases/${d.id}`, { visibility: 'private' });
    const hidden = (await req(other, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>();
    expect(hidden.sources).toEqual([]);
    expect(hidden.totals.games).toBe(0);
    expect((await req(owner, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>().totals.games).toBe(3);

    const bad = await req(other, 'POST', '/api/profiles', { displayName: 'x', sources: [{ kind: 'pgn', key: 'Åsen, Åse', databaseId: d.id }] });
    expect(bad.statusCode).toBe(400);
    const noDb = await req(owner, 'POST', '/api/profiles', { displayName: 'x', sources: [{ kind: 'pgn', key: 'Åsen, Åse' }] });
    expect(noDb.statusCode).toBe(400);
    const unknownName = await req(owner, 'POST', '/api/profiles', { displayName: 'x', sources: [{ kind: 'pgn', key: 'Nobody', databaseId: d.id }] });
    expect(unknownName.statusCode).toBe(400);
    expect(unknownName.json().error.message).toMatch(/No games of "Nobody"/);

    expect((await req(owner, 'DELETE', `/api/databases/${d.id}`)).statusCode).toBe(200);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE database_id = ?', [d.id])).toBe(0);
    expect(t.db.value("SELECT COUNT(*) FROM sources WHERE kind = 'pgn' AND database_id = ?", [d.id])).toBe(0);
    expect((await req(other, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>().sources).toEqual([]);
    expect((await req(owner, 'GET', `/api/databases/${d.id}`)).statusCode).toBe(404);
  });

  it('lets anyone read reference databases but only admins change them', async () => {
    const ref = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Broadcasts', 'reference', 'public', 0)").lastInsertRowid;
    const info = (await req(other, 'GET', `/api/databases/${ref}`)).json<DatabaseInfo>();
    expect(info).toMatchObject({ kind: 'reference', canEdit: false, owner: null });
    // Listed after the user databases (contract: mine, others' public ones, then reference ones).
    const listed = (await req(other, 'GET', '/api/databases')).json<DatabasesResponse>().databases;
    expect(listed.find(d => d.id === ref)).toMatchObject({ kind: 'reference', canEdit: false, builtin: false });
    expect(listed.findIndex(d => d.kind === 'reference')).toBe(listed.length - 1);
    // A private reference database is admins-only: not listed, not readable, its players not addable.
    t.db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [ref]);
    try {
      expect((await req(other, 'GET', '/api/databases')).json<DatabasesResponse>().databases.some(d => d.id === ref)).toBe(false);
      expect((await req(admin, 'GET', '/api/databases')).json<DatabasesResponse>().databases.some(d => d.id === ref)).toBe(true);
      for (const url of [`/api/databases/${ref}`, `/api/databases/${ref}/games`, `/api/databases/${ref}/export.pgn`]) {
        expect((await req(other, 'GET', url)).statusCode, url).toBe(404);
        expect((await req(admin, 'GET', url)).statusCode, url).toBe(200);
      }
    } finally {
      t.db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [ref]);
    }
    expect((await req(other, 'PATCH', `/api/databases/${ref}`, { name: 'x' })).statusCode).toBe(403);
    const imp = await req(admin, 'POST', `/api/databases/${ref}/import`, { pgn: RUY });
    expect(imp.statusCode).toBe(400);
    expect((await req(admin, 'PATCH', `/api/databases/${ref}`, { licence: 'CC BY-SA 4.0' })).json<DatabaseInfo>().licence).toBe('CC BY-SA 4.0');
  });

  it('takes a reference database an admin makes private out of FIDE players, and puts it back', async () => {
    const ref = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Licensed', 'reference', 'public', 0)").lastInsertRowid;
    const fide = createSource(t.db, { kind: 'fide', key: '24680' });
    insertGame(t.db, testGame({ origin: 'reference', originId: `${ref}:f1`, databaseId: ref, white: { name: 'Fide, Player', fideId: '24680' } }));
    const linked = () => t.db.value<number>('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide]);
    expect(linked()).toBe(1);
    expect((await req(admin, 'PATCH', `/api/databases/${ref}`, { visibility: 'private' })).statusCode).toBe(200);
    expect(linked()).toBe(0);
    expect((await req(admin, 'PATCH', `/api/databases/${ref}`, { visibility: 'public' })).statusCode).toBe(200);
    expect(linked()).toBe(1);
  });

  it('refuses every route on a private database to others and anonymous visitors', async () => {
    const d = await createDb(owner, { name: 'Private stash' });
    await importPgn(owner, d.id, MIXED_PGN);
    const gameId = t.db.value<number>('SELECT id FROM games WHERE database_id = ? LIMIT 1', [d.id])!;
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      for (const s of [other, null]) {
        for (const [method, url, body] of [
          ['GET', `/api/databases/${d.id}`, undefined],
          ['GET', `/api/databases/${d.id}/games`, undefined],
          ['GET', `/api/databases/${d.id}/export.pgn`, undefined],
          ['PATCH', `/api/databases/${d.id}`, { name: 'x' }],
          ['DELETE', `/api/databases/${d.id}`, undefined],
          ['POST', `/api/databases/${d.id}/import`, { pgn: RUY }],
          ['DELETE', `/api/databases/${d.id}/games/${gameId}`, undefined],
        ] as const) {
          const res = await req(s, method, url, body);
          expect(res.statusCode, `${s ? 'other' : 'anonymous'} ${method} ${url}`).toBe(s === null ? 401 : 404);
        }
      }
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
    expect((await req(admin, 'GET', `/api/databases/${d.id}/export.pgn`)).statusCode).toBe(200);
    expect((await req(owner, 'GET', '/api/databases/999999')).statusCode).toBe(404);
    expect((await req(owner, 'GET', '/api/databases/abc')).statusCode).toBe(400);
  });

  it('shows import jobs (uploader, file name) to editors only', async () => {
    clientIp = '10.0.0.1';
    const d = await createDb(owner, { name: 'Public with imports', visibility: 'public' });
    await importPgn(owner, d.id, MIXED_PGN);
    const mp = multipart('my-secret-prep.pgn', RUY);
    expect((await req(owner, 'POST', `/api/databases/${d.id}/import`, mp.payload, mp.headers)).statusCode).toBe(200);
    const mine = (await req(owner, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>();
    expect(mine.importJob?.label).toBe('Import my-secret-prep.pgn into Public with imports');
    expect(mine.lastImport?.status).toBe('done');
    const theirs = (await req(other, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>();
    expect(theirs).toMatchObject({ canEdit: false, importJob: null, lastImport: null, gameCount: 2 });
    const listed = (await req(other, 'GET', '/api/databases')).json<DatabasesResponse>().databases.find(x => x.id === d.id)!;
    expect([listed.importJob, listed.lastImport]).toEqual([null, null]);
    expect((await req(admin, 'GET', `/api/databases/${d.id}`)).json<DatabaseInfo>().importJob?.label).toMatch(/my-secret-prep/);
  });

  it('limits pasted PGN, pending imports per user and exports per user', async () => {
    clientIp = '10.0.0.2';
    const d = await createDb(other, { name: 'Limits' });
    // Pasted text: 5 MB at most (413 before or after JSON parsing); files go through the upload.
    const tooBig = 'x'.repeat(MAX_PASTE_BYTES + 1);
    const pasted = await req(other, 'POST', `/api/databases/${d.id}/import`, { pgn: tooBig });
    expect(pasted.statusCode).toBe(413);
    expect(pasted.json().error.code).toBe('payload_too_large');
    const huge = await req(other, 'POST', `/api/databases/${d.id}/import`, { pgn: 'x'.repeat(8 * 1024 * 1024) });
    expect(huge.statusCode).toBe(413);

    // Three imports may wait at a time; the fourth is refused before anything is written.
    for (let i = 0; i < MAX_PENDING_IMPORTS; i++) expect((await req(other, 'POST', `/api/databases/${d.id}/import`, { pgn: RUY })).statusCode).toBe(200);
    const files = readdirSync(t.config.uploadsDir).length;
    const fourth = await req(other, 'POST', `/api/databases/${d.id}/import`, { pgn: RUY });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error).toMatchObject({ code: 'rate_limited', details: { pending: 3, max: 3 } });
    const mp = multipart('more.pgn', RUY);
    expect((await req(other, 'POST', `/api/databases/${d.id}/import`, mp.payload, mp.headers)).statusCode).toBe(429);
    expect(readdirSync(t.config.uploadsDir).length).toBe(files);
    // Other users are not affected; finishing one frees a slot.
    expect((await req(owner, 'POST', `/api/databases/${(await createDb(owner, { name: 'Free' })).id}/import`, { pgn: RUY })).statusCode).toBe(200);
    t.db.run("UPDATE jobs SET status = 'done' WHERE id = (SELECT MIN(id) FROM jobs WHERE kind = 'pgnImport' AND user_id = ? AND status = 'queued')", [other.userId]);
    expect((await req(other, 'POST', `/api/databases/${d.id}/import`, { pgn: RUY })).statusCode).toBe(200);

    // Exports: 10 per minute per user.
    let status = 0;
    for (let i = 0; i < 11 && status !== 429; i++) status = (await req(other, 'GET', `/api/databases/${d.id}/export.pgn`)).statusCode;
    expect(status).toBe(429);
    expect((await req(owner, 'GET', `/api/databases/${d.id}/export.pgn`)).statusCode).toBe(404);
  });

  it("stops imports at the owner's game allowance (admins have none)", async () => {
    clientIp = '10.0.0.3';
    const capped = createUserSession(t.db, { username: 'capped' });
    const d = await createDb(capped, { name: 'Nearly full' });
    // Pretend the user's other databases already hold all but 3 of the allowed games.
    const filler = await createDb(capped, { name: 'Filler' });
    t.db.run('UPDATE databases SET game_count = ? WHERE id = ?', [MAX_GAMES_PER_USER - 3, filler.id]);
    const many = Array.from({ length: 250 }, (_, i) =>
      pgnGame({ Event: 'Bulk', Date: '2024.01.01', White: `W${i}`, Black: `B${i}`, Result: '1-0' }, RUY),
    ).join('\n');
    const r = await importPgn(capped, d.id, many);
    expect(r.error).toBeNull();
    expect(r.last?.message).toMatch(/^Stopped after \d+ games: the owner's databases hold the most games allowed/);
    // The allowance is checked per batch of 100 games.
    expect(r.last?.counts?.imported).toBe(100);
    const refused = await req(capped, 'POST', `/api/databases/${d.id}/import`, { pgn: RUY });
    expect(refused.statusCode).toBe(403);
    // Admins' own databases have no allowance.
    const adminDb = await createDb(admin, { name: 'Admin bulk' });
    t.db.run('UPDATE databases SET game_count = ? WHERE id = ?', [MAX_GAMES_PER_USER + 5, adminDb.id]);
    const one = pgnGame({ Event: 'Admin', Date: '2024.01.01', White: 'X', Black: 'Y', Result: '1-0' }, RUY);
    expect((await importPgn(admin, adminDb.id, one)).last?.counts?.imported).toBe(1);
  });

  it('summarises counters for the UI', () => {
    expect(importSummary({ imported: 1, duplicates: 0, skipped: 0 })).toBe('1 imported, 0 duplicates, 0 skipped');
  });
});
