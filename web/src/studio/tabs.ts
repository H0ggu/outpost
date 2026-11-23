/**
 * Board tabs (PLAN §8.4): several games open at once, one shown by lila at a time. Switching tabs
 * exports the shown game to PGN and loads the next one with `changePgn`. The list survives a reload
 * of this browser tab (sessionStorage), never another device: saving is what My Files is for.
 *
 * Storage: an index (order, active tab) plus one entry per tab, so a move on the board rewrites only
 * the tab it was played in. A tab too large to keep (a huge multi-game import) is left out; it is
 * then lost on reload, which `unkept` lets the page warn about.
 *
 * Pure state; the Studio wires it to lila (boot.ts) and renders it (chrome.ts).
 */
import type { Color, EpochMs, FileKind, Id, StudioFileMeta } from '@outpost/shared/api';
import { joinPgnGames } from './pgn.ts';

/** Where a tab's game came from, which decides what Save does. */
export type TabSource =
  | {
      kind: 'file';
      fileId: Id;
      name: string;
      folder: string;
      fileKind: FileKind;
      color: Color | null;
      /** Server `updatedAt` of the version this tab is based on (sent as `baseUpdatedAt`). */
      updatedAt: EpochMs;
      /** Which game of a multi-game file is shown. */
      gameIndex: number;
    }
  | { kind: 'game'; gameId: Id; url: string | null }
  | { kind: 'new' };

/** One tab: every game of a file (or one game), the one on the board, and what changed. */
export interface StudioTab {
  id: string;
  title: string;
  source: TabSource;
  /** Single-game PGNs; for a file all of its games, otherwise exactly one. Exported when left. */
  games: string[];
  /**
   * Per game, its PGN as the Studio first exported it after loading (or last saved it); null for a
   * game never shown. A game is changed when its PGN differs from its baseline.
   */
  baseline: Array<string | null>;
  /** Index into `games` of the game on the board. */
  current: number;
  /** Tree path to restore when the tab is shown again; null for the end of the mainline. */
  path: string | null;
  orientation: Color;
}

/** sessionStorage key of the tab index (`{ v: 2, activeId, ids }`; version 1 held the tabs too). */
export const TABS_STORAGE_KEY = 'outpost.studio.tabs';
/** sessionStorage key prefix of one tab (`<prefix><tab id>`). */
export const TAB_STORAGE_PREFIX = 'outpost.studio.tab.';
/** Tabs above this size (UTF-16 characters of PGN) are not kept in sessionStorage (~5M per origin). */
export const MAX_KEPT_TAB_CHARS = 1_500_000;
const MAX_TABS = 24;

let seq = 0;
/** Short unique id for a tab. */
export const newTabId = (): string => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The PGN a tab would save now. */
export const tabPgn = (tab: StudioTab): string => joinPgnGames(tab.games);

/**
 * True when a game of the tab differs from its baseline. `currentPgn` is the live export of the game
 * on the board (the stored copy is only refreshed when the tab is left).
 */
export function isDirty(tab: StudioTab, currentPgn?: string): boolean {
  return tab.games.some((g, i) => {
    const base = tab.baseline[i];
    const pgn = i === tab.current && currentPgn !== undefined ? currentPgn : g;
    return base !== null && base !== undefined && pgn !== base;
  });
}

/**
 * Marks the tab's games as saved: `saved` (the games as sent, by default the current ones) become the
 * baseline. Changes made while the save was on its way stay unsaved, and so does a game added since.
 */
export function markSaved(tab: StudioTab, saved: readonly string[] = tab.games): void {
  tab.baseline = tab.games.map((_, i) => {
    const pgn = saved[i];
    if (pgn === undefined) return tab.baseline[i] ?? null;
    return tab.baseline[i] === null && i !== tab.current ? null : pgn;
  });
}

/** The newest server `updatedAt` this page knows for a file: from the My Files list or its open tabs. */
export function knownUpdatedAt(tabs: readonly StudioTab[], fileId: Id, listed: EpochMs): EpochMs {
  let at = listed;
  for (const t of tabs) if (t.source.kind === 'file' && t.source.fileId === fileId) at = Math.max(at, t.source.updatedAt);
  return at;
}

/**
 * After a rename or move (a PUT without content), open tabs of the file take its new name and
 * folder. A tab moves its conflict base forward only when it was based on the version the PUT was
 * checked against (`checkedAt`); a tab based on an older version keeps its base, so its next save
 * still gets the 409 for the content saved elsewhere. `checkedAt` null: the previous version is unknown.
 */
export function applyFileMeta(tabs: readonly StudioTab[], file: StudioFileMeta, checkedAt: EpochMs | null): StudioTab[] {
  const changed: StudioTab[] = [];
  for (const t of tabs) {
    if (t.source.kind !== 'file' || t.source.fileId !== file.id) continue;
    t.source.name = file.name;
    t.source.folder = file.folder;
    if (checkedAt !== null && t.source.updatedAt === checkedAt) t.source.updatedAt = file.updatedAt;
    t.title = file.name;
    changed.push(t);
  }
  return changed;
}

/** The parts of the board's tree root that tell whether anything is on it. */
export interface BoardRoot {
  children: readonly unknown[];
  comments?: readonly unknown[];
  shapes?: readonly unknown[];
}

/**
 * A board with nothing to lose: a tab not tied to a file or stored game, holding one game without
 * moves, comments or drawn shapes. lila's FEN box sets a position up on such a board in place and
 * opens a new tab for any other (lila itself opens a fresh analysis page).
 */
export function isBlankBoard(tab: StudioTab, root: BoardRoot): boolean {
  return (
    tab.source.kind === 'new' &&
    tab.games.length === 1 &&
    !root.children.length &&
    !root.comments?.length &&
    !root.shapes?.length
  );
}

/** Characters a tab takes in storage, roughly (its PGN; cheap, for the size limit). */
function tabChars(tab: StudioTab): number {
  let n = tab.title.length;
  for (const g of tab.games) n += g.length;
  for (const b of tab.baseline) n += b?.length ?? 0;
  return n;
}

/** Same source (to focus an open tab instead of opening a game or file twice). */
export function sameSource(a: TabSource, b: TabSource): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.fileId === b.fileId;
  if (a.kind === 'game' && b.kind === 'game') return a.gameId === b.gameId;
  return false;
}

/** Ordered tabs with one active. */
export class TabList {
  tabs: StudioTab[] = [];
  activeId: string | null = null;
  private readonly storage: Storage | null;
  /** Tabs too large to keep in storage (lost on reload). */
  private readonly unkeptIds = new Set<string>();

  constructor(storage: Storage | null = null) {
    this.storage = storage;
  }

  get active(): StudioTab | undefined {
    return this.tabs.find(t => t.id === this.activeId) ?? this.tabs[0];
  }

  find(source: TabSource): StudioTab | undefined {
    return this.tabs.find(t => sameSource(t.source, source));
  }

  /** True when the tab is not kept in storage (too large), so a reload would lose it. */
  unkept(tab: StudioTab): boolean {
    return this.unkeptIds.has(tab.id);
  }

  /** Adds a tab after the active one and activates it. Drops the oldest clean tab beyond the cap. */
  add(tab: StudioTab): StudioTab {
    const at = this.tabs.findIndex(t => t.id === this.activeId);
    this.tabs.splice(at === -1 ? this.tabs.length : at + 1, 0, tab);
    this.activeId = tab.id;
    while (this.tabs.length > MAX_TABS) {
      const victim = this.tabs.find(t => t.id !== tab.id && !isDirty(t));
      if (!victim) break;
      this.remove(victim.id);
    }
    this.saveTab(tab);
    this.saveIndex();
    return tab;
  }

  /** Removes a tab; activates its neighbour when it was active. Returns the new active tab. */
  remove(id: string): StudioTab | undefined {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i === -1) return this.active;
    this.tabs.splice(i, 1);
    if (this.activeId === id) this.activeId = (this.tabs[i] ?? this.tabs[i - 1])?.id ?? null;
    this.unkeptIds.delete(id);
    this.forget(id);
    this.saveIndex();
    return this.active;
  }

  activate(id: string): StudioTab | undefined {
    if (this.tabs.some(t => t.id === id)) this.activeId = id;
    this.saveIndex();
    return this.active;
  }

  /** Moves a tab to another position (drag and drop, keyboard). */
  move(id: string, to: number): void {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i === -1) return;
    const [tab] = this.tabs.splice(i, 1);
    if (tab) this.tabs.splice(Math.max(0, Math.min(to, this.tabs.length)), 0, tab);
    this.saveIndex();
  }

  /** Stores every tab and the index. */
  save(): void {
    for (const t of this.tabs) this.saveTab(t);
    this.saveIndex();
  }

  /** Stores one tab (after it changed); a tab above the size limit is left out instead. */
  saveTab(tab: StudioTab): void {
    if (!this.storage || !this.tabs.includes(tab)) return;
    if (tabChars(tab) > MAX_KEPT_TAB_CHARS) {
      if (!this.unkeptIds.has(tab.id)) {
        this.unkeptIds.add(tab.id);
        this.forget(tab.id);
      }
      return;
    }
    this.unkeptIds.delete(tab.id);
    try {
      this.storage.setItem(TAB_STORAGE_PREFIX + tab.id, JSON.stringify(tab));
    } catch {
      // quota or disabled storage: this tab won't survive a reload
      this.unkeptIds.add(tab.id);
      this.forget(tab.id);
    }
  }

  private saveIndex(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(TABS_STORAGE_KEY, JSON.stringify({ v: 2, activeId: this.activeId, ids: this.tabs.map(t => t.id) }));
    } catch {
      // quota or disabled storage: tabs just won't survive a reload
    }
  }

  private forget(id: string): void {
    try {
      this.storage?.removeItem(TAB_STORAGE_PREFIX + id);
    } catch {
      // storage unavailable
    }
  }

  /** Restores the tabs saved by `save()`/`saveTab()`; ignores anything malformed or missing. */
  load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(TABS_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { activeId?: unknown; tabs?: unknown; ids?: unknown };
      if (Array.isArray(data.tabs)) {
        // version 1: the tabs were stored in the index
        this.tabs = data.tabs.filter(isTab);
        this.activeId = typeof data.activeId === 'string' ? data.activeId : null;
        this.save();
        return;
      }
      if (!Array.isArray(data.ids)) return;
      this.tabs = data.ids
        .filter((id): id is string => typeof id === 'string')
        .map(id => this.readTab(id))
        .filter((t): t is StudioTab => !!t);
      this.activeId = typeof data.activeId === 'string' ? data.activeId : null;
      this.dropStrayEntries();
    } catch {
      this.tabs = [];
    }
  }

  private readTab(id: string): StudioTab | undefined {
    try {
      const t = JSON.parse(this.storage?.getItem(TAB_STORAGE_PREFIX + id) ?? 'null') as unknown;
      return isTab(t) && t.id === id ? t : undefined;
    } catch {
      return undefined;
    }
  }

  /** Removes stored tabs the index no longer lists (closed in a version that crashed mid-way). */
  private dropStrayEntries(): void {
    const s = this.storage;
    if (!s) return;
    const keep = new Set(this.tabs.map(t => TAB_STORAGE_PREFIX + t.id));
    const stray: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(TAB_STORAGE_PREFIX) && !keep.has(key)) stray.push(key);
    }
    for (const key of stray) s.removeItem(key);
  }
}

function isTab(t: unknown): t is StudioTab {
  if (typeof t !== 'object' || t === null) return false;
  const tab = t as Partial<StudioTab>;
  return (
    typeof tab.id === 'string' &&
    typeof tab.title === 'string' &&
    Array.isArray(tab.games) &&
    tab.games.length > 0 &&
    tab.games.every(g => typeof g === 'string') &&
    Array.isArray(tab.baseline) &&
    tab.baseline.length === tab.games.length &&
    tab.baseline.every(g => g === null || typeof g === 'string') &&
    typeof tab.current === 'number' &&
    tab.current >= 0 &&
    tab.current < tab.games.length &&
    (tab.path === null || typeof tab.path === 'string') &&
    (tab.orientation === 'white' || tab.orientation === 'black') &&
    typeof tab.source === 'object' &&
    tab.source !== null &&
    ['file', 'game', 'new'].includes((tab.source as { kind?: string }).kind ?? '')
  );
}
