import { describe, expect, it } from 'vitest';
import { API_ROUTES, fromExplorerGameId, SLUG_RE, slugify, toExplorerGameId } from '../src/api.ts';

describe('API_ROUTES', () => {
  it('builds encoded paths', () => {
    expect(API_ROUTES.profile('magnus carlsen')).toBe('/api/profiles/magnus%20carlsen');
    expect(API_ROUTES.stats.gamesPgn('m')).toBe('/api/profiles/m/games.pgn');
    expect(API_ROUTES.broadcastRoundPgn('abcd1234')).toBe('/api/broadcasts/round/abcd1234.pgn');
    expect(API_ROUTES.explorer.playerFiltered('Y29sb3I9d2hpdGU')).toBe('/api/explorer/f/Y29sb3I9d2hpdGU/player');
  });

  it('passes Fastify placeholders through, so the server can derive route patterns', () => {
    expect(API_ROUTES.profileSource(':slug', ':sourceId')).toBe('/api/profiles/:slug/sources/:sourceId');
    expect(API_ROUTES.admin.jobRetry(':id')).toBe('/api/admin/jobs/:id/retry');
  });
});

describe('helpers', () => {
  it('slugifies display names', () => {
    expect(slugify('Magnus Carlsen')).toBe('magnus-carlsen');
    expect(slugify('  Ørjan Ç. Ålesund!! ')).toBe('orjan-c-alesund');
    expect(slugify('X')).toBe('player-x');
    expect(SLUG_RE.test(slugify('Ding Liren (CHN)'))).toBe(true);
  });

  it('prefixes explorer game ids', () => {
    expect(toExplorerGameId(123)).toBe('op123');
    expect(fromExplorerGameId('op123')).toBe(123);
    expect(fromExplorerGameId('abcdEFGH')).toBeNull();
    expect(fromExplorerGameId('op0')).toBeNull();
  });
});
