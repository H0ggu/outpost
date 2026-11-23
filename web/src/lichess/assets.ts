/**
 * URLs and DOM hooks for the vendored Lichess assets in web/public/lichess (see NOTICE.md).
 * Used by the SPA (settings, boards, sounds) and the Studio page alike.
 */
import {
  BOARD_THEMES,
  PIECE_SETS,
  SOUND_SETS,
  type BoardTheme,
  type PieceSet,
  type SoundSet,
  type ThemeName,
} from '@outpost/shared/api';

export { BOARD_THEMES, PIECE_SETS, SOUND_SETS };

/** Public URL prefix of the vendored assets. */
export const LICHESS_ASSETS = '/lichess';

/** Board image file names and coordinate colours (lila ui/lib/css/theme/board/_boards.scss). */
export const BOARD_FILES: Readonly<Record<BoardTheme, { ext: 'png' | 'jpg'; label: string }>> = {
  brown: { ext: 'png', label: 'Brown' },
  blue: { ext: 'png', label: 'Blue' },
  green: { ext: 'png', label: 'Green' },
  purple: { ext: 'png', label: 'Purple' },
  ic: { ext: 'png', label: 'IC' },
  wood4: { ext: 'jpg', label: 'Wood' },
  maple: { ext: 'jpg', label: 'Maple' },
  olive: { ext: 'jpg', label: 'Olive' },
  grey: { ext: 'jpg', label: 'Grey' },
  blue3: { ext: 'jpg', label: 'Blue 3' },
};

/** Full-size board image. */
export const boardImageUrl = (theme: BoardTheme): string => `${LICHESS_ASSETS}/board/${theme}.${BOARD_FILES[theme].ext}`;

/** Small preview for a picker. */
export const boardThumbnailUrl = (theme: BoardTheme): string =>
  `${LICHESS_ASSETS}/board/${theme}.thumbnail.${BOARD_FILES[theme].ext}`;

/** chessground piece roles. */
export const PIECE_ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as const;
/** chessground piece role. */
export type PieceRole = (typeof PIECE_ROLES)[number];

const ROLE_LETTER: Readonly<Record<PieceRole, string>> = {
  pawn: 'P',
  knight: 'N',
  bishop: 'B',
  rook: 'R',
  queen: 'Q',
  king: 'K',
};

/** SVG of one piece, e.g. `/lichess/piece/merida/wN.svg`. */
export const pieceUrl = (set: PieceSet, color: 'white' | 'black', role: PieceRole): string =>
  `${LICHESS_ASSETS}/piece/${set}/${color === 'white' ? 'w' : 'b'}${ROLE_LETTER[role]}.svg`;

/**
 * Selects a piece set the way lila does: sets `---white-pawn` … `---black-king` on `el`
 * (default <body>); board.css maps them onto `.is2d` pieces.
 */
export function applyPieceSet(set: PieceSet, el: HTMLElement = document.body): void {
  for (const color of ['white', 'black'] as const)
    for (const role of PIECE_ROLES) el.style.setProperty(`---${color}-${role}`, `url('${pieceUrl(set, color, role)}')`);
}

/** Selects a board theme: `<body data-board=...>` (lila's convention, also read by the Studio CSS). */
export function applyBoardTheme(theme: BoardTheme, el: HTMLElement = document.body): void {
  el.dataset.board = theme;
}

const THEME_KEY = 'outpost.theme';

/** Selects the site theme (`<html data-theme>`) and remembers it for public/theme-init.js. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#ebe6e0' : theme === 'dark' ? '#161512' : '#000000';
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage unavailable
  }
}

/** The theme saved in this browser, if any. */
export function storedTheme(): ThemeName | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'black' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}

/** Sounds vendored for each free set. */
export const SOUND_NAMES = ['Move', 'Capture', 'Check', 'GenericNotify'] as const;
/** Sound name. */
export type SoundName = (typeof SOUND_NAMES)[number];

/** MP3 URL of a sound, or null for the `silent` set. */
export const soundUrl = (set: SoundSet, name: SoundName): string | null =>
  set === 'silent' ? null : `${LICHESS_ASSETS}/sound/${set}/${name}.mp3`;

/** Plays a sound (ignores autoplay rejections). */
export function playSound(set: SoundSet, name: SoundName, volume = 0.7): void {
  const url = soundUrl(set, name);
  if (!url) return;
  const audio = new Audio(url);
  audio.volume = volume;
  audio.play().catch(() => undefined);
}
