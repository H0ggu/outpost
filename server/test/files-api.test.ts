import type { FileSearchResponse, FilesResponse, FoldersResponse, StudioFile } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexPgnPositions } from '../src/files/index.ts';
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

  it('indexes set-up positions with lila plies and skips other variants', () => {
    const pgn = `[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 30"]\n\n30... Kd7 31. e4 *\n\n[Variant "Atomic"]\n\n1. e4 *\n\n1. e4 e5 2. Ke3 Nf6 *`;
    const r = indexPgnPositions(pgn);
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
    expect(indexPgnPositions('1. e4 e5 2. Nf3 *', 2)).toMatchObject({ truncated: true, positions: [{ ply: 0 }, { ply: 1 }] });
  });
});
