/** Board tabs (src/studio/tabs.ts): order, activation, dirty tracking and sessionStorage persistence. */
import { beforeEach, describe, expect, it } from 'vitest';
import { isDirty, markSaved, newTabId, sameSource, TabList, TABS_STORAGE_KEY, tabPgn, type StudioTab } from '../src/studio/tabs.ts';

const G1 = '[Result "*"]\n\n1. e4 *\n';
const G2 = '[Result "*"]\n\n1. d4 *\n';

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

  it('knows when two tabs show the same game or file', () => {
    expect(sameSource({ kind: 'game', gameId: 1, url: null }, { kind: 'game', gameId: 1, url: 'x' })).toBe(true);
    expect(sameSource({ kind: 'game', gameId: 1, url: null }, { kind: 'game', gameId: 2, url: null })).toBe(false);
    const file = { kind: 'file', fileId: 3, name: 'a', folder: '', fileKind: 'study', color: null, updatedAt: 1, gameIndex: 0 } as const;
    expect(sameSource(file, { ...file, name: 'b', gameIndex: 2 })).toBe(true);
    expect(sameSource({ kind: 'new' }, { kind: 'new' })).toBe(false);
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

    const raw = JSON.parse(sessionStorage.getItem(TABS_STORAGE_KEY)!);
    raw.tabs.push({ id: 'x', title: 'bad', games: [], baseline: [], current: 0, path: '', orientation: 'white', source: { kind: 'new' } });
    raw.tabs.push({ ...raw.tabs[0], id: 'y', current: 5 });
    raw.tabs.push({ ...raw.tabs[0], id: 'z', source: { kind: 'evil' } });
    sessionStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(raw));
    const again = new TabList(sessionStorage);
    again.load();
    expect(again.tabs.map(t => t.title)).toEqual(['kept', 'file']);

    sessionStorage.setItem(TABS_STORAGE_KEY, '{not json');
    const broken = new TabList(sessionStorage);
    broken.load();
    expect(broken.tabs).toEqual([]);
  });

  it('does not persist without storage (the embed)', () => {
    const list = new TabList(null);
    list.add(tab());
    expect(sessionStorage.getItem(TABS_STORAGE_KEY)).toBeNull();
  });
});
