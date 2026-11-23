/**
 * Country codes as the stats endpoints return them: ISO 3166-1 alpha-2 (`XK` for Kosovo), the
 * form the world map draws and `FlagEmoji` renders. `players_cache.country` is written by the geo
 * lookups (jobs), which already map most site codes; this is the last line of defence for older
 * rows and for codes the sites add later.
 */

/**
 * Chess.com's user-assigned codes (England, Scotland, Wales; Canary Islands, Basque Country,
 * Catalonia, Galicia; Palestine) and the common `UK` mistake, mapped to the country they lie in.
 */
const ALIASES: Readonly<Record<string, string>> = {
  XE: 'GB',
  XS: 'GB',
  XW: 'GB',
  UK: 'GB',
  XA: 'ES',
  XB: 'ES',
  XC: 'ES',
  XG: 'ES',
  XP: 'PS',
};

/**
 * A stored country → ISO 3166-1 alpha-2, or null when it is not a country a map can draw:
 * subdivisions (`GB-ENG`, Lichess flags) become their country; Lichess's non-country flags
 * (`_earth`, `_pirate`, `EU`, `UN`, …), the remaining user-assigned codes (`AA`, `Q?`, `X?`
 * except `XK`, `ZZ`) and anything malformed become null.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let c = raw.trim().toUpperCase();
  const sub = /^([A-Z]{2})-[A-Z0-9]{1,4}$/.exec(c);
  if (sub) c = sub[1]!;
  c = ALIASES[c] ?? c;
  if (!/^[A-Z]{2}$/.test(c)) return null;
  if (c === 'EU' || c === 'UN' || c === 'ZZ' || c === 'AA' || /^Q[M-Z]$/.test(c)) return null;
  if (c.startsWith('X') && c !== 'XK') return null;
  return c;
}
