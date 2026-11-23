import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_USERNAME_RE,
  API_ROUTES,
  explorerEndpoint,
  fromExplorerGameId,
  SLUG_RE,
  slugify,
  toExplorerGameId,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '../src/api.ts';

describe('API_ROUTES', () => {
  it('builds encoded paths', () => {
    expect(API_ROUTES.profile('magnus carlsen')).toBe('/api/profiles/magnus%20carlsen');
    expect(API_ROUTES.stats.gamesPgn('m')).toBe('/api/profiles/m/games.pgn');
    expect(API_ROUTES.broadcastRoundPgn('abcd1234')).toBe('/api/broadcasts/round/abcd1234.pgn');
    expect(API_ROUTES.broadcastGamePgn('abcd1234', 'efgh5678')).toBe('/api/broadcasts/round/abcd1234/game/efgh5678.pgn');
    expect(API_ROUTES.stats.events('m')).toBe('/api/profiles/m/events');
    expect(API_ROUTES.explorer.playerFiltered('Y29sb3I9d2hpdGU')).toBe('/api/explorer/f/Y29sb3I9d2hpdGU/player');
  });

  it('builds an absolute explorer endpoint that lila can resolve ./<db> against', () => {
    const plain = explorerEndpoint('https://chess.example.com');
    expect(plain).toBe('https://chess.example.com/api/explorer/');
    expect(new URL('./player', plain).href).toBe('https://chess.example.com/api/explorer/player');
    const filtered = explorerEndpoint('http://localhost:5173', 'Y29sb3I9d2hpdGU');
    expect(new URL('./masters', filtered).href).toBe('http://localhost:5173/api/explorer/f/Y29sb3I9d2hpdGU/masters');
    expect(explorerEndpoint('http://localhost:5173', '_')).toBe('http://localhost:5173/api/explorer/f/_/');
  });

  it('passes Fastify placeholders through, so the server can derive route patterns', () => {
    expect(API_ROUTES.profileSource(':slug', ':sourceId')).toBe('/api/profiles/:slug/sources/:sourceId');
    expect(API_ROUTES.admin.jobRetry(':id')).toBe('/api/admin/jobs/:id/retry');
  });
});

describe('account policy', () => {
  it('keeps the username pattern and its length bounds in step', () => {
    for (let n = 1; n <= USERNAME_MAX_LENGTH + 1; n++) {
      const ok = n >= USERNAME_MIN_LENGTH && n <= USERNAME_MAX_LENGTH;
      expect(ACCOUNT_USERNAME_RE.test('a'.repeat(n)), String(n)).toBe(ok);
    }
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
