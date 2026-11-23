/**
 * Profiles in lists: source chips, the bookmark star, a compact list (home cards) and a table
 * (players and bookmarks pages).
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProfileSummary, SourceKind, Title } from '@outpost/shared/api';
import { FlagEmoji, Icon, licon, Table, type Column } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { useToggleBookmark } from '../../library-hooks.ts';
import { ActionErrorToast } from './controls.tsx';
import { plural, SOURCE_KIND_LABELS, timeAgo } from './format.ts';

/** A source as shown on a chip. */
export interface SourceChip {
  kind: SourceKind;
  displayName: string;
  title?: Title | null;
  country?: string | null;
}

/** One account chip: site, title, name, flag. */
export function SourceBadge({ source }: { source: SourceChip }) {
  return (
    <span className={`lib-source lib-source--${source.kind}`} title={`${SOURCE_KIND_LABELS[source.kind]}: ${source.displayName}`}>
      <span className="lib-source__kind">{SOURCE_KIND_LABELS[source.kind]}</span>
      {source.title && <span className="title-badge">{source.title}</span>}
      <span className="lib-source__name">{source.displayName}</span>
      <FlagEmoji code={source.country} />
    </span>
  );
}

/** The accounts of a profile as chips; `max` folds the rest into "+n". */
export function SourceBadges({ sources, max }: { sources: readonly SourceChip[]; max?: number }) {
  if (sources.length === 0) return null;
  const shown = max !== undefined ? sources.slice(0, max) : sources;
  const rest = sources.length - shown.length;
  return (
    <span className="lib-sources">
      {shown.map((s, i) => (
        <SourceBadge key={`${s.kind}:${s.displayName}:${i}`} source={s} />
      ))}
      {rest > 0 && <span className="lib-source lib-source--more">+{rest}</span>}
    </span>
  );
}

/**
 * Star toggle (`PUT` / `DELETE …/bookmark`), optimistic while the request runs; a failure flips it
 * back and says why in a toast.
 */
export function BookmarkButton({ slug, bookmarked, name }: { slug: string; bookmarked: boolean; name: string }) {
  const toggle = useToggleBookmark();
  const [pending, setPending] = useState<boolean | null>(null);
  /** The last failed toggle: the error and what it tried to do. */
  const [failure, setFailure] = useState<{ error: unknown; wanted: boolean } | null>(null);
  const dismiss = useCallback(() => setFailure(null), []);
  const on = pending ?? bookmarked;
  const label = on ? `Remove ${name} from bookmarks` : `Bookmark ${name}`;
  return (
    <>
      <button
        type="button"
        className={on ? 'lib-star lib-star--on' : 'lib-star'}
        aria-pressed={on}
        aria-label={label}
        title={label}
        data-icon={on ? licon.Star : licon.StarOutline}
        disabled={toggle.isPending}
        onClick={() => {
          const wanted = !on;
          setPending(wanted);
          setFailure(null);
          toggle.mutate(
            { slug, bookmarked: wanted },
            { onError: error => setFailure({ error, wanted }), onSettled: () => setPending(null) },
          );
        }}
      />
      {failure && (
        <ActionErrorToast
          error={failure.error}
          what={failure.wanted ? `bookmark ${name}` : `remove ${name} from bookmarks`}
          onClose={dismiss}
        />
      )}
    </>
  );
}

/** Name of a profile with a padlock when private. */
export function ProfileName({ profile }: { profile: Pick<ProfileSummary, 'displayName' | 'visibility'> }) {
  return (
    <span className="lib-pname">
      {profile.visibility === 'private' && <Icon glyph={licon.Padlock} title="Private profile" className="lib-pname__lock" />}
      <span className="lib-pname__text">{profile.displayName}</span>
    </span>
  );
}

/** "12 games · updated 3 days ago". */
export function profileMeta(p: Pick<ProfileSummary, 'gameCount' | 'lastUpdated'>): string {
  return `${plural(p.gameCount, 'game')} · ${p.lastUpdated ? `updated ${timeAgo(p.lastUpdated)}` : 'not synced yet'}`;
}

/** Compact list of profiles (home page cards). */
export function ProfileRows({
  profiles,
  bookmarkable,
  empty,
  max,
  action,
}: {
  profiles: readonly ProfileSummary[];
  /** Show the bookmark star (signed-in viewers). */
  bookmarkable: boolean;
  empty?: ReactNode;
  max?: number;
  /** Extra control at the end of each row. */
  action?: (p: ProfileSummary) => ReactNode;
}) {
  if (profiles.length === 0) return <>{empty ?? null}</>;
  const shown = max !== undefined ? profiles.slice(0, max) : profiles;
  return (
    <ul className="lib-plist">
      {shown.map(p => (
        <li key={p.id} className="lib-plist__row">
          <Link to={paths.profile(p.slug)} className="lib-plist__link">
            <ProfileName profile={p} />
            <SourceBadges sources={p.sources} max={3} />
            <span className="lib-plist__meta">{profileMeta(p)}</span>
          </Link>
          {action?.(p)}
          {bookmarkable && <BookmarkButton slug={p.slug} bookmarked={p.bookmarked} name={p.displayName} />}
        </li>
      ))}
    </ul>
  );
}

/** Profiles as a lila table (players and bookmarks pages). */
export function ProfileTable({
  profiles,
  bookmarkable,
  showOwner = false,
  empty,
}: {
  profiles: readonly ProfileSummary[];
  bookmarkable: boolean;
  showOwner?: boolean;
  empty?: ReactNode;
}) {
  const columns: Column<ProfileSummary>[] = [
    {
      key: 'player',
      header: 'Player',
      render: p => (
        <Link to={paths.profile(p.slug)} className="lib-ptable__player">
          <ProfileName profile={p} />
          <SourceBadges sources={p.sources} max={4} />
        </Link>
      ),
    },
    { key: 'games', header: 'Games', align: 'num', render: p => p.gameCount.toLocaleString('en') },
    {
      key: 'updated',
      header: 'Updated',
      hideBelow: 560,
      render: p => <span className="muted">{p.lastUpdated ? timeAgo(p.lastUpdated) : 'not synced yet'}</span>,
    },
  ];
  if (showOwner)
    columns.push({ key: 'owner', header: 'Created by', hideBelow: 760, render: p => <span className="muted">{p.owner?.username ?? '—'}</span> });
  if (bookmarkable)
    columns.push({
      key: 'star',
      header: <span className="visually-hidden">Bookmark</span>,
      align: 'center',
      render: p => <BookmarkButton slug={p.slug} bookmarked={p.bookmarked} name={p.displayName} />,
    });
  // Column widths: library.css (fixed layout; the player column takes the rest and ellipsizes).
  return (
    <div className="lib-tablehost">
      <Table columns={columns} rows={profiles} rowKey={p => p.id} empty={empty} className="lib-ptable" />
    </div>
  );
}

/** Case-insensitive match on the name, the address and every account name. */
export function filterProfiles(profiles: readonly ProfileSummary[], text: string): ProfileSummary[] {
  const t = text.trim().toLowerCase();
  if (!t) return [...profiles];
  return profiles.filter(
    p =>
      p.displayName.toLowerCase().includes(t) ||
      p.slug.includes(t) ||
      p.sources.some(s => s.displayName.toLowerCase().includes(t) || s.key.toLowerCase().includes(t)),
  );
}
