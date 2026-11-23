/**
 * `sources.profile_json`: the last upstream profile/stats snapshot of a Lichess or Chess.com
 * source, written by the sync handler (lichess.ts / chesscom.ts) and read by the profile header
 * (current ratings per time class, FIDE ratings, account state).
 *
 * Read it with `parseSourceProfile(row.profile_json)` (or `readSourceProfile(db, id)`), never by
 * poking at the JSON: the shape is versioned (`v`).
 */
import type { EpochMs, Id, TimeClass, Title } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { upsertPlayerCache } from './common.ts';

/** A current site rating in one time class. */
export interface SourceProfileRating {
  timeClass: Exclude<TimeClass, 'unknown'>;
  rating: number;
  /** Glicko RD when the site reports it. */
  rd: number | null;
  /** The site marks the rating provisional (Lichess `prov`; Chess.com has no flag → false). */
  provisional: boolean;
  /** Rated games in this class on the site, when reported. */
  games: number | null;
  /** Best rating in this class, when reported (Chess.com `best`). */
  best: number | null;
}

/** Snapshot stored in `sources.profile_json` (version 1). */
export interface SourceProfileSnapshot {
  v: 1;
  site: 'lichess' | 'chesscom';
  fetchedAt: EpochMs;
  /** Username in display case. */
  username: string;
  /** Lichess user id / Chess.com `player_id`. */
  userId: string | null;
  /** Link to the account on its site. */
  url: string;
  title: Title | null;
  /** ISO 3166-1 alpha-2 (XK for Kosovo), or null. */
  country: string | null;
  /** The flag / country code as the site wrote it (Lichess `GB-SCT`, Chess.com `XS`). */
  countryRaw: string | null;
  /** Account creation. */
  createdAt: EpochMs | null;
  /** Last seen online. */
  seenAt: EpochMs | null;
  /** The account is closed (Lichess `disabled`, Chess.com status `closed…`). */
  closed: boolean;
  /** Marked for a terms/fair-play violation (Lichess `tosViolation`, Chess.com `closed:fair_play_violations`). */
  violation: boolean;
  /** Standard-chess ratings per time class (ultraBullet is in `extraRatings`). */
  ratings: SourceProfileRating[];
  /** Other site ratings by site key, e.g. Lichess `ultraBullet`. */
  extraRatings: Record<string, { rating: number; rd: number | null; provisional: boolean; games: number | null }>;
  /** FIDE ratings when the site knows them (Lichess profile `fideRating`, Chess.com stats `fide`). */
  fide: { standard: number | null; rapid: number | null; blitz: number | null } | null;
  /** Game counts reported by the site (all variants included). */
  counts: { all: number | null; rated: number | null } | null;
}

/** Parses `sources.profile_json`; null when empty, malformed or of an unknown version. */
export function parseSourceProfile(json: string | null | undefined): SourceProfileSnapshot | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<SourceProfileSnapshot> | null;
    return v && typeof v === 'object' && v.v === 1 && Array.isArray(v.ratings) ? (v as SourceProfileSnapshot) : null;
  } catch {
    return null;
  }
}

/** The snapshot of a source, or null. */
export function readSourceProfile(db: Db, sourceId: Id): SourceProfileSnapshot | null {
  return parseSourceProfile(db.value<string | null>('SELECT profile_json FROM sources WHERE id = ?', [sourceId]));
}

/** A positive integer rating, or null. */
export const ratingValue = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

/**
 * Writes a fresh snapshot: the source's display name, site user id, title, country and
 * `profile_json`, plus the player's own `players_cache` row (so other profiles that played this
 * account see its country and title without another lookup).
 */
export function storeSourceProfile(
  db: Db,
  src: { id: Id; kind: string; key: string },
  snap: SourceProfileSnapshot,
  now: EpochMs,
): void {
  db.tx(() => {
    db.run('UPDATE sources SET display_name = ?, site_user_id = ?, title = ?, country = ?, profile_json = ? WHERE id = ?', [
      snap.username,
      snap.userId,
      snap.title,
      snap.country,
      JSON.stringify(snap),
      src.id,
    ]);
    if (src.kind === 'lichess' || src.kind === 'chesscom') {
      upsertPlayerCache(db, src.kind, src.key, { country: snap.country, title: snap.title, name: snap.username }, now);
    }
  });
}
