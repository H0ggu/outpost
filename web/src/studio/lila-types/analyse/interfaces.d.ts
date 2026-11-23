/**
 * Hand-written declarations for the parts of lila's analyse app that Studio touches
 * (web/vendor/lila/analyse/src/interfaces.ts, ctrl.ts, explorer/*, lib/src/tree/*), as loosely as is
 * safe. Never type-checked against the vendored sources (PLAN §1): keep them in step with the pinned
 * commit and scripts/lila-patches by hand.
 */
import type { VNode } from 'snabbdom';
import type { Api as ChessgroundApi } from '@lichess-org/chessground/api';
import type { DrawShape } from '@lichess-org/chessground/draw';

export type TreePath = string;

export interface TreeComment {
  id: string;
  by: string | { id: string; name: string };
  text: string;
  comp?: boolean;
}

export interface Glyph {
  id: number;
  symbol: string;
  name: string;
  comp?: boolean;
}

/** A drawn arrow or circle stored on a node (lila studies store the brush too). */
export interface Shape {
  orig: Key;
  dest?: Key;
  brush?: string;
}

/** Evaluation stored on a node by the server or a PGN `[%eval]`. */
export interface ServerEval {
  cp?: number;
  mate?: number;
  fen: string;
  knodes: number;
  depth: number;
  pvs: Array<{ moves: string; cp?: number; mate?: number }>;
  best?: string;
}

/** A local or cloud engine evaluation. */
export interface ClientEval {
  cp?: number;
  mate?: number;
  fen: string;
  depth: number;
  cloud?: boolean;
}

export interface TreeNode {
  id: string;
  ply: number;
  fen: string;
  uci?: string;
  san?: string;
  children: TreeNode[];
  comments?: TreeComment[];
  glyphs?: Glyph[];
  shapes?: Shape[];
  clock?: number;
  eval?: ServerEval;
  ceval?: ClientEval;
  comp?: boolean;
  forceVariation?: boolean;
}

/** `lib/tree/tree.ts` TreeWrapper (subset). */
export interface TreeWrapper {
  root: TreeNode;
  lastPly(): number;
  nodeAtPath(path: TreePath): TreeNode;
  getNodeList(path: TreePath): TreeNode[];
  pathExists(path: TreePath): boolean;
  pathIsMainline(path: TreePath): boolean;
  setCommentAt(comment: TreeComment, path: TreePath): TreeNode | undefined;
  deleteCommentAt(id: string, path: TreePath): TreeNode | undefined;
  setGlyphsAt(glyphs: Glyph[], path: TreePath): TreeNode | undefined;
  setShapes(shapes: Shape[], path: TreePath): TreeNode | undefined;
}

export interface StatusLike {
  id: number;
  name: string;
}

export interface AnalyseGame {
  id: string;
  fen: string;
  initialFen?: string;
  player: Color;
  turns: number;
  status: StatusLike;
  winner?: Color;
  variant: { key: VariantKey; name: string; short: string };
  opening?: { eco: string; name: string; ply: number };
}

/** `AnalysePref` (enums from lib/prefs.ts: Coords 0 hidden, 1 inside, 2 outside, 3 all; MoveEvent 0 click, 1 drag, 2 both). */
export interface AnalysePref {
  coords: number;
  is3d?: boolean;
  showDests?: boolean;
  rookCastle?: boolean;
  destination?: boolean;
  highlight?: boolean;
  showCaptured?: boolean;
  animationDuration?: number;
  keyboardMove: boolean;
  moveEvent: number;
}

export interface AnalyseData {
  game: AnalyseGame;
  player: { color: Color };
  opponent: { color: Color };
  orientation: Color;
  takebackable: boolean;
  moretimeable: boolean;
  userAnalysis: boolean;
  treeParts: TreeNode[];
  sidelines?: TreeNode[][];
  pref: AnalysePref;
}

export type ExplorerDb = 'lichess' | 'masters' | 'player' | 'reference';

export interface ExplorerPlayerChoice {
  spec: string;
  label: string;
  hint?: string;
}

/** scripts/lila-patches/002: Outpost's player and reference databases. */
export interface ExplorerOutpost {
  playerEndpoint(player: string): string;
  playerLabel(player: string): string;
  searchPlayers(term: string): Promise<ExplorerPlayerChoice[]>;
  /** `onLoad` (the player dialog's redraw) runs once suggestions that were still loading arrive. */
  suggestedPlayers(onLoad?: () => void): ExplorerPlayerChoice[];
  openGame(db: ExplorerDb, id: string, orientation: Color, fen: string): void;
  /** `db` needs a signed-in user (lila then shows its sign-in view instead of asking the server). */
  requiresAuth(db: ExplorerDb): boolean;
  /** The sign-in view's explanation for `db`, when only some databases need a session. */
  signInReason?(db: ExplorerDb): string | undefined;
  loginUrl: string;
  /** Why the server can't serve `db` (the Lichess database without an API token), if it can't. */
  unavailable?(db: ExplorerDb): string | undefined;
  /** The player database's "last played" cell for a move last played at `at` (epoch ms). */
  lastPlayed?(at: number): { text: string; title: string };
  /** "All N games" under the player database's recent games: list every game at the position. */
  showGames?(req: ExplorerGamesRequest): void;
  /** True: the player database's bars show the player's wins / draws / losses (green / grey / red). */
  playerPerspective?(): boolean;
}

/** scripts/lila-patches/002: what "All N games" asks for (as lila asked the player explorer). */
export interface ExplorerGamesRequest {
  player: string;
  color: Color;
  rootFen: string;
  play: string[];
  fen: string;
  speeds: string[];
  modes: string[];
  since: string;
  until: string;
  total: number;
}

export interface ExplorerOpts {
  endpoint: string;
  tablebaseEndpoint: string;
  showRatings: boolean;
  outpost?: ExplorerOutpost;
}

/** scripts/lila-patches/001: what lila delegates to Outpost instead of its server. */
export interface OutpostHooks {
  changeFen(fen: string): void;
  keyboardHelpHtml(): string;
}

export type AnalyseSocketSend = (type: string, data?: unknown) => void;

export interface AnalyseOpts {
  element?: HTMLElement;
  data: AnalyseData;
  userId?: string;
  hunter: boolean;
  explorer: ExplorerOpts;
  socketSend: AnalyseSocketSend;
  $side?: Cash;
  wiki?: boolean;
  inlinePgn?: string;
  externalEngineEndpoint: string;
  embed?: boolean;
  outpost?: OutpostHooks;
}

/** What `makeStart(patch)(opts)` returns. */
export interface AnalyseApi {
  socketReceive(type: string, data: unknown): boolean;
  path(): TreePath;
  setChapter(id: string): void;
}

interface StoredProp<V> {
  (replacement?: V): V;
}

/** `explorer/explorerCtrl.ts` (subset). */
export interface ExplorerCtrl {
  allowed(v?: boolean): boolean;
  enabled(v?: boolean): boolean;
  toggle(): void;
  reload(): void;
  db(): ExplorerDb;
  /** The data shown for the current node (opening data has `isOpening`; `games` from Outpost's player explorer). */
  current(): { fen: string; isOpening?: true; white?: number; draws?: number; black?: number; games?: number } | undefined;
  config: {
    data: {
      open(v?: boolean): boolean;
      db: StoredProp<ExplorerDb>;
      color: StoredProp<Color>;
      playerName: { value: StoredProp<string> };
    };
    selectPlayer(name?: string): void;
  };
}

/** `ctrl.ts` AnalyseCtrl (subset Studio uses). Reachable as `site.analysis` after mount. */
export interface AnalyseCtrl {
  opts: AnalyseOpts;
  data: AnalyseData;
  tree: TreeWrapper;
  path: TreePath;
  node: TreeNode;
  nodeList: TreeNode[];
  mainline: TreeNode[];
  synthetic: boolean;
  /** Board turned relative to `data.orientation`. */
  flipped: boolean;
  pgnError?: string;
  chessground?: ChessgroundApi;
  explorer: ExplorerCtrl;
  redraw(): void;
  jump(path: TreePath): void;
  userJump(path: TreePath): void;
  jumpToMain(ply: number): void;
  mainlinePlyToPath(ply: number): TreePath;
  changePgn(pgn: string, andReload: boolean): AnalyseData | undefined;
  reloadData(data: AnalyseData, merge: boolean): void;
  flip(): void;
  bottomColor(): Color;
  toggleExplorer(): void;
  setAutoShapes(): void;
  cevalEnabled(enable?: boolean): boolean | 'force';
  isCevalAllowed(): boolean;
  showComments: boolean;
  actionMenu(v?: boolean): boolean;
}

export type { VNode, DrawShape };
