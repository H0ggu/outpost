export interface Hovering {
  fen: FEN;
  uci: Uci;
}

export type ExplorerDb = 'lichess' | 'masters' | 'player' | 'reference'; // outpost: + local reference DB
export type ExplorerMode = 'casual' | 'rated';
export type ExplorerSpeed = Speed;

export interface ExplorerOpts {
  endpoint: string;
  tablebaseEndpoint: string;
  showRatings: boolean;
  outpost?: ExplorerOutpost;
}

// Outpost: the "player" database reads an Outpost profile (or account) instead of a Lichess user,
// "reference" is Outpost's local over-the-board database, and games open in Outpost.
export interface ExplorerOutpost {
  playerEndpoint(player: string): string; // absolute base URL for the player db (may carry filters)
  playerLabel(player: string): string; // display name of a player spec
  searchPlayers(term: string): Promise<ExplorerPlayerChoice[]>;
  suggestedPlayers(onLoad?: () => void): ExplorerPlayerChoice[]; // onLoad: they arrived later
  openGame(db: ExplorerDb, id: string, orientation: Color, fen: FEN): void;
  requiresAuth(db: ExplorerDb): boolean; // db needs a signed-in user here
  signInReason?(db: ExplorerDb): string | undefined; // why, when only some databases need one
  loginUrl: string;
  unavailable?(db: ExplorerDb): string | undefined; // why the server can't serve db (e.g. Lichess without a token)
  lastPlayed?(at: number): { text: string; title: string }; // a player move's "last played" cell
}

export interface ExplorerPlayerChoice {
  spec: string;
  label: string;
  hint?: string;
}

export interface ExplorerData {
  fen: FEN;
  moves: MoveStats[];
  isOpening?: true;
  tablebase?: true;
}

export interface OpeningData extends ExplorerData {
  white: number;
  black: number;
  draws: number;
  moves: OpeningMoveStats[];
  topGames?: OpeningGame[];
  recentGames?: OpeningGame[];
  opening?: Opening;
  queuePosition?: number;
}

export interface Opening {
  eco: string;
  name: string;
}

export interface OpeningGame {
  id: string;
  white: OpeningPlayer;
  black: OpeningPlayer;
  winner?: Color;
  year?: string;
  month?: string;
  speed?: Speed;
  mode?: ExplorerMode;
  uci?: string;
}

export interface OpeningPlayer {
  title?: string;
  name: string;
  rating: number;
}

export type TablebaseCategory =
  | 'loss'
  | 'unknown'
  | 'syzygy-loss'
  | 'maybe-loss'
  | 'blessed-loss'
  | 'draw'
  | 'cursed-win'
  | 'maybe-win'
  | 'syzygy-win'
  | 'win';

export interface TablebaseData extends ExplorerData {
  moves: TablebaseMoveStats[];
  dtz?: number;
  dtm?: number;
  dtw?: number;
  dtc?: number;
  checkmate?: boolean;
  stalemate?: boolean;
  variant_win?: boolean;
  variant_loss?: boolean;
  insufficient_material?: boolean;
  category: TablebaseCategory;
}

export interface MoveStats {
  uci: Uci;
  san: San;
}

export interface OpeningMoveStats extends MoveStats {
  white: number;
  black: number;
  draws: number;
  averageRating?: number;
  averageOpponentRating?: number;
  performance?: number;
  game?: OpeningGame;
  opening?: Opening;
  lastPlayed?: number; // outpost: player database, epoch ms
}
export interface TablebaseMoveStats extends MoveStats {
  dtz?: number;
  dtm?: number;
  dtw?: number;
  dtc?: number;
  checkmate?: boolean;
  stalemate?: boolean;
  variant_win?: boolean;
  variant_loss?: boolean;
  insufficient_material?: boolean;
  zeroing?: boolean;
  conversion?: boolean;
  category: TablebaseCategory;
}

export const isOpening = (m: ExplorerData): m is OpeningData => !!m.isOpening;

export const isTablebase = (m: ExplorerData): m is TablebaseData => !!m.tablebase;

export type SimpleTablebaseHit = {
  fen: FEN;
  best?: Uci; // no move if checkmate/stalemate
  winner?: Color;
};
