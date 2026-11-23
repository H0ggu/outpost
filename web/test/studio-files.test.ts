/** My Files: the folder tree (src/studio/fileTree.ts) and the /api/files client (src/studio/filesApi.ts). */
import type { StudioFileMeta } from '@outpost/shared/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allFolderPaths, buildFolderTree, folderAncestors, normalizeFolder, uniqueFileName } from '../src/studio/fileTree.ts';
import { filesApi } from '../src/studio/filesApi.ts';

const file = (id: number, folder: string, name: string, deletedAt: number | null = null): StudioFileMeta => ({
  id,
  folder,
  name,
  kind: 'study',
  color: null,
  createdAt: 1,
  updatedAt: 2,
  deletedAt,
});

describe('folders', () => {
  it('normalises folder paths and rejects unsafe ones', () => {
    expect(normalizeFolder(' a / b//c/ ')).toBe('a/b/c');
    expect(normalizeFolder('')).toBe('');
    expect(normalizeFolder('a/../b')).toBeNull();
    expect(normalizeFolder('./a')).toBeNull();
    expect(normalizeFolder('a\\b')).toBeNull();
    expect(normalizeFolder('a\u0007')).toBeNull();
    expect(normalizeFolder('x'.repeat(201))).toBeNull();
    expect(folderAncestors('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(folderAncestors('')).toEqual([]);
  });

  it('builds a sorted tree from files, server folders and local folders', () => {
    const tree = buildFolderTree(
      [file(1, '', 'Zed'), file(2, 'Openings/White', 'e4'), file(3, 'Openings', 'misc'), file(4, '', 'alpha'), file(5, 'Gone', 'x', 9)],
      [{ path: 'Openings', fileCount: 1 }, { path: 'Openings/White', fileCount: 1 }],
      ['Empty', 'Openings/Black', '../bad'],
    );
    expect(tree.files.map(f => f.name)).toEqual(['alpha', 'Zed']);
    expect(tree.folders.map(f => f.name)).toEqual(['Empty', 'Openings']);
    const openings = tree.folders[1]!;
    expect(openings.total).toBe(2);
    expect(openings.folders.map(f => f.path)).toEqual(['Openings/Black', 'Openings/White']);
    expect(tree.total).toBe(4); // the deleted file is not counted
    expect(allFolderPaths(tree)).toEqual(['', 'Empty', 'Openings', 'Openings/Black', 'Openings/White']);
  });

  it('suggests a free file name in a folder', () => {
    const files = [file(1, 'a', 'Game'), file(2, 'a', 'game (2)'), file(3, 'b', 'Other'), file(4, 'a', 'Old', 5)];
    expect(uniqueFileName('Game', 'a', files)).toBe('Game (3)');
    expect(uniqueFileName('Game', 'b', files)).toBe('Game');
    expect(uniqueFileName('Old', 'a', files)).toBe('Old');
  });
});

describe('filesApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('uses the /api/files contract with the CSRF header on mutations', async () => {
    const f = stub({ files: [] });
    await filesApi.list();
    await filesApi.trash();
    await filesApi.folders();
    await filesApi.search('8/8/8/4k3/8/8/4K3/8 w - - 0 1');
    expect(f.mock.calls.map(c => c[0])).toEqual([
      '/api/files',
      '/api/files?trash=1',
      '/api/folders',
      '/api/files/search?fen=8%2F8%2F8%2F4k3%2F8%2F8%2F4K3%2F8+w+-+-+0+1',
    ]);
    await filesApi.create({ folder: '', name: 'n', kind: 'study', pgn: '*' });
    await filesApi.update(4, { pgn: '*', baseUpdatedAt: 7 });
    await filesApi.remove(4);
    await filesApi.restore(4);
    const calls = f.mock.calls.slice(4);
    expect(calls.map(c => [c[0], c[1]?.method])).toEqual([
      ['/api/files', 'POST'],
      ['/api/files/4', 'PUT'],
      ['/api/files/4', 'DELETE'],
      ['/api/files/4/restore', 'POST'],
    ]);
    for (const [, init] of calls) expect(new Headers(init?.headers).get('x-outpost')).toBe('1');
    expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({ pgn: '*', baseUpdatedAt: 7 });
  });

  it('surfaces conflicts as ApiError code "conflict"', async () => {
    stub({ error: { code: 'conflict', message: 'changed elsewhere' } }, 409);
    await expect(filesApi.update(1, { pgn: '*', baseUpdatedAt: 1 })).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});
