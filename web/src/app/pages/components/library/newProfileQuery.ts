/**
 * Links into the new-profile form with accounts pre-selected (search results, database players,
 * reference players): `/profiles/new?lichess=a&chesscom=b&fide=1503014&db=4&player=Carlsen,%20M&name=…`.
 * `lichess`, `chesscom` and `fide` may repeat; `db`/`player` pairs are matched by position.
 */
import type { Id, NewSourceInput } from '@outpost/shared/api';
import { withQuery } from '@outpost/shared/filters';
import { paths } from '../../../paths.ts';

/** A source picked in the UI, with a label for display (e.g. the reference player's name). */
export interface PickedSource extends NewSourceInput {
  /** What to show; defaults to `key`. */
  label?: string;
}

/** Query of the new-profile page for these sources (and an optional display name). */
export function newProfileHref(sources: readonly PickedSource[], name?: string): string {
  const q = new URLSearchParams();
  for (const s of sources) {
    if (s.kind === 'pgn') {
      if (s.databaseId === undefined) continue;
      q.append('db', String(s.databaseId));
      q.append('player', s.key);
    } else q.append(s.kind, s.key);
    // one fideName per fide (empty when unnamed), so they pair up by position
    if (s.kind === 'fide') q.append('fideName', s.label ?? '');
  }
  if (name) q.set('name', name);
  return withQuery(paths.newProfile, q);
}

const USERNAME_RE = /^[A-Za-z0-9_-]{1,50}$/;
const FIDE_RE = /^\d{1,12}$/;

/** Sources and display name from the new-profile query; invalid entries are dropped. */
export function parseNewProfileQuery(params: URLSearchParams): { sources: PickedSource[]; name: string | null } {
  const sources: PickedSource[] = [];
  for (const kind of ['lichess', 'chesscom'] as const)
    for (const key of params.getAll(kind)) if (USERNAME_RE.test(key.trim())) sources.push({ kind, key: key.trim() });
  const fideNames = params.getAll('fideName');
  params.getAll('fide').forEach((key, i) => {
    if (FIDE_RE.test(key.trim())) sources.push({ kind: 'fide', key: key.trim(), label: fideNames[i] || undefined });
  });
  const players = params.getAll('player');
  params.getAll('db').forEach((db, i) => {
    const id: Id = Number(db);
    const player = players[i]?.trim();
    if (Number.isSafeInteger(id) && id > 0 && player) sources.push({ kind: 'pgn', key: player, databaseId: id });
  });
  return { sources: dedupeSources(sources), name: params.get('name')?.trim() || null };
}

/** Identity of a source for duplicate checks (usernames are case-insensitive). */
export const sourceIdentity = (s: NewSourceInput): string =>
  s.kind === 'pgn' ? `pgn:${s.databaseId}:${s.key.trim().toLowerCase()}` : `${s.kind}:${s.key.trim().toLowerCase()}`;

/** Removes repeated sources, keeping the first. */
export function dedupeSources<T extends NewSourceInput>(sources: readonly T[]): T[] {
  const seen = new Set<string>();
  return sources.filter(s => {
    const id = sourceIdentity(s);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
