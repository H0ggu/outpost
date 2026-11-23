/**
 * Fake upstream for the profiles module's tests (search, profiles): a fetch that answers from a
 * route table and records every call. Data is synthetic (made-up Lichess users) or hikaru-only
 * (Chess.com), never a private individual's.
 *
 *   const up = fakeUpstream({ 'GET lichess.org/api/user/alice': () => json(lichessUser('alice')) });
 *   const t = await makeTestApp({ fetch: up.fetch });
 *   expect(up.calls).toEqual(['GET lichess.org/api/user/alice']);
 */

/** A route handler: gets the URL and init, returns a Response (or throws to simulate a network error). */
export type FakeRoute = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** JSON response helper. */
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A 200 response that sends its headers and the start of a JSON body, then stalls forever (a hung
 * upstream). Cancelling the body (or aborting `signal`) ends the stream.
 */
export function stalledJson(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"username":'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Fake fetch: routes are keyed `METHOD host/path` (no query). Unknown routes answer 404. */
export function fakeUpstream(routes: Record<string, FakeRoute> = {}): {
  fetch: typeof globalThis.fetch;
  calls: string[];
  routes: Record<string, FakeRoute>;
  /** User-Agent / Authorization of each call. */
  headers: Headers[];
} {
  const calls: string[] = [];
  const headers: Headers[] = [];
  const table = { ...routes };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init.method ?? 'GET'} ${url.host}${url.pathname}`;
    calls.push(key);
    headers.push(new Headers(init.headers));
    const route = table[key];
    if (!route) return json({ error: 'not found' }, 404);
    return route(url, init);
  };
  return { fetch, calls, routes: table, headers };
}

/** A synthetic Lichess `GET /api/user/{u}` object. */
export function lichessUser(
  username: string,
  over: { title?: string; flag?: string; disabled?: boolean; fideRating?: number; blitz?: number; bulletGames?: number } = {},
): Record<string, unknown> {
  return {
    id: username.toLowerCase(),
    username,
    ...(over.title ? { title: over.title } : {}),
    ...(over.disabled ? { disabled: true } : {}),
    createdAt: 1_600_000_000_000,
    seenAt: 1_700_000_000_000,
    perfs: {
      bullet: { games: over.bulletGames ?? 0, rating: 1500, rd: 350, prog: 0, prov: true },
      blitz: { games: 120, rating: over.blitz ?? 1873, rd: 61, prog: 12 },
      rapid: { games: 3, rating: 1640, rd: 140, prog: 0, prov: true },
      puzzle: { games: 50, rating: 2000, rd: 80, prog: 0 },
    },
    profile: { ...(over.flag ? { flag: over.flag } : {}), ...(over.fideRating ? { fideRating: over.fideRating } : {}) },
  };
}

/** hikaru's Chess.com `/pub/player/hikaru` (shape from the research notes, numbers made up). */
export const HIKARU_PLAYER = {
  player_id: 15448422,
  '@id': 'https://api.chess.com/pub/player/hikaru',
  url: 'https://www.chess.com/member/Hikaru',
  name: 'Hikaru Nakamura',
  username: 'hikaru',
  title: 'GM',
  followers: 1000000,
  country: 'https://api.chess.com/pub/country/US',
  last_online: 1_763_000_000,
  joined: 1_389_000_000,
  status: 'premium',
  is_streamer: true,
  verified: true,
  league: 'Legend',
};

/** hikaru's Chess.com `/stats` (made-up numbers). */
export const HIKARU_STATS = {
  chess_blitz: { last: { rating: 3300, date: 1_763_000_000, rd: 30 }, best: { rating: 3400, date: 1_700_000_000 }, record: { win: 10, loss: 2, draw: 3 } },
  chess_bullet: { last: { rating: 3250, date: 1_763_000_000, rd: 35 }, record: { win: 5, loss: 1, draw: 0 } },
  fide: 2800,
  tactics: { highest: { rating: 3000, date: 1 }, lowest: { rating: 500, date: 1 } },
  puzzle_rush: [],
};

/** Routes for hikaru on Chess.com. */
export const hikaruRoutes = (): Record<string, FakeRoute> => ({
  'GET api.chess.com/pub/player/hikaru': () => json(HIKARU_PLAYER),
  'GET api.chess.com/pub/player/hikaru/stats': () => json(HIKARU_STATS),
});

/** A network failure. */
export const networkDown: FakeRoute = () => {
  throw new TypeError('fetch failed');
};
