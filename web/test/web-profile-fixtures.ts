/**
 * Synthetic API fixtures for the profile pages (no real players' data): a deterministic set of
 * games for a made-up player with a Lichess and a Chess.com account, and every stats response
 * derived from it, typed by the contract. `mockApi(url, init)` answers like the server would;
 * the component tests plug it into `fetch`, and the browser check into Playwright routes.
 */
import { Chess } from 'chessops/chess';
import { makeSanAndPlay } from 'chessops/san';
import type {
  ActivityCell,
  ActivityDay,
  ActivityStats,
  BehaviourRow,
  BehaviourStats,
  DatabasesResponse,
  GameResponse,
  GameRow,
  GamesPage,
  OpeningRow,
  OpeningsResponse,
  OpponentRow,
  OpponentsPage,
  OverviewStats,
  ProfileHeader,
  ProfileStatus,
  RatingSeries,
  RatingStats,
  SearchResults,
  SessionInfo,
  SourceSummary,
  Termination,
  TerminationRow,
  TimeClass,
  Title,
  WorldMapCountry,
  WorldMapStats,
} from '@outpost/shared/api';
import { DEFAULT_PREFS } from '@outpost/shared/api';
import { parseStdUci, type Color, type Outcome } from '@outpost/shared/chess';
import { parseFilters, resolveDateRange, type ProfileFilters } from '@outpost/shared/filters';

const DAY = 86_400_000;
/** Fixed "now" so every run produces the same data: 2026-11-20 12:00 UTC. */
export const FIXTURE_NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPENINGS: ReadonlyArray<{ eco: string; name: string; line: string; color: Color }> = [
  { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation', line: 'e2e4,c7c5,g1f3,d7d6,d2d4,c5d4,f3d4,g8f6,b1c3,a7a6', color: 'black' },
  { eco: 'C65', name: 'Ruy Lopez: Berlin Defense', line: 'e2e4,e7e5,g1f3,b8c6,f1b5,g8f6', color: 'white' },
  { eco: 'D37', name: "Queen's Gambit Declined", line: 'd2d4,d7d5,c2c4,e7e6,b1c3,g8f6,g1f3,f8e7', color: 'white' },
  { eco: 'E60', name: "King's Indian Defense", line: 'd2d4,g8f6,c2c4,g7g6', color: 'black' },
  { eco: 'A04', name: 'Zukertort Opening: Sicilian Invitation', line: 'g1f3,c7c5', color: 'white' },
  { eco: 'B12', name: 'Caro-Kann Defense: Advance Variation', line: 'e2e4,c7c6,d2d4,d7d5,e4e5', color: 'black' },
  { eco: 'C50', name: 'Italian Game', line: 'e2e4,e7e5,g1f3,b8c6,f1c4', color: 'white' },
  { eco: 'A45', name: 'Indian Defense', line: 'd2d4,g8f6', color: 'black' },
];

const COUNTRIES = ['US', 'NO', 'IN', 'DE', 'FR', 'RU', 'BR', 'ES', 'GB', 'NL', 'PL', 'AR', 'SG', 'MT', 'XK', 'CN', 'UA', 'AM'];
const TITLES: Array<Title | null> = ['GM', 'IM', 'FM', null, null, null, null, null, 'CM', null, null, 'WGM', null, null];
const TERMS_WIN: Termination[] = ['resign', 'resign', 'resign', 'mate', 'timeout', 'abandon'];
const TERMS_DRAW: Termination[] = ['agreement', 'repetition', 'stalemate', 'insufficient', 'timeout_vs_insufficient'];

export const LICHESS_ID = 11;
export const CHESSCOM_ID = 12;

interface Opp {
  name: string;
  key: string;
  title: Title | null;
  country: string | null;
  base: number;
}

const OPPONENTS: Opp[] = Array.from({ length: 70 }, (_, i) => {
  const r = rng(1000 + i);
  return {
    name: `Opponent${String(i + 1).padStart(2, '0')}`,
    key: `opponent${String(i + 1).padStart(2, '0')}`,
    title: TITLES[i % TITLES.length] ?? null,
    country: i % 9 === 8 ? null : COUNTRIES[Math.floor(r() * COUNTRIES.length)]!,
    base: 2300 + Math.round(r() * 500),
  };
});

/** A fixture game with what the generators need. */
interface FGame extends GameRow {
  line: string;
}

function makeGames(count: number): FGame[] {
  const r = rng(42);
  const games: FGame[] = [];
  const rating: Record<string, number> = {};
  // Oldest first, so ratings evolve in time order.
  const times = Array.from({ length: count }, () => FIXTURE_NOW - Math.floor(Math.pow(r(), 1.6) * 400) * DAY - Math.floor(r() * DAY)).sort((a, b) => a - b);
  for (let i = 0; i < count; i++) {
    const endedAt = times[i]!;
    const tcRoll = r();
    const timeClass: TimeClass = tcRoll < 0.25 ? 'bullet' : tcRoll < 0.72 ? 'blitz' : tcRoll < 0.93 ? 'rapid' : 'classical';
    const sourceId = r() < 0.6 ? LICHESS_ID : CHESSCOM_ID;
    const key = `${sourceId}:${timeClass}`;
    const mine = (rating[key] ??= 2650 + Math.round(r() * 150));
    const opp = OPPONENTS[Math.floor(Math.pow(r(), 1.8) * OPPONENTS.length)]!;
    const oppRating = mine - 250 + Math.round(r() * 400) + Math.round((opp.base - 2550) / 5);
    const exp = 1 / (1 + Math.pow(10, (oppRating - mine) / 400));
    const roll = r();
    const outcome: Outcome = roll < exp * 0.85 ? 'w' : roll < exp * 0.85 + 0.15 ? 'd' : 'l';
    const color: Color = r() < 0.5 ? 'white' : 'black';
    const repertoire = OPENINGS.filter(o => o.color === color);
    const opening = repertoire[Math.floor(Math.pow(r(), 1.4) * repertoire.length)]!;
    const delta = Math.round(10 * ((outcome === 'w' ? 1 : outcome === 'd' ? 0.5 : 0) - exp));
    rating[key] = mine + delta;
    const result = outcome === 'd' ? '1/2-1/2' : (outcome === 'w') === (color === 'white') ? '1-0' : '0-1';
    const termination: Termination = outcome === 'd' ? TERMS_DRAW[Math.floor(r() * TERMS_DRAW.length)]! : TERMS_WIN[Math.floor(r() * TERMS_WIN.length)]!;
    games.push({
      id: 1000 + i,
      origin: sourceId === LICHESS_ID ? 'lichess' : 'chesscom',
      url: sourceId === LICHESS_ID ? `https://lichess.org/fx${1000 + i}` : `https://www.chess.com/game/live/${1000 + i}`,
      sourceId,
      color,
      outcome,
      result,
      termination,
      timeClass,
      timeControl: timeClass === 'bullet' ? '60+0' : timeClass === 'blitz' ? '180+2' : timeClass === 'rapid' ? '600+0' : '1800+20',
      rated: r() < 0.92,
      startedAt: endedAt - 600_000,
      endedAt,
      rating: mine,
      ratingAfter: mine + delta,
      opponent: { name: opp.name, key: opp.key, rating: oppRating, title: opp.title, kind: sourceId === LICHESS_ID ? 'lichess' : 'chesscom', country: opp.country },
      plies: 40 + Math.floor(r() * 80),
      eco: opening.eco,
      openingName: opening.name,
      accuracy: r() < 0.5 ? Math.round(700 + r() * 290) / 10 : null,
      event: r() < 0.1 ? 'Titled Arena' : null,
      line: opening.line,
    });
  }
  return games.sort((a, b) => b.endedAt! - a.endedAt!);
}

export const ALL_GAMES: readonly FGame[] = makeGames(900);

// ---------------------------------------------------------------------------
// Filtering (enough of the server's semantics for the UI)
// ---------------------------------------------------------------------------

export function filterGames(f: ProfileFilters, games: readonly FGame[] = ALL_GAMES): FGame[] {
  const { from, to } = resolveDateRange(f, FIXTURE_NOW);
  return games.filter(g => {
    if (f.color && g.color !== f.color) return false;
    if (from !== null && g.endedAt! < from) return false;
    if (to !== null && g.endedAt! > to) return false;
    if (f.tc?.length && !f.tc.includes(g.timeClass)) return false;
    if (f.src?.length && !f.src.includes(g.sourceId)) return false;
    if (f.rated && (f.rated === 'rated') !== g.rated) return false;
    if (f.outcome?.length && !f.outcome.includes(g.outcome)) return false;
    if (f.oppName && !g.opponent.name.toLowerCase().includes(f.oppName.toLowerCase())) return false;
    if (f.event && !(g.event ?? '').toLowerCase().includes(f.event.toLowerCase())) return false;
    if (f.line?.length && !g.line.startsWith(f.line.join(','))) return false;
    if (f.opp && g.rating !== null && g.opponent.rating !== null) {
      const diff = g.opponent.rating - g.rating;
      if (f.opp === '-200' && diff > -200) return false;
      if (f.opp === '-100' && diff > -100) return false;
      if (f.opp === 'eq' && Math.abs(diff) > 100) return false;
      if (f.opp === '100' && diff < 100) return false;
      if (f.opp === '200' && diff < 200) return false;
    }
    return true;
  });
}

const wdl = (games: readonly { outcome: Outcome }[]) => ({
  w: games.filter(g => g.outcome === 'w').length,
  d: games.filter(g => g.outcome === 'd').length,
  l: games.filter(g => g.outcome === 'l').length,
});

const strip = ({ line: _line, ...g }: FGame): GameRow => g;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function profileHeader(over: Partial<ProfileHeader> = {}): ProfileHeader {
  const src = (id: number, kind: 'lichess' | 'chesscom'): SourceSummary => {
    const games = ALL_GAMES.filter(g => g.sourceId === id);
    const tcs = [...new Set(games.map(g => g.timeClass))];
    return {
      id,
      kind,
      key: 'testplayer',
      displayName: kind === 'lichess' ? 'TestPlayer' : 'test_player',
      url: kind === 'lichess' ? 'https://lichess.org/@/testplayer' : 'https://www.chess.com/member/test_player',
      title: 'GM',
      country: 'NO',
      hidden: false,
      databaseId: null,
      gameCount: games.length,
      ratings: tcs.map(tc => {
        const last = games.find(g => g.timeClass === tc)!;
        return { timeClass: tc, rating: last.ratingAfter!, games: games.filter(g => g.timeClass === tc).length, rd: 50, provisional: false };
      }),
      fide: kind === 'lichess' ? { standard: 2790, rapid: null, blitz: null } : null,
      sync: { state: 'idle', lastSyncedAt: FIXTURE_NOW - 3 * 3_600_000, lastError: null, progress: null, queuePosition: null, jobId: null },
    };
  };
  return {
    id: 7,
    slug: 'test-player',
    displayName: 'Test Player',
    visibility: 'public',
    autoRefresh: true,
    owner: { id: 1, username: 'owner' },
    canEdit: true,
    bookmarked: false,
    sources: [src(LICHESS_ID, 'lichess'), src(CHESSCOM_ID, 'chesscom')],
    totals: { ...wdl(ALL_GAMES), games: ALL_GAMES.length },
    lastUpdated: FIXTURE_NOW - 3 * 3_600_000,
    queue: { busy: false, cooldownUntil: null, queuePosition: null },
    views: 12,
    createdAt: FIXTURE_NOW - 500 * DAY,
    ...over,
  };
}

export function profileStatus(h: ProfileHeader = profileHeader()): ProfileStatus {
  return { sources: h.sources.map(s => ({ sourceId: s.id, sync: s.sync, gameCount: s.gameCount })), queue: h.queue, lastUpdated: h.lastUpdated };
}

export function sessionInfo(signedIn = true): SessionInfo {
  return {
    user: signedIn ? { id: 1, username: 'owner', role: 'admin', totpEnabled: false, prefs: { ...DEFAULT_PREFS, timezone: 'utc' } } : null,
    setupRequired: false,
    signupMode: 'closed',
    anonymousBrowsing: true,
    version: '0.1.0',
  };
}

function openingRows(games: readonly FGame[], color: Color, order: string, minGames: number): OpeningRow[] {
  const by = new Map<string, FGame[]>();
  for (const g of games.filter(x => x.color === color)) by.set(g.line, [...(by.get(g.line) ?? []), g]);
  const rows: OpeningRow[] = [...by.entries()].map(([line, gs]) => {
    const o = OPENINGS.find(x => x.line === line)!;
    return { eco: o.eco, name: o.name, line, color, games: gs.length, ...wdl(gs), avgPly: gs.reduce((n, g) => n + g.plies, 0) / gs.length };
  });
  const score = (r: OpeningRow) => (r.w + r.d / 2) / r.games;
  return rows
    .filter(r => r.games >= minGames)
    .sort((a, b) => (order === 'best' ? score(b) - score(a) : order === 'worst' ? score(a) - score(b) : b.games - a.games));
}

export function overview(f: ProfileFilters = {}): OverviewStats {
  const games = filterGames(f);
  const tcs: TimeClass[] = ['bullet', 'blitz', 'rapid', 'classical'];
  const h = profileHeader();
  const terms = new Map<Termination, FGame[]>();
  for (const g of games) terms.set(g.termination, [...(terms.get(g.termination) ?? []), g]);
  const activity: ActivityDay[] = Array.from({ length: 90 }, (_, i) => {
    const day = new Date(FIXTURE_NOW - (89 - i) * DAY).toISOString().slice(0, 10);
    const gs = games.filter(g => new Date(g.endedAt!).toISOString().slice(0, 10) === day);
    const x = wdl(gs);
    return { date: day, games: gs.length, score: gs.length ? (x.w + x.d / 2) / gs.length : null };
  });
  return {
    totals: { ...wdl(games), games: games.length },
    timeClasses: tcs.map(tc => {
      const gs = games.filter(g => g.timeClass === tc);
      return {
        timeClass: tc,
        games: gs.length,
        ...wdl(gs),
        ratings: h.sources.flatMap(s => {
          const r = s.ratings.find(x => x.timeClass === tc);
          return r ? [{ sourceId: s.id, rating: r.rating }] : [];
        }),
      };
    }),
    byColor: {
      white: { ...wdl(games.filter(g => g.color === 'white')), games: games.filter(g => g.color === 'white').length },
      black: { ...wdl(games.filter(g => g.color === 'black')), games: games.filter(g => g.color === 'black').length },
    },
    terminations: [...terms.entries()].map(([termination, gs]): TerminationRow => ({ termination, ...wdl(gs) })),
    topOpenings: { white: openingRows(games, 'white', 'most', 1).slice(0, 5), black: openingRows(games, 'black', 'most', 1).slice(0, 5) },
    latestGames: games.slice(0, 5).map(strip),
    activity,
    ratingSparkline: ratingStats({ ...f, period: '12m' }).series,
  };
}

export function gamesPage(f: ProfileFilters, page = 1, pageSize = 20): GamesPage {
  const games = filterGames(f);
  return { total: games.length, page, pageSize, summary: wdl(games), games: games.slice((page - 1) * pageSize, page * pageSize).map(strip) };
}

export function openings(f: ProfileFilters, q: URLSearchParams): OpeningsResponse {
  const games = filterGames(f);
  const side = q.get('side') ?? 'both';
  const order = q.get('order') ?? 'most';
  const minGames = Number(q.get('minGames') ?? 1);
  return {
    white: side === 'black' ? [] : openingRows(games, 'white', order, minGames),
    black: side === 'white' ? [] : openingRows(games, 'black', order, minGames),
  };
}

export function opponents(f: ProfileFilters, q: URLSearchParams): OpponentsPage {
  const games = filterGames(f);
  const page = Number(q.get('page') ?? 1);
  const pageSize = Number(q.get('pageSize') ?? 20);
  const by = new Map<string, FGame[]>();
  for (const g of games) by.set(g.opponent.key, [...(by.get(g.opponent.key) ?? []), g]);
  let rows: OpponentRow[] = [...by.values()].map(gs => {
    const o = gs[0]!.opponent;
    return {
      key: o.key,
      name: o.name,
      kind: o.kind,
      title: o.title,
      country: o.country,
      games: gs.length,
      ...wdl(gs),
      lastRating: o.rating,
      lastPlayed: gs[0]!.endedAt,
      profileSlug: o.key === 'opponent01' ? 'opponent-one' : null,
    };
  });
  if (q.get('view') === 'titled') rows = rows.filter(r => r.title);
  rows.sort((a, b) => b.games - a.games);
  return { total: rows.length, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize) };
}

export function behaviour(f: ProfileFilters): BehaviourStats {
  const games = filterGames(f);
  const part = (o: Outcome): BehaviourRow[] => {
    const gs = games.filter(g => g.outcome === o);
    const by = new Map<Termination, FGame[]>();
    for (const g of gs) by.set(g.termination, [...(by.get(g.termination) ?? []), g]);
    return [...by.entries()].map(([termination, x]) => ({
      termination,
      count: x.length,
      pct: (x.length * 100) / gs.length,
      avgMoves: x.reduce((n, g) => n + g.plies / 2, 0) / x.length,
    }));
  };
  return { w: part('w'), d: part('d'), l: part('l') };
}

export function worldMap(f: ProfileFilters = {}): WorldMapStats {
  const games = filterGames(f);
  const by = new Map<string, FGame[]>();
  let unknown = 0;
  for (const g of games) {
    if (!g.opponent.country) unknown++;
    else by.set(g.opponent.country, [...(by.get(g.opponent.country) ?? []), g]);
  }
  const countries: WorldMapCountry[] = [...by.entries()].map(([code, gs]) => ({
    code,
    games: gs.length,
    opponents: new Set(gs.map(g => g.opponent.key)).size,
    ...wdl(gs),
  }));
  return { countries, unknownGames: unknown, pendingLookups: 4 };
}

const emptyCell = (): ActivityCell & { pts: number } => ({ games: 0, score: null, pts: 0 });

export function activity(f: ProfileFilters, tz = 'UTC'): ActivityStats {
  const games = filterGames(f);
  const hours = Array.from({ length: 24 }, emptyCell);
  const days = Array.from({ length: 7 }, emptyCell);
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, emptyCell));
  const byDate = new Map<string, { games: number; pts: number }>();
  const add = (c: { games: number; pts: number }, g: FGame) => {
    c.games++;
    c.pts += g.outcome === 'w' ? 1 : g.outcome === 'd' ? 0.5 : 0;
  };
  for (const g of games) {
    const d = new Date(g.endedAt!);
    const h = d.getUTCHours();
    const wd = (d.getUTCDay() + 6) % 7;
    add(hours[h]!, g);
    add(days[wd]!, g);
    add(grid[wd]![h]!, g);
    const iso = d.toISOString().slice(0, 10);
    const c = byDate.get(iso) ?? { games: 0, pts: 0 };
    add(c, g);
    byDate.set(iso, c);
  }
  const fin = (c: { games: number; pts: number }): ActivityCell => ({ games: c.games, score: c.games ? c.pts / c.games : null });
  const dates = [...byDate.keys()].sort();
  const out: ActivityDay[] = [];
  if (dates.length) {
    for (let t = Date.parse(`${dates[0]}T00:00:00Z`); t <= Date.parse(`${dates.at(-1)}T00:00:00Z`); t += DAY) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const c = byDate.get(iso);
      out.push({ date: iso, ...(c ? fin(c) : { games: 0, score: null }) });
    }
  }
  return { tz, days: out, byHour: hours.map(fin), byWeekday: days.map(fin), grid: grid.map(r => r.map(fin)) };
}

export function ratingStats(f: ProfileFilters): RatingStats {
  const games = filterGames(f).filter(g => g.rated);
  const by = new Map<string, FGame[]>();
  for (const g of games) by.set(`${g.sourceId}:${g.timeClass}`, [...(by.get(`${g.sourceId}:${g.timeClass}`) ?? []), g]);
  const series: RatingSeries[] = [...by.entries()].map(([k, gs]) => {
    const [sid, tc] = k.split(':');
    return { sourceId: Number(sid), timeClass: tc as TimeClass, points: [...gs].reverse().map(g => [g.endedAt!, g.ratingAfter!] as [number, number]) };
  });
  const averages = [10, 20, 50, 100, 200, 500, 1000, null].map(n => {
    const gs = n === null ? games : games.slice(0, n);
    const x = wdl(gs);
    return {
      n,
      games: gs.length,
      avgRating: gs.length ? gs.reduce((s, g) => s + g.rating!, 0) / gs.length : null,
      avgOppRating: gs.length ? gs.reduce((s, g) => s + g.opponent.rating!, 0) / gs.length : null,
      score: gs.length ? (x.w + x.d / 2) / gs.length : null,
    };
  });
  return { series, averages };
}

export function gameResponse(id: number): GameResponse | null {
  const g = ALL_GAMES.find(x => x.id === id);
  if (!g) return null;
  const r = rng(id);
  const pos = Chess.default();
  const san: string[] = [];
  for (const uci of g.line.split(',')) {
    const m = parseStdUci(pos, uci)!;
    san.push(makeSanAndPlay(pos, m));
  }
  for (let i = 0; i < 30 && !pos.isEnd(); i++) {
    const moves: Array<{ from: number; to: number; promotion?: 'queen' }> = [];
    for (const [from, dests] of pos.allDests())
      for (const to of dests) {
        const pawn = pos.board.get(from)?.role === 'pawn';
        moves.push(pawn && (to < 8 || to >= 56) ? { from, to, promotion: 'queen' } : { from, to });
      }
    const m = moves[Math.floor(r() * moves.length)]!;
    san.push(makeSanAndPlay(pos, m));
  }
  const movetext = san.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ');
  const me = 'TestPlayer';
  const white = g.color === 'white' ? me : g.opponent.name;
  const black = g.color === 'black' ? me : g.opponent.name;
  const pgn = `[Event "Rated ${g.timeClass} game"]\n[Site "${g.url}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${g.result}"]\n\n${movetext} ${g.result}\n`;
  return {
    game: {
      id: g.id,
      origin: g.origin,
      originId: String(g.id),
      url: g.url,
      databaseId: null,
      white: { name: white, key: white.toLowerCase(), rating: g.color === 'white' ? g.rating : g.opponent.rating, title: null, fideId: null, accuracy: null },
      black: { name: black, key: black.toLowerCase(), rating: g.color === 'black' ? g.rating : g.opponent.rating, title: null, fideId: null, accuracy: null },
      result: g.result,
      termination: g.termination,
      timeClass: g.timeClass,
      timeControl: g.timeControl,
      rated: g.rated,
      event: g.event,
      round: null,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      plies: san.length,
      eco: g.eco,
      openingName: g.openingName,
      openingPly: g.line.split(',').length,
      headers: {},
    },
    pgn,
  };
}

export const searchResults = (q: string): SearchResults => ({
  q,
  profiles: [],
  lichess: [{ kind: 'lichess', username: `${q}_li`, title: null, exists: true, known: false, profileSlug: null }],
  chesscom: [{ kind: 'chesscom', username: `${q}_cc`, title: 'FM', exists: true, known: true, profileSlug: null }],
  reference: [{ fideId: '9990001', name: `${q}, Synthetic`, title: 'IM', federation: 'NOR', games: 42, lastPlayed: FIXTURE_NOW, maxRating: 2450, profileSlug: null }],
});

export const databases = (): DatabasesResponse => ({
  databases: [
    { id: 3, name: 'Club games', kind: 'games', visibility: 'private', owner: { id: 1, username: 'owner' }, sourceLabel: null, licence: null, createdAt: FIXTURE_NOW, gameCount: 120, canEdit: true, importJob: null },
  ],
});

// ---------------------------------------------------------------------------
// The fake server
// ---------------------------------------------------------------------------

/** A JSON (or text) response of the fake API. */
export interface MockResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

/** Hooks a test can use to change answers (header overrides, failures, recorded calls). */
export interface MockOptions {
  header?: Partial<ProfileHeader>;
  signedIn?: boolean;
  /** Paths (regex) that should fail with this response. */
  fail?: Array<{ match: RegExp; status: number; code: string; message: string; details?: unknown }>;
  /** Called with every request. */
  record?: (method: string, url: URL, body: unknown) => void;
}

const json = (body: unknown, status = 200): MockResponse => ({ status, body });
const err = (status: number, code: string, message: string, details?: unknown): MockResponse => ({ status, body: { error: { code, message, details } } });

/** Answers one request like the Outpost server would, from the fixtures. */
export function mockApi(method: string, rawUrl: string, body: unknown, opts: MockOptions = {}): MockResponse {
  const url = new URL(rawUrl, 'http://localhost');
  opts.record?.(method, url, body);
  const path = url.pathname;
  for (const f of opts.fail ?? []) if (f.match.test(`${method} ${path}`)) return err(f.status, f.code, f.message, f.details);
  const f = parseFilters(url.searchParams, 'lenient');
  const header = profileHeader(opts.header);

  if (path === '/api/session') return json(sessionInfo(opts.signedIn ?? true));
  if (path === '/api/me/prefs' && method === 'PUT') return json({ ...DEFAULT_PREFS, ...(body as object) });
  if (path === '/api/search') return json(searchResults(url.searchParams.get('q') ?? ''));
  if (path === '/api/databases') return json(databases());
  if (path === '/api/bookmarks') return json({ profiles: [] });
  if (path === '/api/jobs/mine') return json({ jobs: [] });
  const game = /^\/api\/games\/(\d+)$/.exec(path);
  if (game) {
    const g = gameResponse(Number(game[1]));
    return g ? json(g) : err(404, 'not_found', 'No such game');
  }
  const m = /^\/api\/profiles\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (!m) return err(404, 'not_found', `No route ${path}`);
  const slug = decodeURIComponent(m[1]!);
  const rest = m[2] ?? '';
  if (slug !== header.slug) return err(404, 'not_found', 'Profile not found');

  switch (`${method} ${rest}`) {
    case 'GET ':
      return json(header);
    case 'PATCH ': {
      const b = body as Record<string, unknown>;
      const next = { ...header, ...b } as ProfileHeader;
      if (Array.isArray(b.hiddenSourceIds)) next.sources = header.sources.map(s => ({ ...s, hidden: (b.hiddenSourceIds as number[]).includes(s.id) }));
      return json(next);
    }
    case 'DELETE ':
      return json({ ok: true });
    case 'GET status':
      return json(profileStatus(header));
    case 'POST update':
      return json({ jobs: [], queue: { busy: true, cooldownUntil: null, queuePosition: 2 } });
    case 'PUT bookmark':
      return json({ bookmarked: true });
    case 'DELETE bookmark':
      return json({ bookmarked: false });
    case 'POST sources':
      return json(header);
    case 'GET overview':
      return json(overview(f));
    case 'GET games':
      return json(gamesPage(f, Number(url.searchParams.get('page') ?? 1), Number(url.searchParams.get('pageSize') ?? 20)));
    case 'GET games.pgn':
      return { status: 200, body: '[Event "x"]\n\n1. e4 *\n', contentType: 'application/x-chess-pgn' };
    case 'GET openings':
      return json(openings(f, url.searchParams));
    case 'GET opponents':
      return json(opponents(f, url.searchParams));
    case 'GET behaviour':
      return json(behaviour(f));
    case 'GET worldmap':
      return json(worldMap(f));
    case 'GET activity':
      return json(activity(f, url.searchParams.get('tz') ?? 'UTC'));
    case 'GET rating':
      return json(ratingStats(f));
    default: {
      const src = /^sources\/(\d+)$/.exec(rest);
      if (src && method === 'DELETE') return json({ ...header, sources: header.sources.filter(s => s.id !== Number(src[1])) });
      return err(404, 'not_found', `No route ${method} ${path}`);
    }
  }
}

/** A `fetch` implementation over `mockApi`, for component tests. */
export function mockFetch(opts: MockOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const r = mockApi(method, url, body, opts);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { 'content-type': r.contentType ?? 'application/json' } });
  }) as typeof fetch;
}
