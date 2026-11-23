import type { FileSearchResponse, FilesResponse, FoldersResponse, StudioFile } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexPgnPositions, MAX_FILE_BYTES_PER_USER, MAX_INDEXED_POSITIONS_PER_USER } from '../src/files/index.ts';
import { createUserSession, makeTestApp, mutationHeaders, type TestApp } from './helpers.ts';
import { STUDY_PGN } from './fixtures/profiles/pgn.ts';

type Session = { userId: number; cookie: string };

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const RUY_AFTER_BB5 = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const QGD = 'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2';

describe('files API', () => {
  let t: TestApp;
  let me: Session;
  let other: Session;

  const req = (s: Session | null, method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(method === 'GET' ? {} : mutationHeaders), ...(s ? { cookie: s.cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const create = async (s: Session, body: Record<string, unknown>): Promise<StudioFile> => {
    const res = await req(s, 'POST', '/api/files', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<StudioFile>();
  };
  const search = async (s: Session, fen: string) => {
    const res = await req(s, 'GET', `/api/files/search?fen=${encodeURIComponent(fen)}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FileSearchResponse>();
  };

  beforeAll(async () => {
    t = await makeTestApp();
    me = createUserSession(t.db, { username: 'me' });
    other = createUserSession(t.db, { username: 'other' });
  });
  afterAll(async () => t.close());

  it('needs a session for every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/files'],
      ['POST', '/api/files'],
      ['GET', '/api/files/1'],
      ['PUT', '/api/files/1'],
      ['DELETE', '/api/files/1'],
      ['POST', '/api/files/1/restore'],
      ['GET', `/api/files/search?fen=${encodeURIComponent(START)}`],
      ['GET', '/api/folders'],
    ] as const) {
      expect((await req(null, method, url, method === 'GET' ? undefined : {})).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates studies and repertoires in normalised folders', async () => {
    const study = await create(me, { folder: ' Openings / White ', name: 'Ruy Lopez', kind: 'study', color: 'white', pgn: STUDY_PGN });
    expect(study).toMatchObject({ folder: 'Openings/White', name: 'Ruy Lopez', kind: 'study', color: null, deletedAt: null, pgn: STUDY_PGN });
    expect(study.createdAt).toBe(study.updatedAt);
    const rep = await create(me, { folder: '', name: 'Black repertoire', kind: 'repertoire', color: 'black', pgn: '' });
    expect(rep).toMatchObject({ folder: '', kind: 'repertoire', color: 'black', pgn: '' });
    for (const bad of [
      { folder: 'a/../b', name: 'x', kind: 'study', pgn: '' },
      { folder: 'a', name: 'x/y', kind: 'study', pgn: '' },
      { folder: 'a', name: '   ', kind: 'study', pgn: '' },
      { folder: 'a', name: 'x', kind: 'game', pgn: '' },
      { folder: '1/2/3/4/5/6/7/8/9', name: 'x', kind: 'study', pgn: '' },
      { folder: 'a', name: 'x', kind: 'study' },
    ]) {
      const res = await req(me, 'POST', '/api/files', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
  });

  it('lists files and folders of the owner only', async () => {
    await create(me, { folder: 'Openings/Black/Sicilian', name: 'Najdorf', kind: 'repertoire', color: 'black', pgn: '1. e4 c5 *' });
    await create(other, { folder: 'Secret', name: 'Hidden', kind: 'study', pgn: '1. d4 *' });
    const all = (await req(me, 'GET', '/api/files')).json<FilesResponse>().files;
    expect(all.map(f => `${f.folder}|${f.name}`)).toEqual(['|Black repertoire', 'Openings/Black/Sicilian|Najdorf', 'Openings/White|Ruy Lopez']);
    expect(all[0]).not.toHaveProperty('pgn');
    expect((await req(me, 'GET', '/api/files?folder=')).json<FilesResponse>().files.map(f => f.name)).toEqual(['Black repertoire']);
    expect((await req(me, 'GET', '/api/files?folder=Openings/White/')).json<FilesResponse>().files.map(f => f.name)).toEqual(['Ruy Lopez']);
    expect((await req(me, 'GET', '/api/files?folder=Openings')).json<FilesResponse>().files).toEqual([]);
    const folders = (await req(me, 'GET', '/api/folders')).json<FoldersResponse>();
    expect(folders).toEqual({
      folders: [
        { path: '', fileCount: 1 },
        { path: 'Openings', fileCount: 0 },
        { path: 'Openings/Black', fileCount: 0 },
        { path: 'Openings/Black/Sicilian', fileCount: 1 },
        { path: 'Openings/White', fileCount: 1 },
      ],
      trashCount: 0,
    });
    const theirs = (await req(other, 'GET', '/api/files')).json<FilesResponse>().files;
    expect(theirs.map(f => f.name)).toEqual(['Hidden']);
    expect((await req(other, 'GET', `/api/files/${all[1]!.id}`)).statusCode).toBe(404);
    expect((await req(other, 'PUT', `/api/files/${all[1]!.id}`, { name: 'Mine' })).statusCode).toBe(404);
    expect((await req(other, 'DELETE', `/api/files/${all[1]!.id}`)).statusCode).toBe(404);
    expect((await req(other, 'POST', `/api/files/${all[1]!.id}/restore`)).statusCode).toBe(404);
  });

  it('updates files, detects concurrent saves and keeps the bin read-only', async () => {
    const f = await create(me, { folder: 'Drafts', name: 'Draft', kind: 'repertoire', color: 'white', pgn: '1. e4 *' });
    const moved = await req(me, 'PUT', `/api/files/${f.id}`, { folder: 'Final', name: 'Final', baseUpdatedAt: f.updatedAt });
    expect(moved.statusCode, moved.body).toBe(200);
    const m = moved.json<StudioFile>();
    expect(m).toMatchObject({ folder: 'Final', name: 'Final', kind: 'repertoire', color: 'white', pgn: '1. e4 *' });
    expect(m.updatedAt).toBeGreaterThan(f.updatedAt);
    const stale = await req(me, 'PUT', `/api/files/${f.id}`, { pgn: '1. d4 *', baseUpdatedAt: f.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'conflict', details: { updatedAt: m.updatedAt } });
    const asStudy = (await req(me, 'PUT', `/api/files/${f.id}`, { kind: 'study', baseUpdatedAt: m.updatedAt })).json<StudioFile>();
    expect(asStudy).toMatchObject({ kind: 'study', color: null });
    expect((await req(me, 'PUT', `/api/files/${f.id}`, { name: '' })).statusCode).toBe(400);
    expect((await req(me, 'PUT', '/api/files/999999', { name: 'x' })).statusCode).toBe(404);

    expect((await req(me, 'DELETE', `/api/files/${f.id}`)).json()).toEqual({ ok: true });
    const inBin = (await req(me, 'GET', `/api/files/${f.id}`)).json<StudioFile>();
    expect(inBin.deletedAt).toBeGreaterThan(0);
    expect((await req(me, 'PUT', `/api/files/${f.id}`, { name: 'x' })).statusCode).toBe(409);
    expect((await req(me, 'GET', '/api/files?trash=1')).json<FilesResponse>().files.map(x => x.id)).toEqual([f.id]);
    expect((await req(me, 'GET', '/api/files')).json<FilesResponse>().files.some(x => x.id === f.id)).toBe(false);
    expect((await req(me, 'GET', '/api/folders')).json<FoldersResponse>().trashCount).toBe(1);

    const restored = await req(me, 'POST', `/api/files/${f.id}/restore`);
    expect(restored.json<StudioFile>()).toMatchObject({ id: f.id, deletedAt: null, folder: 'Final' });
    expect((await req(me, 'POST', `/api/files/${f.id}/restore`)).statusCode).toBe(200);

    await req(me, 'DELETE', `/api/files/${f.id}`);
    expect((await req(me, 'DELETE', `/api/files/${f.id}`)).statusCode).toBe(200);
    expect((await req(me, 'GET', `/api/files/${f.id}`)).statusCode).toBe(404);
    expect((await req(me, 'DELETE', `/api/files/${f.id}`)).statusCode).toBe(404);
    expect((await req(me, 'GET', '/api/folders')).json<FoldersResponse>().trashCount).toBe(0);
  });

  it('finds files reaching a position in main lines and variations', async () => {
    const study = (await req(me, 'GET', '/api/files')).json<FilesResponse>().files.find(f => f.name === 'Ruy Lopez')!;
    const najdorf = (await req(me, 'GET', '/api/files')).json<FilesResponse>().files.find(f => f.name === 'Najdorf')!;

    const e4 = await search(me, AFTER_E4);
    expect(e4.fen).toBe(AFTER_E4);
    const studyHit = e4.hits.find(h => h.file.id === study.id)!;
    expect(studyHit.matches).toEqual([
      { gameIndex: 0, ply: 1, nextSan: 'c5' },
      { gameIndex: 0, ply: 1, nextSan: 'e5' },
    ]);
    expect(e4.hits.find(h => h.file.id === najdorf.id)!.matches).toEqual([{ gameIndex: 0, ply: 1, nextSan: 'c5' }]);

    // Only in a variation; move counters in the FEN don't matter.
    const ruy = await search(me, RUY_AFTER_BB5.replace(/ 3 3$/, ' 0 40'));
    expect(ruy.hits.map(h => [h.file.name, h.matches])).toEqual([['Ruy Lopez', [{ gameIndex: 0, ply: 5, nextSan: 'a6' }]]]);
    // Second game of the file; and an end of line (no next move).
    expect((await search(me, QGD)).hits.map(h => h.matches)).toEqual([[{ gameIndex: 1, ply: 3, nextSan: null }]]);
    // Other users' files never match.
    expect((await search(other, AFTER_E4)).hits).toEqual([]);
    expect((await search(other, 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1')).hits.map(h => h.file.name)).toEqual(['Hidden']);

    // Saving new PGN drops the cached index; the next search sees the new content.
    expect(t.db.value('SELECT COUNT(*) FROM file_index WHERE file_id = ?', [study.id])).toBe(1);
    await req(me, 'PUT', `/api/files/${study.id}`, { pgn: '1. d4 d5 2. c4 *' });
    expect(t.db.value('SELECT COUNT(*) FROM file_index WHERE file_id = ?', [study.id])).toBe(0);
    expect((await search(me, RUY_AFTER_BB5)).hits).toEqual([]);
    expect((await search(me, QGD)).hits.map(h => h.file.name)).toEqual(['Ruy Lopez']);
    // Files in the bin are not searched.
    await req(me, 'DELETE', `/api/files/${study.id}`);
    expect((await search(me, QGD)).hits).toEqual([]);
    await req(me, 'POST', `/api/files/${study.id}/restore`);
    expect((await search(me, QGD)).hits.map(h => h.file.name)).toEqual(['Ruy Lopez']);
  });

  it('validates the FEN', async () => {
    expect((await req(me, 'GET', '/api/files/search?fen=not-a-fen')).statusCode).toBe(400);
    expect((await req(me, 'GET', '/api/files/search')).statusCode).toBe(400);
    const twoKings = 'kk6/8/8/8/8/8/8/K7 w - - 0 1';
    expect((await req(me, 'GET', `/api/files/search?fen=${encodeURIComponent(twoKings)}`)).statusCode).toBe(400);
  });

  it('indexes set-up positions with lila plies and skips other variants', async () => {
    const pgn = `[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 30"]\n\n30... Kd7 31. e4 *\n\n[Variant "Atomic"]\n\n1. e4 *\n\n1. e4 e5 2. Ke3 Nf6 *`;
    const r = await indexPgnPositions(pgn);
    expect(r.games).toBe(3);
    expect(r.error).toBeNull();
    expect(r.positions.filter(p => p.gameIndex === 0).map(p => [p.ply, p.nextSan])).toEqual([
      [59, 'Kd7'],
      [60, 'e4'],
      [61, null],
    ]);
    expect(r.positions.some(p => p.gameIndex === 1)).toBe(false);
    // An illegal move ends that line.
    expect(r.positions.filter(p => p.gameIndex === 2).map(p => [p.ply, p.nextSan])).toEqual([
      [0, 'e4'],
      [1, 'e5'],
      [2, null],
    ]);
    expect(await indexPgnPositions('1. e4 e5 2. Nf3 *', 2)).toMatchObject({ truncated: true, positions: [{ ply: 0 }, { ply: 1 }] });
    expect(await indexPgnPositions('')).toEqual({ positions: [], games: 0, truncated: false, error: null });
  });

  it('indexes large files in steps, keeping the event loop responsive', async () => {
    // ~2 MB of PGN: many games, so the parser streams over many chunks.
    const games = Array.from({ length: 8000 }, (_, i) => `[Event "G${i}"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *`).join('\n\n');
    let ticks = 0;
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 1);
    try {
      const r = await indexPgnPositions(games);
      expect(r).toMatchObject({ games: 8000, truncated: false, error: null });
      expect(r.positions.filter(p => p.gameIndex === 7999)).toHaveLength(15);
    } finally {
      clearInterval(timer);
    }
    // Timers ran while it worked: no single step held the loop for long.
    expect(ticks).toBeGreaterThan(5);
    expect(maxGap).toBeLessThan(250);
  });

  it('caps the indexed positions per user', async () => {
    const cap = await makeTestApp();
    try {
      const u = createUserSession(cap.db, { username: 'cap' });
      const filler = cap.db.run("INSERT INTO files (owner_user_id, name, kind, pgn, created_at, updated_at) VALUES (?, 'filler', 'study', '*', 0, 0)", [
        u.userId,
      ]).lastInsertRowid;
      cap.db.run('INSERT INTO file_index (file_id, indexed_at, games, positions) VALUES (?, 0, 1, ?)', [filler, MAX_INDEXED_POSITIONS_PER_USER - 3]);
      const created = await cap.app.inject({
        method: 'POST',
        url: '/api/files',
        headers: { ...mutationHeaders, cookie: u.cookie },
        payload: { folder: '', name: 'late', kind: 'study', pgn: '1. e4 e5 2. Nf3 Nc6 *' },
      });
      const id = created.json<StudioFile>().id;
      const res = await cap.app.inject({ url: `/api/files/search?fen=${encodeURIComponent(AFTER_E4)}`, headers: { cookie: u.cookie } });
      expect(res.json<FileSearchResponse>().hits.map(h => h.file.id)).toEqual([id]);
      expect(cap.db.get('SELECT positions, error FROM file_index WHERE file_id = ?', [id])).toEqual({
        positions: 3,
        error: expect.stringMatching(/position index is full/),
      });
    } finally {
      await cap.close();
    }
  });

  it('enforces the storage quota per user, counting the bin', async () => {
    const quota = await makeTestApp();
    try {
      const u = createUserSession(quota.db, { username: 'q' });
      const call = (method: string, url: string, payload?: unknown) =>
        quota.app.inject({ method: method as 'GET', url, headers: { ...(method === 'GET' ? {} : mutationHeaders), cookie: u.cookie }, ...(payload ? { payload: payload as object } : {}) });
      // Pretend the user already stores all but 10 bytes.
      quota.db.run("INSERT INTO files (owner_user_id, name, kind, pgn, pgn_bytes, created_at, updated_at) VALUES (?, 'big', 'study', '', ?, 0, 0)", [
        u.userId,
        MAX_FILE_BYTES_PER_USER - 10,
      ]);
      const ok = await call('POST', '/api/files', { folder: '', name: 'small', kind: 'study', pgn: '1. e4 *' });
      expect(ok.statusCode, ok.body).toBe(200);
      const small = ok.json<StudioFile>();
      const over = await call('POST', '/api/files', { folder: '', name: 'more', kind: 'study', pgn: '1. d4 d5 *' });
      expect(over.statusCode).toBe(403);
      expect(over.json().error).toMatchObject({ code: 'forbidden', details: { maxBytes: MAX_FILE_BYTES_PER_USER } });
      // Growing a file counts the difference; shrinking or renaming always works (multi-byte text counts in bytes).
      expect((await call('PUT', `/api/files/${small.id}`, { pgn: '1. e4 {ÅÅ} *' })).statusCode).toBe(403);
      expect((await call('PUT', `/api/files/${small.id}`, { pgn: '1. e4 e5 *' })).statusCode).toBe(200);
      expect((await call('PUT', `/api/files/${small.id}`, { name: 'renamed' })).statusCode).toBe(200);
      expect(quota.db.value('SELECT pgn_bytes FROM files WHERE id = ?', [small.id])).toBe(Buffer.byteLength('1. e4 e5 *'));
      // The bin counts until it is emptied.
      const bigId = quota.db.value<number>("SELECT id FROM files WHERE name = 'big'")!;
      await call('DELETE', `/api/files/${bigId}`);
      expect((await call('POST', '/api/files', { folder: '', name: 'more', kind: 'study', pgn: '1. d4 d5 *' })).statusCode).toBe(403);
      await call('DELETE', `/api/files/${bigId}`);
      expect((await call('POST', '/api/files', { folder: '', name: 'more', kind: 'study', pgn: '1. d4 d5 *' })).statusCode).toBe(200);
    } finally {
      await quota.close();
    }
  });

  it('throttles saves and searches per user', async () => {
    const th = await makeTestApp();
    try {
      const a = createUserSession(th.db, { username: 'a' });
      const b = createUserSession(th.db, { username: 'b' });
      const get = (s: Session, url: string) => th.app.inject({ url, headers: { cookie: s.cookie } });
      const url = `/api/files/search?fen=${encodeURIComponent(START)}`;
      let status = 0;
      for (let i = 0; i < 31 && status !== 429; i++) status = (await get(a, url)).statusCode;
      expect(status).toBe(429);
      // Per user, not per IP: b (same address) is not affected.
      expect((await get(b, url)).statusCode).toBe(200);
      let save = 0;
      for (let i = 0; i < 121 && save !== 429; i++) {
        save = (
          await th.app.inject({
            method: 'POST',
            url: '/api/files',
            headers: { ...mutationHeaders, cookie: a.cookie },
            payload: { folder: '', name: `f${i}`, kind: 'study', pgn: '*' },
          })
        ).statusCode;
      }
      expect(save).toBe(429);
    } finally {
      await th.close();
    }
  });

  it('keeps the index consistent with concurrent searches, saves and the bin', async () => {
    const f = await create(me, { folder: 'Race', name: 'Racer', kind: 'study', pgn: '1. e4 e5 2. Nf3 *' });
    // Two searches at once build the index once.
    const [x, y] = await Promise.all([search(me, AFTER_E4), search(me, AFTER_E4)]);
    expect(x.hits.find(h => h.file.id === f.id)).toBeTruthy();
    expect(y.hits.find(h => h.file.id === f.id)).toBeTruthy();
    expect(t.db.value('SELECT COUNT(*) FROM file_positions WHERE file_id = ?', [f.id])).toBe(4);
    expect(t.db.get('SELECT games, positions FROM file_index WHERE file_id = ?', [f.id])).toEqual({ games: 1, positions: 4 });

    // A save while an index is being built: the stale build gives up, the next search sees the new PGN.
    const big = Array.from({ length: 3000 }, () => '1. d4 d5 2. c4 e6 *').join('\n\n');
    const g = await create(me, { folder: 'Race', name: 'Big', kind: 'study', pgn: big });
    const pending = search(me, AFTER_E4);
    await new Promise(resolve => setImmediate(resolve));
    await req(me, 'PUT', `/api/files/${g.id}`, { pgn: '1. e4 c5 *' });
    await pending;
    const hits = (await search(me, AFTER_E4)).hits.map(h => h.file.id);
    expect(hits).toContain(g.id);
    expect(t.db.value('SELECT COUNT(*) FROM file_positions WHERE file_id = ?', [g.id])).toBe(3);

    // Binning drops the index; restoring rebuilds it on the next search.
    await req(me, 'DELETE', `/api/files/${g.id}`);
    expect(t.db.value('SELECT COUNT(*) FROM file_positions WHERE file_id = ?', [g.id])).toBe(0);
    await req(me, 'POST', `/api/files/${g.id}/restore`);
    expect((await search(me, AFTER_E4)).hits.map(h => h.file.id)).toContain(g.id);
  });
});
