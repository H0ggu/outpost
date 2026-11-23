import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTES, EVENT_SUGGESTIONS_MAX, type EventsResponse } from '@outpost/shared/api';
import { insertGame } from '../src/chess/store.ts';
import { writeSettings } from '../src/settings.ts';
import { eventSuggestions } from '../src/stats/index.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { createProfile, get } from './stats-fixtures.ts';

/** Event-name suggestions (`GET /api/profiles/:slug/events?q=`, decision 35). */
describe('GET /api/profiles/:slug/events', () => {
  let t: TestApp;
  let owner: string;
  let other: string;
  const src: Record<string, number> = {};

  beforeAll(async () => {
    t = await makeTestApp();
    const o = createUserSession(t.db, { username: 'owner' });
    owner = o.cookie;
    other = createUserSession(t.db, { username: 'other' }).cookie;
    src.A = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    src.H = createSource(t.db, { kind: 'lichess', key: 'synthalt' });
    src.Z = createSource(t.db, { kind: 'lichess', key: 'stranger' });
    createProfile(t.db, { slug: 'synth', ownerUserId: o.userId, sources: [{ id: src.A! }, { id: src.H!, hidden: true }] });
    createProfile(t.db, { slug: 'secret', ownerUserId: o.userId, visibility: 'private', sources: [{ id: src.Z! }] });
    let n = 0;
    const game = (event: string | null, white = 'SynthPlayer', black = 'Rival') =>
      insertGame(t.db, testGame({ originId: `ev${n++}`, event, white: { name: white }, black: { name: black } }));
    for (let i = 0; i < 3; i++) game('Titled Arena');
    for (let i = 0; i < 5; i++) game('Rated blitz game');
    game('Club Championship 2026');
    game('club night'); // lower case: still matches "club"
    game('Arena Kings 50%_off'); // LIKE wildcards in the name
    game(null);
    game('');
    // A game between two of the profile's accounts counts once.
    game('Titled Arena', 'SynthPlayer', 'SynthAlt');
    // Hidden account only: the owner sees this event, others don't.
    game('Hidden Swiss', 'SynthAlt', 'Rival');
    // Another profile's game.
    game('Stranger Open', 'Stranger', 'Rival');
  });
  afterAll(async () => t.close());

  const events = async (slug: string, q: string | null, cookie: string | undefined = other) => {
    const res = await get<EventsResponse>(t, `${API_ROUTES.stats.events(slug)}${q === null ? '' : `?q=${encodeURIComponent(q)}`}`, cookie);
    expect(res.status, res.text).toBe(200);
    return res.body.events.map(e => [e.name, e.games]);
  };

  it('lists the most played events of the visible sources without a query', async () => {
    expect(await events('synth', null)).toEqual([
      ['Rated blitz game', 5],
      ['Titled Arena', 4],
      ['Arena Kings 50%_off', 1],
      ['Club Championship 2026', 1],
      ['club night', 1],
    ]);
    expect(await events('synth', '   ')).toEqual(await events('synth', null));
    // The owner also sees the hidden account's events.
    expect((await events('synth', null, owner)).map(e => e[0])).toContain('Hidden Swiss');
  });

  it('matches substrings case-insensitively, prefix matches first', async () => {
    expect(await events('synth', 'arena')).toEqual([
      ['Arena Kings 50%_off', 1],
      ['Titled Arena', 4],
    ]);
    expect(await events('synth', 'CLUB')).toEqual([
      ['Club Championship 2026', 1],
      ['club night', 1],
    ]);
    // LIKE wildcards are literal.
    expect(await events('synth', '50%_')).toEqual([['Arena Kings 50%_off', 1]]);
    expect(await events('synth', '%')).toEqual([['Arena Kings 50%_off', 1]]);
    expect(await events('synth', 'nothing like it')).toEqual([]);
    expect(await events('synth', 'Hidden')).toEqual([]);
  });

  it('caps the list and follows the profile access rules', async () => {
    for (let i = 0; i < EVENT_SUGGESTIONS_MAX + 5; i++) {
      insertGame(t.db, testGame({ originId: `cap${i}`, event: `Weekly ${String(i).padStart(2, '0')}`, white: { name: 'SynthPlayer' } }));
    }
    expect(await events('synth', 'weekly')).toHaveLength(EVENT_SUGGESTIONS_MAX);
    expect(eventSuggestions(t.db, [src.A!], 'weekly', 3).events.map(e => e.name)).toEqual(['Weekly 00', 'Weekly 01', 'Weekly 02']);
    expect((await get(t, API_ROUTES.stats.events('secret'), other)).status).toBe(404);
    expect(await events('secret', null, owner)).toEqual([['Stranger Open', 1]]);
    expect((await get(t, API_ROUTES.stats.events('synth'))).status).toBe(401);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      expect((await get(t, API_ROUTES.stats.events('synth'))).status).toBe(200);
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
    expect((await get(t, `${API_ROUTES.stats.events('synth')}?q=${'x'.repeat(201)}`, other)).status).toBe(400);
  });
});
