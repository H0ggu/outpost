/**
 * Rows of the unified search (PLAN §5: local profiles, Lichess, Chess.com, reference players),
 * shared by the search page, the new-profile account picker and the prep opponent picker. Each
 * caller supplies the actions on the right of a row.
 */
import type { ReactNode } from 'react';
import type { ExternalPlayerHit, ReferencePlayer, SearchResults } from '@outpost/shared/api';
import { Button, licon } from '../../../components/index.ts';
import { formatDate, plural, SOURCE_KIND_LABELS } from './format.ts';
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

/** One Lichess / Chess.com account. */
export function ExternalHitRow({ hit, actions }: { hit: ExternalPlayerHit; actions?: ReactNode }) {
  return (
    <li className="lib-hit">
      <span className={`lib-hit__kind lib-source--${hit.kind}`}>{SOURCE_KIND_LABELS[hit.kind]}</span>
      <span className="lib-hit__main">
        <span className="lib-hit__name">
          {hit.title && <span className="title-badge">{hit.title}</span>}
          {hit.username}
        </span>
        <span className="lib-hit__meta">
          {hit.profileSlug ? 'has a profile here' : hit.known ? 'seen in imported games' : hit.exists ? 'account found' : 'not confirmed'}
        </span>
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
