/**
 * Bulk seeding for the stats performance test: one profile with ~100k synthetic games shaped like
 * production rows. A pool of template games goes through `insertGame` (so `games`, `positions`
 * and the opening classification are real); the bulk is cloned from them in SQL with varied
 * dates, results, ratings, opponents and time classes. Deterministic (seeded PRNG).
 */
import { Chess } from 'chessops/chess';
import { makeSanAndPlay } from 'chessops/san';
import { parseStdUci } from '@outpost/shared/chess';
import type { Id, TimeClass } from '@outpost/shared/api';
import { getOpeningBook } from '../src/chess/openings.ts';
import { insertGame } from '../src/chess/store.ts';
import type { Db } from '../src/db/index.ts';
import { createSource, testGame } from './helpers.ts';

/** Mulberry32: small deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A book line continued with random legal moves to `plies` (SAN), stopping at mate/stalemate. */
function randomGame(rand: () => number, line: readonly string[], plies: number): string[] {
  const pos = Chess.default();
  const sans: string[] = [];
  for (const uci of line.slice(0, plies)) {
    const move = parseStdUci(pos, uci);
    if (!move) break;
    sans.push(makeSanAndPlay(pos, move));
  }
  while (sans.length < plies && !pos.isEnd()) {
    const moves = [...pos.allDests()].flatMap(([from, ds]) => [...ds].map(to => ({ from, to })));
    const m = moves[Math.floor(rand() * moves.length)]!;
    const promotes = pos.board.pawn.has(m.from) && (m.to >> 3 === 7 || m.to >> 3 === 0);
    sans.push(makeSanAndPlay(pos, promotes ? { ...m, promotion: 'queen' } : m));
  }
  return sans;
}

export interface SeededProfile {
  profileId: Id;
  slug: string;
  sourceIds: Id[];
  games: number;
  /** Seconds spent seeding. */
  seconds: number;
}

const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'blitz', 'blitz', 'rapid', 'rapid', 'classical', 'correspondence'];
const TERMS = ['resign', 'resign', 'resign', 'mate', 'timeout', 'timeout', 'abandon', 'agreement', 'repetition', 'stalemate', 'insufficient', 'timeout_vs_insufficient'];
const COUNTRIES = ['US', 'IN', 'RU', 'DE', 'FR', 'GB', 'ES', 'BR', 'NO', 'NL', 'PL', 'UA', 'TR', 'IR', 'CN', 'AR', 'XE', 'GB-SCT', null];

/**
 * Seeds `total` games for a new public profile `slug` with a lichess and a chesscom source,
 * owned by `ownerUserId`, over ~8 years ending at `end`.
 */
export function seedLargeProfile(
  db: Db,
  opts: { slug: string; ownerUserId: Id; total: number; templates?: number; opponents?: number; end?: number; seed?: number },
): SeededProfile {
  const started = performance.now();
  const rand = prng(opts.seed ?? 42);
  const end = opts.end ?? Date.UTC(2026, 10, 1);
  const span = 8 * 365 * 86_400_000;
  const now = Date.now();
  const lichess = createSource(db, { kind: 'lichess', key: `${opts.slug}-li` });
  const chesscom = createSource(db, { kind: 'chesscom', key: `${opts.slug}-cc` });
  const profileId = db.run(
    `INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, 'public', ?, ?)`,
    [opts.slug, `Perf ${opts.slug}`, opts.ownerUserId, now, now],
  ).lastInsertRowid;
  db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?), (?, ?)', [profileId, lichess, profileId, chesscom]);

  // Templates: real games (positions + classification) between two throwaway names.
  const entries = [...getOpeningBook().byEpd.values()];
  const templates: Id[] = [];
  db.tx(() => {
    for (let i = 0; i < (opts.templates ?? 400); i++) {
      const entry = entries[Math.floor(rand() * entries.length)]!;
      const plies = 20 + Math.floor(rand() * 90);
      const moves = randomGame(rand, entry.line, plies);
      if (moves.length === 0) continue;
      templates.push(
        insertGame(
          db,
          testGame({ origin: 'pgn', originId: `${opts.slug}-tpl-${i}`, white: { name: 'tpl-w' }, black: { name: 'tpl-b' }, moves }),
        ).gameId,
      );
    }
  });

  const oppCount = opts.opponents ?? 6000;
  const titles = ['GM', 'IM', 'FM', 'CM', 'NM', 'WGM', 'LM', 'BOT'];
  db.tx(() => {
    const cache = db.raw.prepare('INSERT OR IGNORE INTO players_cache (kind, key, country, title, name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let o = 0; o < oppCount; o++) {
      for (const kind of ['lichess', 'chesscom']) {
        const r = rand();
        if (r < 0.15) continue; // never looked up
        const title = rand() < 0.04 ? titles[Math.floor(rand() * titles.length)]! : null;
        cache.run(kind, `opp${o}`, r < 0.2 ? null : COUNTRIES[Math.floor(rand() * COUNTRIES.length)] ?? null, title, `Opp${o}`, r < 0.2 ? null : now);
      }
    }

    const tpl = db.raw.prepare(
      `SELECT ply_count, moves_san, eco, opening_name, opening_ply FROM games WHERE id = ?`,
    );
    const insGame = db.raw.prepare(
      `INSERT INTO games (origin, origin_id, url, white, black, white_key, black_key, white_rating, black_rating,
         white_title, black_title, result, termination, time_class, time_control, rated, event, started_at, ended_at,
         ply_count, moves_san, eco, opening_name, opening_ply, accuracy_white, accuracy_black)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insPos = db.raw.prepare('INSERT INTO positions (game_id, ply, pos_key, next_uci) SELECT ?, ply, pos_key, next_uci FROM positions WHERE game_id = ?');
    const insPg = db.raw.prepare(
      `INSERT INTO player_games (source_id, game_id, color, outcome, rating, rating_after, opp_name, opp_key, opp_rating,
         opp_title, opp_source_kind, ended_at, time_class, rated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ratings = new Map<string, number>();
    for (let i = 0; i < opts.total; i++) {
      const t = templates[Math.floor(rand() * templates.length)]!;
      const g = tpl.get(t) as { ply_count: number; moves_san: string; eco: string | null; opening_name: string | null; opening_ply: number | null };
      const site = rand() < 0.6 ? 'lichess' : 'chesscom';
      const sourceId = site === 'lichess' ? lichess : chesscom;
      const me = site === 'lichess' ? `${opts.slug}-li` : `${opts.slug}-cc`;
      const tc = TIME_CLASSES[Math.floor(rand() * TIME_CLASSES.length)]!;
      const rk = `${site}:${tc}`;
      const rating = ratings.get(rk) ?? 1500 + Math.floor(rand() * 400);
      const outcome = rand() < 0.48 ? 'w' : rand() < 0.15 ? 'd' : 'l';
      const after = rating + (outcome === 'w' ? 8 : outcome === 'l' ? -8 : 0);
      ratings.set(rk, after);
      const white = rand() < 0.5;
      const oppIdx = Math.floor(oppCount * rand() ** 2.5);
      const opp = `opp${oppIdx}`;
      const oppRating = rating + Math.floor((rand() - 0.5) * 600);
      const oppTitle = oppIdx % 97 === 0 ? 'GM' : oppIdx % 53 === 0 ? 'IM' : null;
      // Mostly evenings, spread over the years.
      const day = Math.floor(rand() * (span / 86_400_000));
      const hour = Math.min(23, Math.max(0, Math.round(19 + (rand() - 0.5) * 14)));
      const ended = end - span + day * 86_400_000 + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
      const result = outcome === 'd' ? '1/2-1/2' : (outcome === 'w') === white ? '1-0' : '0-1';
      const rated = rand() < 0.9 ? 1 : 0;
      const term = outcome === 'd' ? TERMS[7 + Math.floor(rand() * 5)]! : TERMS[Math.floor(rand() * 7)]!;
      const r = insGame.run(
        site,
        `${opts.slug}-${i}`,
        white ? me : opp,
        white ? opp : me,
        white ? me : opp,
        white ? opp : me,
        white ? rating : oppRating,
        white ? oppRating : rating,
        white ? null : oppTitle,
        white ? oppTitle : null,
        result,
        term,
        tc,
        '180+2',
        rated,
        rand() < 0.05 ? 'Titled Arena' : null,
        ended - 600_000,
        ended,
        g.ply_count,
        g.moves_san,
        g.eco,
        g.opening_name,
        g.opening_ply,
        null,
        null,
      );
      const gameId = Number(r.lastInsertRowid);
      insPos.run(gameId, t);
      insPg.run(sourceId, gameId, white ? 'w' : 'b', outcome, rating, after, `Opp${oppIdx}`, opp, oppRating, oppTitle, site, ended, tc, rated);
    }
  });
  return { profileId, slug: opts.slug, sourceIds: [lichess, chesscom], games: opts.total, seconds: (performance.now() - started) / 1000 };
}
