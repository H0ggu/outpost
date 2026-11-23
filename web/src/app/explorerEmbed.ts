/**
 * Messages between the Studio embedded in the profile Explorer tab (`/studio?embed=explorer`) and
 * that page (same origin, `postMessage`): the Studio says where its board is and what the player
 * explorer counted there, so the page's links follow the board; its "All N games" asks the page
 * to show them (the Games tab at that line). The page checks the sender (its own iframe, its own
 * origin) and reads messages only through `readEmbedMessage`.
 */
import type { Color } from '@outpost/shared/api';
import { isUci } from '@outpost/shared/chess';
import { MAX_LINE_PLIES } from '@outpost/shared/filters';

/** The board moved (or the explorer counted its games): where the embed's explorer is. */
export interface EmbedPositionMessage {
  type: 'outpost:position';
  /** The player spec the explorer reads. */
  player: string;
  color: Color;
  /** The board's moves as a `line` filter, or null when they can't be one (Studio `lineFilterOf`). */
  line: string[] | null;
  /** The board's position. */
  fen: string;
  /** The explorer's count of games at the position, when known. */
  games: number | null;
}

/** "All N games" in the embed: the page shows them (its Games tab at this line). */
export interface EmbedShowGamesMessage {
  type: 'outpost:show-games';
  player: string;
  color: Color;
  line: string[];
}

export type EmbedMessage = EmbedPositionMessage | EmbedShowGamesMessage;

/** Reads a message the embed posted; null for anything else. */
export function readEmbedMessage(data: unknown): EmbedMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Partial<Record<string, unknown>>;
  const color = m.color === 'white' || m.color === 'black' ? m.color : null;
  if (typeof m.player !== 'string' || !color) return null;
  const line =
    Array.isArray(m.line) && m.line.length <= MAX_LINE_PLIES && m.line.every(u => typeof u === 'string' && isUci(u))
      ? (m.line as string[])
      : null;
  if (m.type === 'outpost:position' && typeof m.fen === 'string' && m.fen.length <= 120)
    return {
      type: 'outpost:position',
      player: m.player,
      color,
      line,
      fen: m.fen,
      games: typeof m.games === 'number' && Number.isSafeInteger(m.games) && m.games >= 0 ? m.games : null,
    };
  if (m.type === 'outpost:show-games' && line) return { type: 'outpost:show-games', player: m.player, color, line };
  return null;
}
