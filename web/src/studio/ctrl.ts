/**
 * The Studio controller (PLAN §8.4): Outpost's state around lila's analysis board — session and
 * prefs, board tabs, My Files, the annotation panel — and every action the chrome offers. lila's own
 * controller is `this.analyse` once mounted (boot.ts); Studio talks to it only through the members
 * declared in lila-types/analyse/interfaces.d.ts.
 */
import {
  API_ROUTES,
  DEFAULT_PREFS,
  type Color,
  type EpochMs,
  type ExplorerGamesPage,
  type FileKind,
  type FileSearchResponse,
  type FolderInfo,
  type GameResponse,
  type Id,
  type SessionInfo,
  type StudioFile,
  type StudioFileMeta,
  type StudioLayout,
} from '@outpost/shared/api';
import { fromExplorerGameId } from '@outpost/shared/api';
import { withQuery } from '@outpost/shared/filters';
import { ApiError, api } from '../app/api/client.ts';
import { paths } from '../app/paths.ts';
import type { AnalyseCtrl, AnalyseData, ExplorerDb, Glyph, TreeNode } from 'lila/analyse/interfaces';
import pgnImport, { glyphOfNag, pgnCommentId } from 'lila/analyse/pgnImport';
import { alert, confirm } from 'lila/lib/view';
import { filesApi } from './filesApi.ts';
import { buildFolderTree, normalizeFolder, type FolderNode } from './fileTree.ts';
import {
  emptyGamePgn,
  fenToPgn,
  gameTitle,
  GLYPH_GROUPS,
  hasPgnContent,
  joinPgnGames,
  mainlinePlyOf,
  pathOfPosition,
  pgnHeaders,
  sortGlyphs,
  splitPgnGames,
  treeToPgn,
} from './pgn.ts';
import type { EmbedPositionMessage, EmbedShowGamesMessage } from '../app/explorerEmbed.ts';
import {
  appendPage,
  lineFilterOf,
  positionGamesQuery,
  sanOfLine,
  type PositionGamesRequest,
  type PositionGamesState,
} from './positionGames.ts';
import { savePrefs, applyStudioPrefs, type StudioPrefs } from './prefs.ts';
import { cleanFen, type StudioParams } from './query.ts';
import { SaveQueue } from './saveQueue.ts';
import {
  applyFileMeta,
  isBlankBoard,
  isDirty,
  knownUpdatedAt,
  markSaved,
  newTabId,
  TabList,
  type StudioTab,
  type TabSource,
} from './tabs.ts';

/** lila `AnalysePref` for Studio boards (lila's defaults: inner coordinates, click or drag). */
export const ANALYSE_PREF: AnalyseData['pref'] = {
  coords: 1,
  is3d: false,
  showDests: true,
  rookCastle: true,
  destination: true,
  highlight: true,
  showCaptured: true,
  animationDuration: 250,
  keyboardMove: false,
  moveEvent: 2,
};

/** Analysis data for a single-game PGN (lila's importer, scripts/lila-patches/003). */
export function analyseDataOf(pgn: string, orientation: Color): AnalyseData {
  const imported = pgnImport(pgn) as AnalyseData;
  return { ...imported, orientation, pref: ANALYSE_PREF, takebackable: false, moretimeable: false };
}

/** What a dialog asks for when saving a new file. */
export interface SaveAsInput {
  name: string;
  folder: string;
  kind: FileKind;
  color: Color | null;
}

/** The My Files panel. */
export interface FilesState {
  status: 'signedOut' | 'loading' | 'ready' | 'error';
  error?: string;
  list: StudioFileMeta[];
  folders: FolderInfo[];
  trashCount: number;
  trash: StudioFileMeta[] | null;
  view: 'files' | 'trash' | 'search';
  expanded: Set<string>;
  localFolders: string[];
  /** Folder new files go to by default (the last one opened or created). */
  selectedFolder: string;
  search?: { fen: string; status: 'loading' | 'ready' | 'error'; result?: FileSearchResponse; error?: string };
}

const LOCAL_FOLDERS_KEY = 'outpost.studio.folders';

/** Games listed at once in the Games panel (more on request: files can hold thousands). */
export const GAMES_PAGE = 200;

const errorMessage = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);

export class StudioCtrl {
  session: SessionInfo | null = null;
  prefs: StudioPrefs;
  readonly params: StudioParams;
  readonly tabs: TabList;
  analyse?: AnalyseCtrl;
  files: FilesState;
  private readonly dirtyIds = new Set<string>();
  /** Open dropdown of the Studio bar. */
  menu: 'file' | null = null;
  /** View of the side panel. */
  sidePanel: 'files' | 'annotate' | 'games' | 'position' = 'files';
  /** The games at a position the player explorer listed ("All N games"), shown in the side panel. */
  positionGames: PositionGamesState | null = null;
  /** Display name of a player spec (the explorer's labels; set by boot.ts). */
  playerLabel: (spec: string) => string = spec => spec;
  /** The last position message sent to the embedding page (sent again only when it changes). */
  private lastEmbedPosition = '';
  /** How many games the Games panel lists. */
  gamesShown = GAMES_PAGE;
  /** Chrome redraw, set by boot.ts. */
  redraw: () => void = () => undefined;
  /** Shows a tab's game on the board, set by boot.ts once lila is mounted. */
  private loader?: (tab: StudioTab) => void;
  /** A jump asked for before lila was mounted. */
  private pendingJump?: { fen?: string; ply?: number };
  /** A My Files search hit to show once lila is mounted (`jumpToHit`). */
  private pendingHit?: { fen: string; ply: number };
  /** Saves in flight, per tab. */
  private readonly saves = new SaveQueue<string>(() => this.redraw());

  constructor(params: StudioParams, prefs: StudioPrefs, storage: Storage | null) {
    this.params = params;
    this.prefs = prefs;
    this.tabs = new TabList(params.embed ? null : storage);
    this.files = {
      status: 'signedOut',
      list: [],
      folders: [],
      trashCount: 0,
      trash: null,
      view: 'files',
      expanded: new Set(['']),
      localFolders: this.readLocalFolders(),
      selectedFolder: '',
    };
  }

  // -------------------------------------------------------------------------
  // Session and prefs
  // -------------------------------------------------------------------------

  get signedIn(): boolean {
    return !!this.session?.user;
  }

  /** `/login?next=<this page>`. */
  loginUrl = (): string => paths.login(location.pathname + location.search);

  setSession(session: SessionInfo | null): void {
    this.session = session;
    const user = session?.user;
    if (user) {
      document.body.dataset.user = user.username.toLowerCase();
      this.prefs = { ...this.prefs, ...pickStudioPrefs(user.prefs) };
      applyStudioPrefs(this.prefs);
    } else delete document.body.dataset.user;
  }

  /** How W/D/L is coloured for this viewer (`UserPrefs.winratePerspective`; anonymous: the default). */
  get winratePerspective(): 'player' | 'white' {
    return this.session?.user?.prefs.winratePerspective ?? DEFAULT_PREFS.winratePerspective;
  }

  async setPref<K extends keyof StudioPrefs>(key: K, value: StudioPrefs[K]): Promise<void> {
    this.prefs = { ...this.prefs, [key]: value };
    applyStudioPrefs(this.prefs);
    if (key === 'studioLayout') this.applyLayout(value as StudioLayout);
    this.redraw();
    try {
      await savePrefs(this.prefs, { [key]: value }, this.signedIn);
    } catch (e) {
      await alert(`Could not save your settings: ${errorMessage(e)}`);
    }
  }

  /** Layout presets (PLAN §8.4): CSS does the arrangement; `explorer` also opens the explorer. */
  applyLayout(layout: StudioLayout = this.prefs.studioLayout): void {
    document.body.dataset.studioLayout = layout;
    const a = this.analyse;
    if (a && layout === 'explorer' && !a.explorer.enabled() && a.explorer.allowed()) {
      a.toggleExplorer();
      a.redraw();
    }
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  get activeTab(): StudioTab | undefined {
    return this.tabs.active;
  }

  isTabDirty(tab: StudioTab): boolean {
    return this.dirtyIds.has(tab.id);
  }

  get anyDirty(): boolean {
    return this.dirtyIds.size > 0;
  }

  /**
   * True when closing this browser tab would lose work, so leaving asks first: a board with changes
   * (sessionStorage keeps the others only until the browser tab closes), or a board too large to keep.
   */
  hasUnkeptWork(): boolean {
    this.checkDirty();
    return this.anyDirty || this.tabs.tabs.some(t => t.source.kind !== 'file' && this.tabs.unkept(t));
  }

  /** True while the tab is being saved to My Files. */
  isSaving(tab: StudioTab): boolean {
    return this.saves.busy(tab.id);
  }

  /** The tab differs from what was loaded or saved (the active one compared live with the board). */
  private hasChanges(tab: StudioTab): boolean {
    return tab === this.activeTab && this.analyse ? isDirty(tab, this.exportTree()) : isDirty(tab);
  }

  /** Called once lila is mounted with the active tab's game. */
  attach(analyse: AnalyseCtrl, loader: (tab: StudioTab) => void): void {
    this.analyse = analyse;
    this.loader = loader;
    // lila's own PGN box (underboard) replaces the shown game, which is also how a game's headers are
    // edited: keep the tab's headers and title in step. Several games open in a new tab instead, as a
    // game list (lila's importer would read only the first).
    const changePgn = analyse.changePgn.bind(analyse);
    analyse.changePgn = (pgn: string, andReload: boolean) => {
      const tab = this.activeTab;
      if (!andReload || !tab) return changePgn(pgn, andReload);
      if (splitPgnGames(pgn).length > 1) {
        const error = this.importText(pgn);
        if (!error) return analyse.data;
        analyse.pgnError = error;
        analyse.redraw();
        return undefined;
      }
      const data = changePgn(pgn, true);
      if (data) {
        const headers = pgnHeaders(pgn);
        tab.games[tab.current] = this.exportTree(headers);
        if (tab.source.kind !== 'file') tab.title = gameTitle(headers, tab.title);
        this.tabs.saveTab(tab);
        this.checkDirty();
        this.redraw();
      }
      return data;
    };
    const tab = this.activeTab;
    if (tab) this.afterLoad(tab);
  }

  /** PGN of the board's tree, with the given (or the active game's) headers. */
  exportTree(headers?: Array<[string, string]>): string {
    const a = this.analyse;
    const tab = this.activeTab;
    if (!a) return tab?.games[tab.current] ?? emptyGamePgn();
    return treeToPgn(a.tree.root, headers ?? (tab ? pgnHeaders(tab.games[tab.current] ?? '') : []));
  }

  /** Stores the shown game, path and orientation in the active tab. */
  syncActive(): void {
    const tab = this.activeTab;
    const a = this.analyse;
    if (!tab || !a) return;
    tab.games[tab.current] = this.exportTree();
    tab.path = a.path;
    tab.orientation = a.bottomColor();
    this.tabs.saveTab(tab);
  }

  /** After lila loaded a tab's game: record its baseline the first time it's shown. */
  private afterLoad(tab: StudioTab): void {
    if (!this.analyse) return;
    const pgn = this.exportTree();
    tab.games[tab.current] = pgn;
    if (tab.baseline[tab.current] === null) tab.baseline[tab.current] = pgn;
    this.tabs.saveTab(tab);
    this.updateDirty(tab, pgn);
    this.syncUrl();
  }

  private show(tab: StudioTab): void {
    this.loader?.(tab);
    this.afterLoad(tab);
    this.redraw();
  }

  /** Adds a tab and shows it. */
  openTab(tab: Omit<StudioTab, 'id' | 'baseline' | 'path'> & { path?: string | null }): StudioTab {
    this.syncActive();
    const full: StudioTab = { path: '', ...tab, id: newTabId(), baseline: tab.games.map(() => null) };
    this.tabs.add(full);
    this.gamesShown = GAMES_PAGE;
    this.show(full);
    return full;
  }

  switchTo(id: string): void {
    if (id === this.tabs.activeId) return;
    this.syncActive();
    const tab = this.tabs.activate(id);
    this.gamesShown = GAMES_PAGE;
    if (tab) this.show(tab);
  }

  async closeTab(id: string): Promise<void> {
    const tab = this.tabs.tabs.find(t => t.id === id);
    if (!tab) return;
    if (this.isTabDirty(tab) && !(await confirm(`Close “${tab.title}” and discard its unsaved changes?`))) return;
    const wasActive = id === this.tabs.active?.id;
    if (wasActive) this.syncActive();
    this.dirtyIds.delete(id);
    const next = this.tabs.remove(id);
    if (!next) this.newTab();
    else if (wasActive) this.show(next);
    else this.redraw();
  }

  /** An empty analysis board. */
  newTab(fen?: string): void {
    const n = this.tabs.tabs.filter(t => t.source.kind === 'new').length + 1;
    this.openTab({
      title: fen ? 'Position' : `Analysis ${n}`,
      source: { kind: 'new' },
      games: [fen ? fenToPgn(fen) : emptyGamePgn()],
      current: 0,
      orientation: this.params.color ?? 'white',
    });
  }

  /** Shows another game of the active (multi-game) tab. */
  selectGame(index: number): void {
    const tab = this.activeTab;
    if (!tab || index === tab.current || index < 0 || index >= tab.games.length) return;
    this.syncActive();
    tab.current = index;
    tab.path = '';
    if (tab.source.kind === 'file') tab.source.gameIndex = index;
    this.show(tab);
  }

  /**
   * lila's FEN box (scripts/lila-patches/001 `changeFen`). lila opens a fresh analysis page there; the
   * Studio opens a new board tab, so the game on the board (maybe a My Files game) is never replaced.
   * A blank board (no moves, no annotations) is reused instead of piling up tabs.
   */
  changeFen(fen: string): void {
    const tab = this.activeTab;
    const a = this.analyse;
    if (!tab || !a) return;
    let pgn: string;
    try {
      pgn = fenToPgn(fen);
    } catch (e) {
      void alert(errorMessage(e));
      return;
    }
    if (!isBlankBoard(tab, a.tree.root)) return this.newTab(fen);
    tab.title = 'Position';
    tab.games = [pgn];
    tab.baseline = [null];
    tab.current = 0;
    tab.path = '';
    this.show(tab);
  }

  /** Re-checks which tabs differ from what was loaded or saved (cheap; runs on a timer and on edits). */
  checkDirty(): void {
    const tab = this.activeTab;
    if (!tab || !this.analyse) return;
    this.updateDirty(tab, this.exportTree());
  }

  /**
   * After lila changed the board (debounced): records the shown game, cursor and orientation in the
   * active tab, so a reload of this browser tab restores them, and refreshes the unsaved markers.
   */
  onBoardChange(): void {
    const tab = this.activeTab;
    const a = this.analyse;
    if (!tab || !a) return;
    const pgn = this.exportTree();
    tab.games[tab.current] = pgn;
    tab.path = a.path;
    tab.orientation = a.bottomColor();
    this.tabs.saveTab(tab);
    this.updateDirty(tab, pgn);
  }

  private updateDirty(active: StudioTab, livePgn: string): void {
    let changed = false;
    for (const t of this.tabs.tabs) {
      const dirty = isDirty(t, t === active ? livePgn : undefined);
      if (dirty !== this.dirtyIds.has(t.id)) {
        changed = true;
        if (dirty) this.dirtyIds.add(t.id);
        else this.dirtyIds.delete(t.id);
      }
    }
    if (changed) this.redraw();
  }

  /**
   * Keeps the address bar on the active tab's source, so the URL can be shared or reloaded. The
   * explorer parameters stay (the filters segment lives only there); one-shot ones (`pgn`, `fen`)
   * go, since the tab itself survives a reload.
   */
  syncUrl(): void {
    if (this.params.embed) return;
    const src = this.activeTab?.source;
    const p = this.params;
    const url = withQuery('/studio', {
      ...(src?.kind === 'file' ? { file: src.fileId } : src?.kind === 'game' ? { game: src.gameId } : {}),
      ...(p.explorer ? { explorer: p.explorer.db === 'player' ? `player:${p.explorer.player}` : p.explorer.db } : {}),
      ...(p.explorer && p.color ? { color: p.color } : {}),
      ...(p.filters ? { filters: p.filters } : {}),
    });
    if (location.pathname + location.search !== url) history.replaceState(history.state, '', url + location.hash);
  }

  // -------------------------------------------------------------------------
  // Opening games
  // -------------------------------------------------------------------------

  /** Opens PGN text (one tab; several games become a game list). */
  openPgnText(pgn: string, title?: string): void {
    const games = splitPgnGames(pgn);
    this.openTab({
      title: title ?? gameTitle(pgnHeaders(games[0] ?? ''), 'Imported PGN'),
      source: { kind: 'new' },
      games,
      current: 0,
      path: null,
      orientation: this.params.color ?? 'white',
    });
  }

  /** Opens a stored Outpost game (`GET /api/games/:id`), optionally at the first ply reaching `fen`. */
  async openGame(id: Id, opts: { fen?: string; orientation?: Color } = {}): Promise<void> {
    const existing = this.tabs.find({ kind: 'game', gameId: id, url: null });
    if (existing) {
      this.switchTo(existing.id);
    } else {
      let res: GameResponse;
      try {
        res = await api.get<GameResponse>(API_ROUTES.game(id));
      } catch (e) {
        // not awaited: this also runs while the Studio boots, before the board exists
        void alert(`Could not open game ${id}: ${errorMessage(e)}`);
        return;
      }
      const g = res.game;
      this.openTab({
        title: `${g.white.name} – ${g.black.name}`,
        source: { kind: 'game', gameId: g.id, url: g.url },
        games: [res.pgn],
        current: 0,
        path: null,
        orientation: opts.orientation ?? 'white',
      });
    }
    if (opts.fen) this.jumpToFen(opts.fen);
  }

  /** Jumps to the first mainline ply that reaches `fen` (once lila is mounted). */
  jumpToFen(fen: string): void {
    const a = this.analyse;
    if (!a) {
      this.pendingJump = { fen };
      return;
    }
    const ply = mainlinePlyOf(a.tree.root, fen);
    if (ply !== undefined) {
      a.jumpToMain(ply);
      a.redraw();
      this.syncActive();
    }
  }

  /** Applies a jump requested before lila was mounted (`?game=…&fen=…`, `?file=…` search hits). */
  applyPendingJump(): void {
    const jump = this.pendingJump;
    this.pendingJump = undefined;
    const hit = this.pendingHit;
    this.pendingHit = undefined;
    if (hit && this.analyse) this.jumpToHit(hit.fen, hit.ply);
    if (!jump || !this.analyse) return;
    if (jump.fen) this.jumpToFen(jump.fen);
    else if (jump.ply !== undefined) {
      this.analyse.jumpToMain(jump.ply);
      this.analyse.redraw();
    }
  }

  /**
   * Opens what the query names (PLAN §8.4), before lila is mounted: `?game=` (at `?fen=` when given),
   * `?file=`, `?pgn=` (at `?fen=`), or `?fen=` alone for a new position. A game or file that is
   * already open in a restored tab is focused instead of opened twice.
   */
  async openFromQuery(): Promise<void> {
    const p = this.params;
    if (p.game !== undefined) await this.openGame(p.game, { fen: p.fen, orientation: p.color });
    else if (p.file !== undefined) await this.openFile(p.file);
    else if (p.pgn) {
      this.openPgnText(p.pgn);
      if (p.fen) this.jumpToFen(p.fen);
    } else if (p.fen) this.newTab(p.fen);
    // not awaited, like the other boot-time notices: the board comes up behind it
    if (p.badFen !== undefined)
      void alert(`“${p.badFen}” is not a position Outpost can read (a FEN), so the board starts from the initial position.`);
  }

  /** `?explorer=masters|lichess|reference|player:<spec>` (+ `&color=`): opens lila's explorer there. */
  openExplorerFromQuery(): void {
    const a = this.analyse;
    const want = this.params.explorer;
    if (!a || !a.explorer.allowed()) return;
    if (!want) {
      // the profile Explorer tab (embed) always shows the explorer
      if (this.params.embed && !a.explorer.enabled()) a.toggleExplorer();
      return;
    }
    const config = a.explorer.config;
    if (want.db === 'player') {
      config.selectPlayer(want.player);
      if (this.params.color) config.data.color(this.params.color);
    } else config.data.db(want.db);
    if (!a.explorer.enabled()) a.toggleExplorer();
    else a.explorer.reload();
  }

  /** Game links in lila's explorer (scripts/lila-patches/002). */
  openExplorerGame = (db: ExplorerDb, id: string, orientation: Color, fen: string): void => {
    const outpostId = fromExplorerGameId(id);
    if (db === 'lichess' && outpostId === null) {
      // a game of the Lichess database: only lichess.org has it
      window.open(`https://lichess.org/${encodeURIComponent(id)}/${orientation}`, '_blank', 'noopener');
    } else if (outpostId !== null) {
      // inside the profile page (embed): open the full Studio in a new browser tab
      if (this.params.embed) window.open(paths.studio({ game: outpostId, fen, color: orientation }), '_blank', 'noopener');
      else void this.openGame(outpostId, { fen, orientation });
    } else void this.openMastersGame(id, fen, orientation, this.params.embed);
  };

  // -------------------------------------------------------------------------
  // Games at a position (the player explorer's "All N games", positionGames.ts)
  // -------------------------------------------------------------------------

  /** The filters segment that applies to a player: the profile the Studio was opened with only. */
  private segmentFor(player: string): string | undefined {
    const p = this.params;
    return p.explorer?.db === 'player' && p.explorer.player === player ? p.filters : undefined;
  }

  /**
   * "All N games" (scripts/lila-patches/002): the side panel lists them. In the embed (the profile
   * Explorer tab) the page shows them in its Games tab at this line; another player picked inside
   * the embed, or a line that can't be a filter, opens the full Studio there instead.
   */
  showPositionGames = (req: PositionGamesRequest): void => {
    if (this.params.embed) {
      const line = lineFilterOf(req.rootFen, req.play);
      const own = !!this.params.explorer && this.params.explorer.db === 'player' && this.params.explorer.player === req.player;
      if (own && line && window.parent !== window) {
        const msg: EmbedShowGamesMessage = { type: 'outpost:show-games', player: req.player, color: req.color, line };
        window.parent.postMessage(msg, location.origin);
      } else {
        const segment = this.segmentFor(req.player);
        window.open(
          paths.studio({ explorer: `player:${req.player}`, color: req.color, fen: req.fen, ...(segment ? { filters: segment } : {}) }),
          '_blank',
          'noopener',
        );
      }
      return;
    }
    this.positionGames = {
      req,
      label: this.playerLabel(req.player),
      san: sanOfLine(req.rootFen, req.play),
      status: 'loading',
      total: null,
      pages: 0,
      rows: { perspective: 'player', games: [] },
    };
    this.sidePanel = 'position';
    // "Board only" hides the side panel: show it for this list (the saved layout stays).
    if (document.body.dataset.studioLayout === 'focus') this.applyLayout('default');
    this.redraw();
    // On phones the side panel is below the board: bring the list into view (a no-op when visible).
    setTimeout(() => document.querySelector('.studio-side')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    void this.morePositionGames();
  };

  /** Loads the next page of the listed games. */
  async morePositionGames(): Promise<void> {
    const state = this.positionGames;
    if (!state || (state.status === 'loading' && state.pages > 0)) return;
    if (state.total !== null && state.rows.games.length >= state.total) return;
    const page = state.pages + 1;
    state.status = 'loading';
    state.error = undefined;
    this.redraw();
    try {
      const res = await api.get<ExplorerGamesPage>(API_ROUTES.explorer.games, positionGamesQuery(state.req, this.segmentFor(state.req.player), page));
      if (this.positionGames !== state) return; // another list replaced it meanwhile
      state.rows = appendPage(state, res);
      state.total = res.total;
      state.pages = page;
      state.status = 'ready';
    } catch (e) {
      if (this.positionGames !== state) return;
      state.status = 'error';
      state.error = errorMessage(e);
    }
    this.redraw();
  }

  /** Closes the list. */
  closePositionGames(): void {
    this.positionGames = null;
    if (this.sidePanel === 'position') this.sidePanel = 'files';
    // back to "Board only" when the list had to show the side panel
    if (document.body.dataset.studioLayout !== this.prefs.studioLayout) this.applyLayout();
    this.redraw();
  }

  /** Opens a listed game at the position, from the explored player's side. */
  openPositionGame(id: Id): void {
    const state = this.positionGames;
    if (!state) return;
    void this.openGame(id, { fen: state.req.fen, orientation: state.req.color });
  }

  /**
   * Embed: tells the page (the profile Explorer tab) where the board is and how many games the
   * player explorer counted there, so its links follow the board. Sent after lila redraws, only
   * when something changed.
   */
  postEmbedPosition(): void {
    const a = this.analyse;
    if (!this.params.embed || !a || window.parent === window) return;
    const config = a.explorer.config.data;
    const nodes = a.nodeList;
    const root = nodes[0];
    if (!root) return;
    const data = a.explorer.enabled() ? a.explorer.current() : undefined;
    const games =
      data?.isOpening && data.fen === a.node.fen && config.db() === 'player'
        ? (data.games ?? (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0))
        : null;
    const player = config.db() === 'player' ? config.playerName.value() : '';
    // lila redraws often (the engine, hovering): compare cheaply before replaying the line
    const key = JSON.stringify([root.fen, a.path, player, config.color(), games]);
    if (key === this.lastEmbedPosition) return;
    this.lastEmbedPosition = key;
    const msg: EmbedPositionMessage = {
      type: 'outpost:position',
      player,
      color: config.color(),
      line: lineFilterOf(root.fen, nodes.slice(1).map(n => n.uci ?? '')),
      fen: a.node.fen,
      games,
    };
    window.parent.postMessage(msg, location.origin);
  }

  /**
   * A masters (or other non-Outpost) explorer game: its PGN comes from `/api/explorer/masters/pgn/:id`.
   * From the embed it opens in a new browser tab, which is opened at once (still inside the click, so
   * popup blockers allow it) and pointed at the Studio when the PGN has arrived.
   */
  private async openMastersGame(id: string, fen: string, orientation: Color, newWindow: boolean): Promise<void> {
    const win = newWindow ? window.open('', '_blank') : null;
    let pgn: string;
    try {
      pgn = await api.text(API_ROUTES.explorer.mastersPgn(id));
    } catch (e) {
      win?.close();
      await alert(`Could not load the game: ${errorMessage(e)}`);
      return;
    }
    if (newWindow) {
      const url = paths.studio({ pgn, fen, color: orientation });
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else window.open(url, '_blank', 'noopener');
      return;
    }
    this.openTab({
      title: gameTitle(pgnHeaders(pgn), 'Masters game'),
      source: { kind: 'new' },
      games: [pgn],
      current: 0,
      path: null,
      orientation,
    });
    this.jumpToFen(fen);
  }

  /**
   * Opens pasted or uploaded text in a new tab: a FEN sets up the position, anything else is read as
   * PGN (several games become the tab's game list). Returns an error message instead of opening.
   */
  importText(text: string, title?: string): string | null {
    const t = text.trim();
    if (!t) return 'Paste a PGN or a FEN first.';
    const fen = cleanFen(t);
    if (fen && !t.includes('\n')) {
      try {
        fenToPgn(fen);
      } catch (e) {
        return errorMessage(e);
      }
      this.newTab(fen);
      return null;
    }
    let games: string[];
    try {
      games = splitPgnGames(t);
      games.forEach(g => pgnImport(g));
    } catch (e) {
      return `This PGN could not be read: ${errorMessage(e)}`;
    }
    if (!hasPgnContent(t)) return 'No moves or position found in this text.';
    this.openPgnText(t, title);
    return null;
  }

  /** Adds an empty game to the active tab (a file with several games) and shows it. */
  addGame(): void {
    const tab = this.activeTab;
    if (!tab) return;
    this.syncActive();
    tab.games.push(emptyGamePgn());
    tab.baseline.push('');
    this.selectGame(tab.games.length - 1);
    this.checkDirty();
  }

  /** Renames a tab; for a file, renames the file in My Files. */
  async renameTab(tab: StudioTab, name: string): Promise<void> {
    if (tab.source.kind === 'file') {
      const src = tab.source;
      const meta = this.files.list.find(f => f.id === src.fileId);
      await this.updateFileMeta(
        meta ?? {
          id: src.fileId,
          folder: src.folder,
          name: src.name,
          kind: src.fileKind,
          color: src.color,
          createdAt: 0,
          updatedAt: src.updatedAt,
          deletedAt: null,
        },
        { name },
      );
    } else {
      tab.title = name;
      this.tabs.saveTab(tab);
      this.redraw();
    }
  }

  /** The active tab's PGN (every game of a file), with the board's latest moves. */
  activePgn(): string {
    this.syncActive();
    const tab = this.activeTab;
    return tab ? joinPgnGames(tab.games) : '';
  }

  /** Saves the active tab's PGN as a file in the browser's downloads. */
  downloadPgn(): void {
    const tab = this.activeTab;
    if (!tab) return;
    const blob = new Blob([this.activePgn()], { type: 'application/x-chess-pgn' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(tab.title || 'game').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 100)}.pgn`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  /** Copies the active tab's PGN to the clipboard. */
  async copyPgn(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.activePgn());
      await alert('PGN copied to the clipboard.');
    } catch {
      await alert('The browser did not allow copying. Use Download PGN instead.');
    }
  }

  // -------------------------------------------------------------------------
  // My Files
  // -------------------------------------------------------------------------

  folderTree(): FolderNode {
    return buildFolderTree(this.files.list, this.files.folders, this.files.localFolders);
  }

  async refreshFiles(): Promise<void> {
    if (!this.signedIn) {
      this.files.status = 'signedOut';
      this.redraw();
      return;
    }
    if (this.files.status !== 'ready') this.files.status = 'loading';
    this.redraw();
    try {
      const [list, folders] = await Promise.all([filesApi.list(), filesApi.folders()]);
      this.files.list = list.files;
      this.files.folders = folders.folders;
      this.files.trashCount = folders.trashCount;
      this.files.status = 'ready';
      this.files.error = undefined;
      // A local folder that now holds files is a real one.
      this.setLocalFolders(this.files.localFolders.filter(f => !folders.folders.some(sf => sf.path === f)));
      if (this.files.view === 'trash') await this.loadTrash();
    } catch (e) {
      this.files.status = 'error';
      this.files.error = errorMessage(e);
    }
    this.redraw();
  }

  async loadTrash(): Promise<void> {
    try {
      this.files.trash = (await filesApi.trash()).files.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    } catch (e) {
      this.files.trash = [];
      this.files.error = errorMessage(e);
    }
    this.redraw();
  }

  setFilesView(view: FilesState['view']): void {
    this.files.view = view;
    if (view === 'trash') void this.loadTrash();
    if (view === 'search') void this.searchPosition();
    this.redraw();
  }

  toggleFolder(path: string): void {
    if (this.files.expanded.has(path)) this.files.expanded.delete(path);
    else this.files.expanded.add(path);
    this.files.selectedFolder = path;
    this.redraw();
  }

  private readLocalFolders(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(LOCAL_FOLDERS_KEY) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : [];
    } catch {
      return [];
    }
  }

  private setLocalFolders(folders: string[]): void {
    this.files.localFolders = [...new Set(folders)];
    try {
      localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(this.files.localFolders));
    } catch {
      // storage unavailable
    }
  }

  /** Creates a folder (it exists on the server once a file is saved into it). */
  addFolder(parent: string, name: string): string | null {
    const path = normalizeFolder(parent ? `${parent}/${name}` : name);
    if (!path) return null;
    this.setLocalFolders([...this.files.localFolders, path]);
    for (const p of path.split('/').map((_, i, all) => all.slice(0, i).join('/'))) this.files.expanded.add(p);
    this.files.expanded.add(path);
    this.files.selectedFolder = path;
    this.redraw();
    return path;
  }

  /**
   * Jumps to a My Files search hit: the node at `ply` (lila's ply, as the server indexes it) with
   * position `fen`, in the main line or a variation; the main line's ply when none matches.
   */
  private jumpToHit(fen: string, ply: number): void {
    const a = this.analyse;
    if (!a) {
      this.pendingHit = { fen, ply };
      return;
    }
    const path = pathOfPosition(a.tree.root, fen, ply);
    if (path !== undefined) a.userJump(path);
    else a.jumpToMain(ply);
    a.redraw();
    this.syncActive();
  }

  /**
   * Opens a file (focuses its tab when already open), optionally at a game and a ply; with `fen`
   * (a position search hit) at that position, which may be in a variation.
   */
  async openFile(id: Id, at?: { gameIndex: number; ply?: number; fen?: string }): Promise<void> {
    const existing = this.tabs.tabs.find(t => t.source.kind === 'file' && t.source.fileId === id);
    if (existing) {
      this.switchTo(existing.id);
    } else {
      let file: StudioFile;
      try {
        file = await filesApi.get(id);
      } catch (e) {
        void alert(`Could not open the file: ${errorMessage(e)}`); // not awaited, as in openGame
        return;
      }
      this.files.selectedFolder = file.folder;
      this.openFileTab(file, at?.gameIndex ?? 0);
    }
    if (at) {
      this.selectGame(at.gameIndex);
      if (at.ply !== undefined && at.fen) this.jumpToHit(at.fen, at.ply);
      else if (at.ply !== undefined) {
        if (!this.analyse) this.pendingJump = { ply: at.ply };
        else {
          this.analyse.jumpToMain(at.ply);
          this.analyse.redraw();
          this.syncActive();
        }
      }
    }
  }

  private openFileTab(file: StudioFile, gameIndex: number): void {
    const games = splitPgnGames(file.pgn);
    this.openTab({
      title: file.name,
      source: fileSource(file, Math.min(gameIndex, games.length - 1)),
      games,
      current: Math.min(gameIndex, games.length - 1),
      orientation: file.kind === 'repertoire' && file.color ? file.color : (this.params.color ?? 'white'),
    });
  }

  /**
   * Save: to its file when the tab has one, else Save as. Returns false when not saved. Saving again
   * while a save of the tab is on its way waits for it, then saves only what changed since.
   */
  save(askName: () => Promise<SaveAsInput | null>): Promise<boolean> {
    const tab = this.activeTab;
    if (!tab) return Promise.resolve(false);
    return this.saves.run(tab.id, () => this.saveTab(tab, askName), ok => ok && this.hasChanges(tab));
  }

  /** Save as: a new file in My Files (after any save of the tab on its way). */
  saveAs(askName: () => Promise<SaveAsInput | null>): Promise<boolean> {
    const tab = this.activeTab;
    if (!tab) return Promise.resolve(false);
    return this.saves.run(tab.id, () => this.saveTabAs(tab, askName));
  }

  private async saveTab(tab: StudioTab, askName: () => Promise<SaveAsInput | null>): Promise<boolean> {
    if (!this.signedIn) {
      await alert('Sign in to save to My Files.');
      return false;
    }
    if (tab.source.kind !== 'file') return this.saveTabAs(tab, askName);
    if (tab === this.activeTab) this.syncActive();
    const src = tab.source;
    const games = [...tab.games];
    const pgn = joinPgnGames(games);
    try {
      const file = await filesApi.update(src.fileId, { pgn, baseUpdatedAt: src.updatedAt });
      this.onSaved(tab, file, games);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        const overwrite = await confirm(
          `“${src.name}” was changed elsewhere (another tab or device) after you opened it. Overwrite it with this version?`,
          'Overwrite',
          'Cancel',
        );
        if (!overwrite) return false;
        try {
          this.onSaved(tab, await filesApi.update(src.fileId, { pgn }), games);
          return true;
        } catch (e2) {
          await alert(`Could not save: ${errorMessage(e2)}`);
          return false;
        }
      }
      if (e instanceof ApiError && e.isNotFound) {
        await alert(`“${src.name}” no longer exists. Use Save as to keep your work.`);
        tab.source = { kind: 'new' };
        this.tabs.saveTab(tab);
        this.redraw();
        return false;
      }
      await alert(`Could not save: ${errorMessage(e)}`);
      return false;
    }
  }

  private async saveTabAs(tab: StudioTab, askName: () => Promise<SaveAsInput | null>): Promise<boolean> {
    if (!this.signedIn) {
      await alert('Sign in to save to My Files.');
      return false;
    }
    const input = await askName();
    if (!input) return false;
    if (tab === this.activeTab) this.syncActive();
    const games = [...tab.games];
    try {
      const file = await filesApi.create({
        folder: input.folder,
        name: input.name,
        kind: input.kind,
        color: input.kind === 'repertoire' ? input.color : null,
        pgn: joinPgnGames(games),
      });
      tab.source = fileSource(file, tab.current);
      this.onSaved(tab, file, games);
      this.setLocalFolders(this.files.localFolders.filter(f => f !== file.folder));
      this.files.selectedFolder = file.folder;
      return true;
    } catch (e) {
      await alert(`Could not save: ${errorMessage(e)}`);
      return false;
    }
  }

  /** After a save: the file's version and name, and the games as sent become the saved state. */
  private onSaved(tab: StudioTab, file: StudioFile, games: readonly string[]): void {
    if (tab.source.kind === 'file') {
      tab.source.updatedAt = file.updatedAt;
      tab.source.name = file.name;
      tab.source.folder = file.folder;
      tab.source.fileKind = file.kind;
      tab.source.color = file.color;
    }
    tab.title = file.name;
    markSaved(tab, games);
    this.tabs.saveTab(tab);
    this.checkDirty();
    this.syncUrl();
    void this.refreshFiles();
  }

  /**
   * Renames or moves a file and updates its open tabs. The PUT carries the newest version this page
   * knows as `baseUpdatedAt`, so on success the tabs based on that version may follow the new one
   * (`applyFileMeta`) while a tab based on an older version keeps its base: its next save still meets
   * the conflict with what was saved elsewhere. When even that version is stale (409), the rename
   * goes through anyway, since names don't conflict with content, and no tab's base moves.
   */
  async updateFileMeta(file: StudioFileMeta, change: { name?: string; folder?: string }): Promise<void> {
    const base = knownUpdatedAt(this.tabs.tabs, file.id, file.updatedAt);
    try {
      let checkedAt: EpochMs | null = base;
      let updated: StudioFile;
      try {
        updated = await filesApi.update(file.id, { ...change, baseUpdatedAt: base });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'conflict')) throw e;
        updated = await filesApi.update(file.id, change);
        checkedAt = null;
      }
      for (const t of applyFileMeta(this.tabs.tabs, updated, checkedAt)) this.tabs.saveTab(t);
      this.redraw();
      await this.refreshFiles();
    } catch (e) {
      await alert(`Could not update “${file.name}”: ${errorMessage(e)}`);
    }
  }

  /** Recycle bin: soft delete; open tabs keep the game as an unsaved copy. */
  async deleteFile(file: StudioFileMeta): Promise<void> {
    if (!(await confirm(`Move “${file.name}” to the recycle bin?`, 'Delete', 'Cancel'))) return;
    try {
      await filesApi.remove(file.id);
      for (const t of this.tabs.tabs)
        if (t.source.kind === 'file' && t.source.fileId === file.id) {
          t.source = { kind: 'new' };
          t.baseline = t.games.map(() => ''); // differs from every game: an unsaved copy
          this.tabs.saveTab(t);
        }
      this.checkDirty();
      await this.refreshFiles();
    } catch (e) {
      await alert(`Could not delete “${file.name}”: ${errorMessage(e)}`);
    }
  }

  async restoreFile(file: StudioFileMeta): Promise<void> {
    try {
      await filesApi.restore(file.id);
      await this.refreshFiles();
      await this.loadTrash();
    } catch (e) {
      await alert(`Could not restore “${file.name}”: ${errorMessage(e)}`);
    }
  }

  async purgeFile(file: StudioFileMeta): Promise<void> {
    if (!(await confirm(`Delete “${file.name}” for good? This cannot be undone.`, 'Delete for good', 'Cancel'))) return;
    try {
      await filesApi.remove(file.id);
      await this.refreshFiles();
      await this.loadTrash();
    } catch (e) {
      await alert(`Could not delete “${file.name}”: ${errorMessage(e)}`);
    }
  }

  /** Finds the board's position in My Files (`/api/files/search`). */
  async searchPosition(): Promise<void> {
    const fen = this.analyse?.node.fen;
    if (!fen || !this.signedIn) return;
    this.files.search = { fen, status: 'loading' };
    this.redraw();
    try {
      const result = await filesApi.search(fen);
      if (this.files.search?.fen === fen) this.files.search = { fen, status: 'ready', result };
    } catch (e) {
      if (this.files.search?.fen === fen) this.files.search = { fen, status: 'error', error: errorMessage(e) };
    }
    this.redraw();
  }

  // -------------------------------------------------------------------------
  // Annotations (comments and glyphs on the current move)
  // -------------------------------------------------------------------------

  get node(): TreeNode | undefined {
    return this.analyse?.node;
  }

  /** The current move's comment (lila trees may hold several; Studio edits them as one). */
  commentText(node: TreeNode | undefined = this.node): string {
    return (node?.comments ?? [])
      .filter(c => !c.comp)
      .map(c => c.text)
      .join(' ');
  }

  setComment(text: string): void {
    const a = this.analyse;
    if (!a) return;
    const path = a.path;
    for (const c of a.node.comments ?? []) if (!c.comp && c.id !== pgnCommentId) a.tree.deleteCommentAt(c.id, path);
    const clean = text.trim();
    if (clean) a.tree.setCommentAt({ id: pgnCommentId, by: '', text: clean }, path);
    else a.tree.deleteCommentAt(pgnCommentId, path);
    a.redraw();
    this.checkDirty();
  }

  hasGlyph(id: number): boolean {
    return !!this.node?.glyphs?.some(g => g.id === id && !g.comp);
  }

  toggleGlyph(id: number): void {
    const a = this.analyse;
    if (!a || !a.node.san) return;
    const group = GLYPH_GROUPS.find(g => g.ids.includes(id));
    const current = (a.node.glyphs ?? []).filter(g => !g.comp);
    let next: Glyph[];
    if (current.some(g => g.id === id)) next = current.filter(g => g.id !== id);
    else {
      const glyph = glyphOfNag(id);
      if (!glyph) return;
      next = [...current.filter(g => !(group?.exclusive && group.ids.includes(g.id))), glyph];
    }
    a.tree.setGlyphsAt(sortGlyphs(next), a.path);
    a.setAutoShapes();
    a.redraw();
    this.checkDirty();
    this.redraw();
  }
}

function fileSource(file: StudioFile, gameIndex: number): TabSource {
  return {
    kind: 'file',
    fileId: file.id,
    name: file.name,
    folder: file.folder,
    fileKind: file.kind,
    color: file.color,
    updatedAt: file.updatedAt,
    gameIndex,
  };
}

function pickStudioPrefs(p: Partial<StudioPrefs>): Partial<StudioPrefs> {
  const out: Partial<StudioPrefs> = {};
  if (p.theme) out.theme = p.theme;
  if (p.boardTheme) out.boardTheme = p.boardTheme;
  if (p.pieceSet) out.pieceSet = p.pieceSet;
  if (p.soundSet) out.soundSet = p.soundSet;
  if (p.studioLayout) out.studioLayout = p.studioLayout;
  return out;
}
