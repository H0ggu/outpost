/**
 * World map (`GET /api/profiles/:slug/worldmap`, PLAN §5 "World Map"): games and opponents per
 * opponent country, from `players_cache` (filled by the geo lookups of the jobs module).
 *
 * - `countries`: ISO 3166-1 alpha-2 codes (`normalizeCountry`), most games first.
 * - `unknownGames`: games whose opponent has no known country — not looked up yet, no flag set,
 *   or a PGN / FIDE opponent without a cached country.
 * - `pendingLookups`: Lichess / Chess.com opponents still waiting for a lookup: no cache row yet,
 *   or a row queued for (re)lookup (`fetched_at` NULL). PGN and FIDE names are never looked up.
 */
import type { WorldMapCountry, WorldMapStats } from '@outpost/shared/api';
import { scopeWhere, wdlColumns, type StatsScope } from './common.ts';

/** Chess.com's user-assigned codes for the UK nations, which the map draws as GB. */
const ALIASES: Readonly<Record<string, string>> = { XE: 'GB', XS: 'GB', XW: 'GB', UK: 'GB' };

/**
 * A stored country → ISO 3166-1 alpha-2 (`XK` for Kosovo), or null when it is not a country the
 * map can draw: subdivisions (`GB-ENG`) become their country; Lichess's non-country flags
 * (`_earth`, `EU`, `UN`, …) and the remaining user-assigned `X?` codes become null.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let c = raw.trim().toUpperCase();
  const sub = /^([A-Z]{2})-[A-Z0-9]{1,3}$/.exec(c);
  if (sub) c = sub[1]!;
  c = ALIASES[c] ?? c;
  if (!/^[A-Z]{2}$/.test(c)) return null;
  if (c === 'EU' || c === 'UN' || c === 'ZZ' || c === 'AA' || /^Q[M-Z]$/.test(c)) return null;
  if (c.startsWith('X') && c !== 'XK') return null;
  return c;
}

interface CountryRecord {
  country: string | null;
  pending: number;
  opponents: number;
  games: number;
  w: number;
  d: number;
  l: number;
}

/** World-map stats of a scope. */
export function worldMapStats(scope: StatsScope): WorldMapStats {
  const where = scopeWhere(scope);
  // Group per opponent first, so the cache is looked up once per opponent rather than per game.
  const rows = scope.db.all<CountryRecord>(
    `WITH o AS (
        SELECT pg.opp_source_kind AS kind, pg.opp_key AS key, COUNT(*) AS games, ${wdlColumns()}
          FROM player_games pg
         WHERE ${where.sql}
         GROUP BY pg.opp_source_kind, pg.opp_key)
      SELECT pc.country AS country,
             (o.kind IN ('lichess', 'chesscom') AND pc.fetched_at IS NULL) AS pending,
             COUNT(*) AS opponents, SUM(o.games) AS games, SUM(o.w) AS w, SUM(o.d) AS d, SUM(o.l) AS l
        FROM o LEFT JOIN players_cache pc ON pc.kind = o.kind AND pc.key = o.key
       GROUP BY 1, 2`,
    where.params,
  );
  const countries = new Map<string, WorldMapCountry>();
  let unknownGames = 0;
  let pendingLookups = 0;
  for (const r of rows) {
    if (r.pending) pendingLookups += r.opponents;
    const code = normalizeCountry(r.country);
    if (code === null) {
      unknownGames += r.games;
      continue;
    }
    let c = countries.get(code);
    if (!c) {
      c = { code, games: 0, opponents: 0, w: 0, d: 0, l: 0 };
      countries.set(code, c);
    }
    c.games += r.games;
    c.opponents += r.opponents;
    c.w += r.w;
    c.d += r.d;
    c.l += r.l;
  }
  return {
    countries: [...countries.values()].sort((a, b) => b.games - a.games || b.opponents - a.opponents || a.code.localeCompare(b.code)),
    unknownGames,
    pendingLookups,
  };
}
