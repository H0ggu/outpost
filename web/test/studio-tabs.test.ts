/** Board tabs (src/studio/tabs.ts): order, activation, dirty tracking and sessionStorage persistence. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { StudioFileMeta } from '@outpost/shared/api';
import {
  applyFileMeta,
  isBlankBoard,
  isDirty,
  knownUpdatedAt,
  markSaved,
  MAX_KEPT_TAB_CHARS,
  newTabId,
  sameSource,
  TAB_STORAGE_PREFIX,
  TabList,
  TABS_STORAGE_KEY,
  tabPgn,
  type StudioTab,
  type TabSource,
} from '../src/studio/tabs.ts';

const G1 = '[Result "*"]\n\n1. e4 *\n';
const G2 = '[Result "*"]\n\n1. d4 *\n';

/** A Storage that records writes and can be made to fail like a full sessionStorage. */
function memoryStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  let full = false;
  const storage: Storage = {
    get length() {
      return data.size;
    },
    key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => {
      if (full) throw new DOMException('full', 'QuotaExceededError');
      writes.push(k);
      data.set(k, String(v));
    },
    removeItem: k => void data.delete(k),
    clear: () => data.clear(),
  };
  return { storage, writes, fill: () => (full = true) };
}

const tab = (over: Partial<StudioTab> = {}): StudioTab => ({
  id: newTabId(),
  title: 'Analysis',
  source: { kind: 'new' },
  games: [G1],
  baseline: [G1],
  current: 0,
  path: '',
  orientation: 'white',
  ...over,
});

describe('dirty tracking', () => {
  it('compares each game with its baseline, the shown one with the live export', () => {
    const t = tab({ games: [G1, G2], baseline: [G1, null] });
    expect(isDirty(t)).toBe(false);
    expect(isDirty(t, G2)).toBe(true); // live export of game 0 differs
    t.games[1] = G1; // never shown: no baseline yet
    expect(isDirty(t)).toBe(false);
    t.baseline[1] = G2;
    expect(isDirty(t)).toBe(true);
  });

  it('marks saved games, leaving never-shown ones unset', () => {
    const t = tab({ games: [G2, G1, G2], baseline: ['', null, null], current: 1 });
    markSaved(t);
    expect(t.baseline).toEqual([G2, G1, null]);
    expect(isDirty(t)).toBe(false);
    expect(tabPgn(t)).toBe(`${G2.trim()}\n\n${G1.trim()}\n\n${G2.trim()}\n`);
  });

  it('marks as saved what was sent, not what was played while the save was on its way', () => {
    const t = tab({ games: [G1], baseline: [G1] });
    const sent = [G2];
    t.games[0] = `${G2}1... e5`; // a move played during the PUT
    markSaved(t, sent);
    expect(t.baseline).toEqual([G2]);
    expect(isDirty(t)).toBe(true);
    // a game added during the save stays unsaved
    const u = tab({ games: [G1, G2], baseline: [G1, ''], current: 0 });
    markSaved(u, [G2]);
    expect(u.baseline).toEqual([G2, '']);
    expect(isDirty(u)).toBe(true);
  });

  it('knows when two tabs show the same game or file', () => {
    expect(sameSource({ kind: 'game', gameId: 1, url: null }, { kind: 'game', gameId: 1, url: 'x' })).toBe(true);
    expect(sameSource({ kind: 'game', gameId: 1, url: null }, { kind: 'game', gameId: 2, url: null })).toBe(false);
    const file = { kind: 'file', fileId: 3, name: 'a', folder: '', fileKind: 'study', color: null, updatedAt: 1, gameIndex: 0 } as const;
    expect(sameSource(file, { ...file, name: 'b', gameIndex: 2 })).toBe(true);
    expect(sameSource({ kind: 'new' }, { kind: 'new' })).toBe(false);
  });
});

describe('file metadata (rename, move)', () => {
  const fileSrc = (updatedAt: number, fileId = 3): TabSource => ({
    kind: 'file',
    fileId,
    name: 'Old',
    folder: 'a',
    fileKind: 'study',
    color: null,
    updatedAt,
    gameIndex: 0,
  });
  const meta = (updatedAt: number): StudioFileMeta => ({
    id: 3,
    folder: 'b',
    name: 'New',
    kind: 'study',
    color: null,
    createdAt: 1,
    updatedAt,
    deletedAt: null,
  });

  it('checks a rename against the newest version the page knows', () => {
    const tabs = [tab({ source: fileSrc(50) }), tab({ source: fileSrc(70) }), tab({ source: fileSrc(99, 4) })];
    expect(knownUpdatedAt(tabs, 3, 60)).toBe(70);
    expect(knownUpdatedAt(tabs, 3, 80)).toBe(80);
    expect(knownUpdatedAt([], 3, 60)).toBe(60);
  });

  it('moves a tab’s base forward only when the tab was on the version the rename was checked against', () => {
    const current = tab({ source: fileSrc(70) });
    const stale = tab({ source: fileSrc(50) }); // another device saved content after this tab loaded
    const other = tab({ source: fileSrc(70, 4), title: 'other' });
    const changed = applyFileMeta([current, stale, other], meta(90), 70);
    expect(changed).toEqual([current, stale]);
    expect(current.source).toMatchObject({ name: 'New', folder: 'b', updatedAt: 90 });
    expect(current.title).toBe('New');
    // the stale tab keeps its base, so its next save still meets the 409 for the other device's edit
    expect(stale.source).toMatchObject({ name: 'New', folder: 'b', updatedAt: 50 });
    expect(other.source).toMatchObject({ name: 'Old', updatedAt: 70 });
  });

  it('moves no base when the version before the rename is unknown', () => {
    const t = tab({ source: fileSrc(70) });
    applyFileMeta([t], meta(90), null);
    expect(t.source).toMatchObject({ name: 'New', updatedAt: 70 });
  });
});

describe('isBlankBoard (where lila’s FEN box sets a position up)', () => {
  const empty = { children: [] };
  it('reuses only a new board without moves, comments or shapes', () => {
    expect(isBlankBoard(tab(), empty)).toBe(true);
    expect(isBlankBoard(tab(), { children: [{}] })).toBe(false);
    expect(isBlankBoard(tab(), { children: [], comments: [{}] })).toBe(false);
    expect(isBlankBoard(tab(), { children: [], shapes: [{}] })).toBe(false);
    expect(isBlankBoard(tab({ games: [G1, G2], baseline: [G1, null] }), empty)).toBe(false);
  });

  it('never reuses a My Files file or a stored game', () => {
    const file: TabSource = { kind: 'file', fileId: 1, name: 'f', folder: '', fileKind: 'repertoire', color: 'white', updatedAt: 1, gameIndex: 0 };
    expect(isBlankBoard(tab({ source: file }), empty)).toBe(false);
    expect(isBlankBoard(tab({ source: { kind: 'game', gameId: 1, url: null } }), empty)).toBe(false);
  });
});

describe('TabList', () => {
  beforeEach(() => sessionStorage.clear());

  it('adds after the active tab, activates and removes with a neighbour taking over', () => {
    const list = new TabList();
    const a = list.add(tab({ title: 'a' }));
    const b = list.add(tab({ title: 'b' }));
    list.activate(a.id);
    const c = list.add(tab({ title: 'c' }));
    expect(list.tabs.map(t => t.title)).toEqual(['a', 'c', 'b']);
    expect(list.active).toBe(c);
    expect(list.remove(c.id)).toBe(b);
    expect(list.remove(b.id)).toBe(a);
    expect(list.remove('nope')).toBe(a);
    list.remove(a.id);
    expect(list.active).toBeUndefined();
  });

  it('moves tabs and ignores unknown ids', () => {
    const list = new TabList();
    const [a, b, c] = ['a', 'b', 'c'].map(title => list.add(tab({ title })));
    list.move(a!.id, 99);
    expect(list.tabs.map(t => t.title)).toEqual(['b', 'c', 'a']);
    list.move(c!.id, 0);
    expect(list.tabs.map(t => t.title)).toEqual(['c', 'b', 'a']);
    list.activate('nope');
    expect(list.active?.id).toBe(c!.id);
    list.move('nope', 0);
    expect(list.tabs.map(t => t.id)).toEqual([c!.id, b!.id, a!.id]);
    expect(list.find({ kind: 'new' })).toBeUndefined();
  });

  it('caps the number of tabs by dropping the oldest unchanged ones', () => {
    const list = new TabList();
    const dirty = list.add(tab({ title: 'dirty', games: [G2] }));
    for (let i = 0; i < 30; i++) list.add(tab({ title: `t${i}` }));
    expect(list.tabs).toHaveLength(24);
    expect(list.tabs.some(t => t.id === dirty.id)).toBe(true);
    expect(list.tabs.some(t => t.title === 't0')).toBe(false);
    expect(list.active?.title).toBe('t29');
  });

  it('survives a reload through sessionStorage and drops malformed data', () => {
    const list = new TabList(sessionStorage);
    list.add(tab({ title: 'kept', path: null, orientation: 'black' }));
    list.add(tab({ title: 'file', source: { kind: 'file', fileId: 1, name: 'f', folder: 'x', fileKind: 'repertoire', color: 'black', updatedAt: 5, gameIndex: 0 } }));
    const restored = new TabList(sessionStorage);
    restored.load();
    expect(restored.tabs.map(t => t.title)).toEqual(['kept', 'file']);
    expect(restored.active?.title).toBe('file');

    const index = JSON.parse(sessionStorage.getItem(TABS_STORAGE_KEY)!);
    const first = JSON.parse(sessionStorage.getItem(TAB_STORAGE_PREFIX + index.ids[0])!);
    const bad = (id: string, t: unknown) => {
      index.ids.push(id);
      sessionStorage.setItem(TAB_STORAGE_PREFIX + id, JSON.stringify(t));
    };
    bad('x', { id: 'x', title: 'bad', games: [], baseline: [], current: 0, path: '', orientation: 'white', source: { kind: 'new' } });
    bad('y', { ...first, id: 'y', current: 5 });
    bad('z', { ...first, id: 'z', source: { kind: 'evil' } });
    bad('w', { ...first }); // stored under another id
    index.ids.push('missing', 42);
    sessionStorage.setItem(TAB_STORAGE_PREFIX + 'v', '{not json');
    index.ids.push('v');
    sessionStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(index));
    const again = new TabList(sessionStorage);
    again.load();
    expect(again.tabs.map(t => t.title)).toEqual(['kept', 'file']);
    // entries the restored list does not hold are cleaned up
    expect(Object.keys(sessionStorage).filter(k => k.startsWith(TAB_STORAGE_PREFIX)).sort()).toEqual(
      again.tabs.map(t => TAB_STORAGE_PREFIX + t.id).sort(),
    );

    sessionStorage.setItem(TABS_STORAGE_KEY, '{not json');
    const broken = new TabList(sessionStorage);
    broken.load();
    expect(broken.tabs).toEqual([]);
  });

  it('reads the tabs a previous version stored in the index, and stores them the new way', () => {
    const old = tab({ title: 'from v1' });
    sessionStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ activeId: old.id, tabs: [old, { id: 1 }] }));
    const list = new TabList(sessionStorage);
    list.load();
    expect(list.tabs.map(t => t.title)).toEqual(['from v1']);
    expect(JSON.parse(sessionStorage.getItem(TABS_STORAGE_KEY)!)).toEqual({ v: 2, activeId: old.id, ids: [old.id] });
    expect(sessionStorage.getItem(TAB_STORAGE_PREFIX + old.id)).not.toBeNull();
  });

  it('rewrites only the tab that changed, and forgets closed tabs', () => {
    const { storage, writes } = memoryStorage();
    const list = new TabList(storage);
    const a = list.add(tab({ title: 'a' }));
    const b = list.add(tab({ title: 'b' }));
    writes.length = 0;
    b.games[0] = G2;
    list.saveTab(b);
    expect(writes).toEqual([TAB_STORAGE_PREFIX + b.id]);
    writes.length = 0;
    list.activate(a.id);
    expect(writes).toEqual([TABS_STORAGE_KEY]); // the index only
    list.remove(b.id);
    expect(storage.getItem(TAB_STORAGE_PREFIX + b.id)).toBeNull();
    list.saveTab(b); // a closed tab is not stored again
    expect(storage.getItem(TAB_STORAGE_PREFIX + b.id)).toBeNull();
  });

  it('leaves out a tab too large to keep, and says so', () => {
    const list = new TabList(sessionStorage);
    const small = list.add(tab({ title: 'small' }));
    const game = `[Result "*"]\n\n1. e4 { ${'x'.repeat(1000)} } *\n`;
    const big = list.add(tab({ title: 'big', games: [G1], baseline: [G1] }));
    expect(list.unkept(big)).toBe(false);
    big.games = Array.from({ length: Math.ceil(MAX_KEPT_TAB_CHARS / game.length) + 1 }, () => game);
    big.baseline = big.games.map(() => null);
    list.saveTab(big);
    expect(list.unkept(big)).toBe(true);
    expect(sessionStorage.getItem(TAB_STORAGE_PREFIX + big.id)).toBeNull(); // no stale copy either
    expect(list.unkept(small)).toBe(false);
    const restored = new TabList(sessionStorage);
    restored.load();
    expect(restored.tabs.map(t => t.title)).toEqual(['small']);
    big.games = [G1];
    big.baseline = [G1];
    list.saveTab(big);
    expect(list.unkept(big)).toBe(false);
  });

  it('treats a full storage like a tab too large to keep', () => {
    const { storage, fill } = memoryStorage();
    const list = new TabList(storage);
    const t = list.add(tab({ title: 't' }));
    expect(list.unkept(t)).toBe(false);
    fill();
    list.saveTab(t);
    expect(list.unkept(t)).toBe(true);
    expect(storage.getItem(TAB_STORAGE_PREFIX + t.id)).toBeNull();
  });

  it('does not persist without storage (the embed)', () => {
    const list = new TabList(null);
    list.add(tab());
    expect(sessionStorage.getItem(TABS_STORAGE_KEY)).toBeNull();
  });
});
