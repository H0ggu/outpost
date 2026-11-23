/**
 * Rows of the unified search (PLAN §5: local profiles, Lichess, Chess.com, reference players),
 * shared by the search page, the new-profile account picker and the prep opponent picker. Each
 * caller supplies the actions on the right of a row.
 */
import type { ReactNode } from 'react';
import type { ExternalHitRating, ExternalPlayerHit, ReferencePlayer, SearchResults } from '@outpost/shared/api';
import { Button, FlagEmoji, licon, TIME_CLASS_LABELS, TimeClassIcon } from '../../../components/index.ts';
import { formatDate, plural, SOURCE_KIND_LABELS, timeAgo } from './format.ts';
import type { PickedSource } from './newProfileQuery.ts';

/** The source to create for an external hit. */
export const externalSource = (h: ExternalPlayerHit): PickedSource => ({ kind: h.kind, key: h.username });

/** The FIDE source for a reference player (null without a FIDE id). */
export const referenceSource = (p: ReferencePlayer): PickedSource | null =>
  p.fideId ? { kind: 'fide', key: p.fideId, label: p.name } : null;

/** A section of results with a heading, a count and an "unavailable" notice. */
export function HitSection({
  title,
  count,
  unavailable,
  onRetry,
  empty,
  children,
}: {
  title: ReactNode;
  count: number;
  /**
   * The upstream lookup failed (SearchResults.unavailable): a timeout, an error status (e.g. 403
   * without a Chess.com contact), or a rate limit.
   */
  unavailable?: boolean;
  onRetry?: () => void;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="lib-hits">
      <h3 className="lib-section-title">
        {title}
        {count > 0 && <span className="lib-count">{count}</span>}
      </h3>
      {unavailable && (
        <div className="lib-hits__unavailable" role="note">
          <i data-icon={licon.CautionTriangle} aria-hidden />
          <span>Couldn't reach {typeof title === 'string' ? title : 'this site'} this time, so results here may be missing.</span>
          {onRetry && (
            <Button variant="empty" size="sm" icon={licon.Reload} onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
      {count > 0 ? <ul className="lib-hits__list">{children}</ul> : !unavailable && empty ? <p className="muted lib-hits__empty">{empty}</p> : null}
    </section>
  );
}

/** Site ratings shown with a hit: the most played time classes first. */
export const hitRatings = (ratings: readonly ExternalHitRating[] | undefined, max = 3): ExternalHitRating[] =>
  [...(ratings ?? [])].sort((a, b) => (b.games ?? 0) - (a.games ?? 0) || b.rating - a.rating).slice(0, max);

/** The meta line of an account: where it is known from, then what its site says. */
export function hitMeta(hit: ExternalPlayerHit, now = Date.now()): string {
  return [
    hit.profileSlug ? 'has a profile here' : hit.known ? 'seen in imported games' : hit.exists ? 'account found' : 'not confirmed',
    hit.games !== undefined && hit.games !== null ? plural(hit.games, 'game') : null,
    hit.seenAt ? `seen ${timeAgo(hit.seenAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * One Lichess / Chess.com account, with what its site says (ratings, games, last seen, flag) so
 * lookalikes can be told apart.
 */
export function ExternalHitRow({ hit, actions }: { hit: ExternalPlayerHit; actions?: ReactNode }) {
  const ratings = hitRatings(hit.ratings);
  return (
    <li className="lib-hit">
      <span className={`lib-hit__kind lib-source--${hit.kind}`}>{SOURCE_KIND_LABELS[hit.kind]}</span>
      <span className="lib-hit__main">
        <span className="lib-hit__name">
          {hit.title && <span className="title-badge">{hit.title}</span>}
          {hit.username}
          <FlagEmoji code={hit.country} className="lib-hit__flag" />
          {hit.closed && <span className="lib-hit__closed">closed</span>}
        </span>
        <span className="lib-hit__meta">{hitMeta(hit)}</span>
        {ratings.length > 0 && (
          <span className="lib-ratings lib-hit__ratings">
            {ratings.map(r => (
              <span
                key={r.timeClass}
                className="lib-rating"
                title={`${TIME_CLASS_LABELS[r.timeClass]} ${r.rating}${r.provisional ? '?' : ''} on ${SOURCE_KIND_LABELS[hit.kind]}${r.games !== null ? `, ${plural(r.games, 'game')}` : ''}`}
              >
                <TimeClassIcon tc={r.timeClass} />
                <span className="lib-rating__value">
                  {r.rating}
                  {r.provisional ? '?' : ''}
                </span>
              </span>
            ))}
          </span>
        )}
      </span>
      {actions && <span className="lib-hit__actions">{actions}</span>}
    </li>
  );
}

/** One reference-database player. */
export function ReferenceHitRow({ player, actions }: { player: ReferencePlayer; actions?: ReactNode }) {
  const meta = [
    player.federation,
    player.fideId ? `FIDE ${player.fideId}` : 'no FIDE id',
    plural(player.games, 'game'),
    player.maxRating ? `peak ${player.maxRating}` : null,
    player.lastPlayed ? `last ${formatDate(player.lastPlayed)}` : null,
  ].filter(Boolean);
  return (
    <li className="lib-hit">
      <span className="lib-hit__kind lib-source--fide">FIDE</span>
      <span className="lib-hit__main">
        <span className="lib-hit__name">
          {player.title && <span className="title-badge">{player.title}</span>}
          {player.name}
        </span>
        <span className="lib-hit__meta">{meta.join(' · ')}</span>
      </span>
      {actions && <span className="lib-hit__actions">{actions}</span>}
    </li>
  );
}

/** A site whose search can fail on its own (the local and reference lists can't). */
export type SearchSite = NonNullable<SearchResults['unavailable']>[number];

/** Which upstream lists failed. */
export const unavailableSet = (r: SearchResults | undefined): ReadonlySet<SearchSite> => new Set(r?.unavailable ?? []);

/** True when `q` could be a Lichess / Chess.com username (offer to add it by hand). */
export const looksLikeUsername = (q: string): boolean => /^[A-Za-z0-9_-]{2,30}$/.test(q.trim());

/** One of the per-site lists of a search. */
export type SiteList = 'lichess' | 'chesscom' | 'reference';

const SITE_NAMES = { lichess: 'Lichess', chesscom: 'Chess.com' } as const;

/**
 * The site lists in the order to show them: the list holding the best hit first (an exact
 * username or name, then one with a profile here, seen in imported games, titled), empty lists
 * last, Lichess · Chess.com · reference among equals. "hikaru" then shows Chess.com's GM Hikaru
 * before ten Lichess prefix matches. (Each list is already ordered best first by the server.)
 */
export function siteListOrder(r: SearchResults): SiteList[] {
  const q = r.q.trim().toLowerCase();
  const external = (hits: readonly ExternalPlayerHit[]) =>
    Math.min(9, ...hits.map(h => (h.username.toLowerCase() === q ? 0 : h.profileSlug ? 1 : h.known ? 2 : h.title && h.title !== 'BOT' ? 3 : 4)));
  const rank: Record<SiteList, number> = {
    lichess: external(r.lichess),
    chesscom: external(r.chesscom),
    reference: Math.min(9, ...r.reference.map(p => (p.name.toLowerCase() === q || p.fideId === q ? 0 : p.profileSlug ? 1 : 2))),
  };
  return (['lichess', 'chesscom', 'reference'] as const).slice().sort((a, b) => rank[a] - rank[b]);
}

/**
 * What an empty Lichess / Chess.com list means: the site wasn't asked (`SearchResults.notSearched`:
 * the query can't be a username there), or it was and nothing matched (`noMatch`).
 */
export function emptySiteText(r: SearchResults, site: SearchSite, noMatch: string): string {
  if (!r.notSearched?.includes(site)) return noMatch;
  const name = SITE_NAMES[site];
  return r.q.trim().length < 3
    ? `${name} wasn't searched: type at least 3 characters.`
    : `${name} wasn't searched: “${r.q}” can't be a ${name} username.`;
}
