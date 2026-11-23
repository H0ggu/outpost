/**
 * Links out of the profile pages: Studio game analysis, the embedded explorer and the
 * click-through from an opening line to the Explorer tab.
 */
import { toExplorerGameId, type Color } from '@outpost/shared/api';
import { encodeFiltersSegment, withQuery, type ProfileFilters } from '@outpost/shared/filters';
import { paths } from '../../paths.ts';
import { lineToSanMoves, numberedSan } from './format.ts';

/** Studio analysis of an Outpost game: `/studio?game=op<id>` (the explorer's game id form). */
export const studioGameLink = (id: number): string => withQuery(paths.studio(), { game: toExplorerGameId(id) });

/**
 * Studio URL for the profile's player explorer. When the filters hold a line, the line is also
 * passed as `pgn` (numbered SAN) so the board opens on that position.
 */
export function studioExplorerLink(slug: string, color: Color, filters: ProfileFilters, embed: boolean): string {
  const san = filters.line?.length ? lineToSanMoves(filters.line) : null;
  return paths.studio({
    explorer: `player:${slug}`,
    color,
    filters: encodeFiltersSegment(filters),
    ...(san?.length ? { pgn: numberedSan(san) } : {}),
    ...(embed ? { embed: 'explorer' as const } : {}),
  });
}

/** The Explorer tab at a line, as the given colour, keeping the other filters. */
export const explorerTabAt = (slug: string, filters: ProfileFilters, color: Color, line: readonly string[]): string =>
  paths.profile(slug, 'explorer', { ...filters, color, line: [...line] });
