/**
 * Board tabs (PLAN §8.4): several games open at once, one shown by lila at a time. Switching tabs
 * exports the shown game to PGN and loads the next one with `changePgn`. The list survives a reload
 * of this browser tab (sessionStorage), never another device: saving is what My Files is for.
 *
 * Pure state; the Studio wires it to lila (boot.ts) and renders it (chrome.ts).
 */
import type { Color, EpochMs, FileKind, Id } from '@outpost/shared/api';
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

/** Per-tab storage key (sessionStorage). */
export const TABS_STORAGE_KEY = 'outpost.studio.tabs';
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

/** Marks the tab's games as saved (their current PGN becomes the baseline). */
export function markSaved(tab: StudioTab): void {
  tab.baseline = tab.games.map((g, i) => (tab.baseline[i] === null && i !== tab.current ? null : g));
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

  constructor(storage: Storage | null = null) {
    this.storage = storage;
  }

  get active(): StudioTab | undefined {
    return this.tabs.find(t => t.id === this.activeId) ?? this.tabs[0];
  }

  find(source: TabSource): StudioTab | undefined {
    return this.tabs.find(t => sameSource(t.source, source));
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
    this.save();
    return tab;
  }

  /** Removes a tab; activates its neighbour when it was active. Returns the new active tab. */
  remove(id: string): StudioTab | undefined {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i === -1) return this.active;
    this.tabs.splice(i, 1);
    if (this.activeId === id) this.activeId = (this.tabs[i] ?? this.tabs[i - 1])?.id ?? null;
    this.save();
    return this.active;
  }

  activate(id: string): StudioTab | undefined {
    if (this.tabs.some(t => t.id === id)) this.activeId = id;
    this.save();
    return this.active;
  }

  /** Moves a tab to another position (drag and drop, keyboard). */
  move(id: string, to: number): void {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i === -1) return;
    const [tab] = this.tabs.splice(i, 1);
    if (tab) this.tabs.splice(Math.max(0, Math.min(to, this.tabs.length)), 0, tab);
    this.save();
  }

  save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(TABS_STORAGE_KEY, JSON.stringify({ activeId: this.activeId, tabs: this.tabs }));
    } catch {
      // quota or disabled storage: tabs just won't survive a reload
    }
  }

  /** Restores the tabs saved by `save()`; ignores anything malformed. */
  load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(TABS_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { activeId?: unknown; tabs?: unknown };
      if (!Array.isArray(data.tabs)) return;
      this.tabs = data.tabs.filter(isTab);
      this.activeId = typeof data.activeId === 'string' ? data.activeId : null;
    } catch {
      this.tabs = [];
    }
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
