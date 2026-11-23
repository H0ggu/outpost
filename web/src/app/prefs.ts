/**
 * Applies the user's look preferences to the document: theme (<html data-theme>), board theme
 * (<body data-board>) and piece set (CSS variables on <body>). Anonymous visitors get the
 * defaults, with the theme remembered per browser.
 */
import { useEffect, useMemo } from 'react';
import { DEFAULT_PREFS, type SessionInfo, type UserPrefs } from '@outpost/shared/api';
import { applyBoardTheme, applyPieceSet, applyTheme, storedTheme } from '../lichess/assets.ts';

/** Prefs to use now: the signed-in user's, else defaults with the browser's stored theme. */
export function effectivePrefs(session: SessionInfo | undefined): UserPrefs {
  if (session?.user) return session.user.prefs;
  return { ...DEFAULT_PREFS, theme: storedTheme() ?? DEFAULT_PREFS.theme };
}

/** Applies theme, board and pieces to the DOM. */
export function applyPrefs(p: Pick<UserPrefs, 'theme' | 'boardTheme' | 'pieceSet'>): void {
  applyTheme(p.theme);
  applyBoardTheme(p.boardTheme);
  applyPieceSet(p.pieceSet);
}

/** Keeps the DOM in sync with the session's prefs; returns the effective prefs. */
export function usePrefs(session: SessionInfo | undefined): UserPrefs {
  const prefs = useMemo(() => effectivePrefs(session), [session]);
  useEffect(() => {
    applyPrefs(prefs);
  }, [prefs.theme, prefs.boardTheme, prefs.pieceSet]);
  return prefs;
}
