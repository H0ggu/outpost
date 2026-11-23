/**
 * Studio look preferences (PLAN §8.4): site theme (true black by default), board theme, piece set,
 * sound set and layout preset. Signed-in users keep them in `/api/me/prefs` (shared with the SPA);
 * anonymous visitors in this browser's localStorage. lila reads the board and pieces from `<body>`
 * (`data-board`, `---white-pawn` …), the theme from `<html>` (`.light`), sounds from
 * `<body data-sound-set>`.
 */
import {
  API_ROUTES,
  BOARD_THEMES,
  DEFAULT_PREFS,
  PIECE_SETS,
  SOUND_SETS,
  STUDIO_LAYOUTS,
  type UpdatePrefsRequest,
  type UserPrefs,
} from '@outpost/shared/api';
import { api } from '../app/api/client.ts';
import { applyBoardTheme, applyPieceSet, applyTheme, storedTheme } from '../lichess/assets.ts';

/** The prefs the Studio uses. */
export type StudioPrefs = Pick<UserPrefs, 'theme' | 'boardTheme' | 'pieceSet' | 'soundSet' | 'studioLayout'>;

/** localStorage key for anonymous visitors (the theme also goes to `outpost.theme`, see assets.ts). */
export const PREFS_STORAGE_KEY = 'outpost.studio.prefs';

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Validates prefs from storage or the server, filling defaults. */
export function sanitizePrefs(raw: Partial<Record<keyof StudioPrefs, unknown>> | null | undefined): StudioPrefs {
  const r = raw ?? {};
  return {
    theme: pick(['dark', 'black', 'light'] as const, r.theme, DEFAULT_PREFS.theme),
    boardTheme: pick(BOARD_THEMES, r.boardTheme, DEFAULT_PREFS.boardTheme),
    pieceSet: pick(PIECE_SETS, r.pieceSet, DEFAULT_PREFS.pieceSet),
    soundSet: pick(SOUND_SETS, r.soundSet, DEFAULT_PREFS.soundSet),
    studioLayout: pick(STUDIO_LAYOUTS, r.studioLayout, DEFAULT_PREFS.studioLayout),
  };
}

/** Prefs saved in this browser. */
export function localPrefs(): StudioPrefs {
  let saved: Partial<StudioPrefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}') as Partial<StudioPrefs>;
  } catch {
    // unavailable or corrupt: defaults
  }
  return sanitizePrefs({ ...saved, theme: storedTheme() ?? saved.theme });
}

function storeLocal(p: StudioPrefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable
  }
}

/** Applies theme, board, pieces and sound set to the document (before and after lila loads). */
export function applyStudioPrefs(p: StudioPrefs): void {
  applyTheme(p.theme);
  // lila's light theme is `html.light`; dark is its default and true black is Outpost's override.
  document.documentElement.classList.toggle('light', p.theme === 'light');
  document.documentElement.classList.toggle('dark', p.theme !== 'light');
  applyBoardTheme(p.boardTheme);
  applyPieceSet(p.pieceSet);
  document.body.dataset.soundSet = p.soundSet;
  document.body.dataset.studioLayout = p.studioLayout;
  window.site?.sound?.changeSet?.(p.soundSet);
}

/** Saves a change: to the account when signed in (also mirrored locally), else to this browser. */
export async function savePrefs(next: StudioPrefs, change: UpdatePrefsRequest, signedIn: boolean): Promise<void> {
  storeLocal(next);
  if (signedIn) await api.put<UserPrefs>(API_ROUTES.me.prefs, change);
}
