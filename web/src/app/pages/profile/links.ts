/**
 * Links out of the profile pages: Studio game analysis, the embedded explorer, the
 * click-through from an opening line to the Explorer tab and a new profile for an opponent.
 */
import { toExplorerGameId, type Color, type SourceKind } from '@outpost/shared/api';
import { encodeFiltersSegment, withQuery, type ProfileFilters } from '@outpost/shared/filters';
import { paths } from '../../paths.ts';
import { newProfileHref } from '../components/library/newProfileQuery.ts';
import { lineToSanMoves, numberedSan } from './format.ts';

/**
 * Studio analysis of an Outpost game: `/studio?game=op<id>` (the explorer's game id form), with the
 * board turned to the profile player's side (`color`) when known.
 */
export const studioGameLink = (id: number, color?: Color): string =>
  withQuery(paths.studio(), { game: toExplorerGameId(id), color });

/**
 * Studio URL for the profile's player explorer with the other filters. A `line` filter becomes
 * the board's moves (`pgn`, numbered SAN) instead of an explorer restriction: the explorer
 * already reads the position on the board, and keeping the line as a filter would hide every
 * other game once the viewer steps back from it. An illegal line is dropped.
 */
export function studioExplorerLink(slug: string, color: Color, filters: ProfileFilters, embed: boolean): string {
  const { line, ...rest } = filters;
  const san = line?.length ? lineToSanMoves(line) : null;
  return paths.studio({
    explorer: `player:${slug}`,
    color,
    filters: encodeFiltersSegment(rest),
    ...(san?.length ? { pgn: numberedSan(san) } : {}),
    ...(embed ? { embed: 'explorer' as const } : {}),
  });
}

/** The Explorer tab at a line, as the given colour, keeping the other filters. */
export const explorerTabAt = (slug: string, filters: ProfileFilters, color: Color, line: readonly string[]): string =>
  paths.profile(slug, 'explorer', { ...filters, color, line: [...line] });

/**
 * The new-profile form with an opponent's account picked (`/profiles/new?lichess=…&name=…`), for
 * scouting someone Outpost has no profile of yet. Lichess and Chess.com opponents are known by
 * username, reference-game opponents by FIDE id; a PGN opponent is only a name, so it has none.
 */
export function newProfileForOpponent(opponent: { kind: SourceKind; key: string; name: string }): string | null {
  const { kind, key, name } = opponent;
  if (kind === 'pgn' || !key) return null;
  if (kind === 'fide') return newProfileHref([{ kind, key, label: name }], name);
  // The username as the site writes it (the key is its lowercase form).
  return newProfileHref([{ kind, key: name.toLowerCase() === key.toLowerCase() ? name : key }], name);
}
