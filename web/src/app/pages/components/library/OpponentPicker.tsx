/**
 * Adds opponents to a prep set: from my profiles and bookmarks, or from search — a local profile,
 * an account that already has a profile, or a new account (a private profile is created for it
 * first, then added).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { API_ROUTES, type Id, type ProfileHeader, type ProfileSummary } from '@outpost/shared/api';
import { api } from '../../../api/client.ts';
import { queryKeys, useBookmarks, useProfiles, useSearch } from '../../../api/hooks.ts';
import { Button, ErrorBox, licon } from '../../../components/index.ts';
import { useCreateProfile, useDebouncedValue } from '../../library-hooks.ts';
import { SearchField } from './controls.tsx';
import type { PickedSource } from './newProfileQuery.ts';
import { ProfileRows } from './ProfileList.tsx';
import { ExternalHitRow, externalSource, HitSection, ReferenceHitRow, referenceSource, unavailableSet } from './SearchHits.tsx';

export function OpponentPicker({
  existing,
  onAdd,
  busy,
}: {
  /** Profile ids already in the set. */
  existing: readonly Id[];
  /** Adds a profile id to the set (resolves when saved). */
  onAdd: (profileId: Id) => Promise<unknown>;
  busy: boolean;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q, 300).trim();
  const search = useSearch(term);
  const mine = useProfiles('mine');
  const bookmarks = useBookmarks();
  const create = useCreateProfile();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const has = (id: Id) => existing.includes(id);

  const suggestions = useMemo(() => {
    const byId = new Map<Id, ProfileSummary>();
    for (const p of [...(bookmarks.data?.profiles ?? []), ...(mine.data?.profiles ?? [])]) byId.set(p.id, p);
    return [...byId.values()];
  }, [mine.data, bookmarks.data]);

  /** Runs one add with a per-row busy marker and a shared error line. */
  const run = async (key: string, task: () => Promise<Id>) => {
    setWorking(key);
    setError(null);
    try {
      await onAdd(await task());
    } catch (e) {
      setError(e);
    } finally {
      setWorking(null);
    }
  };

  const addProfile = (p: ProfileSummary) => run(`p:${p.id}`, async () => p.id);
  const addBySlug = (slug: string) =>
    run(`s:${slug}`, async () => {
      const header = await qc.fetchQuery({
        queryKey: queryKeys.profile(slug),
        queryFn: ({ signal }) => api.get<ProfileHeader>(API_ROUTES.profile(slug), undefined, signal),
      });
      return header.id;
    });
  const createAndAdd = (src: PickedSource) =>
    run(`c:${src.kind}:${src.key}`, async () => {
      const header = await create.mutateAsync({
        displayName: src.label ?? src.key,
        visibility: 'private',
        sources: [{ kind: src.kind, key: src.key }],
      });
      return header.id;
    });

  const profileAction = (p: ProfileSummary) =>
    has(p.id) ? (
      <span className="lib-pill lib-pill--good" data-icon={licon.Checkmark}>
        in set
      </span>
    ) : (
      <Button size="sm" variant="secondary" icon={licon.PlusButton} disabled={busy || working !== null} onClick={() => void addProfile(p)} aria-label={`Add ${p.displayName}`}>
        {working === `p:${p.id}` ? 'Adding…' : 'Add'}
      </Button>
    );

  const accountAction = (slug: string | null, src: PickedSource | null, name: string) => {
    if (slug)
      return (
        <Button size="sm" variant="secondary" icon={licon.PlusButton} disabled={busy || working !== null} onClick={() => void addBySlug(slug)} aria-label={`Add ${name}`}>
          {working === `s:${slug}` ? 'Adding…' : 'Add'}
        </Button>
      );
    if (!src) return <span className="muted lib-hit__note">no FIDE id</span>;
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={licon.PlusButton}
        disabled={busy || working !== null}
        title="Creates a private profile for this account and adds it"
        onClick={() => void createAndAdd(src)}
        aria-label={`Create a profile for ${name} and add it`}
      >
        {working === `c:${src.kind}:${src.key}` ? 'Creating…' : 'Create & add'}
      </Button>
    );
  };

  const r = search.data;
  const down = unavailableSet(r);

  return (
    <div className="lib-opp-picker">
      <SearchField
        value={q}
        onChange={setQ}
        label="Find an opponent"
        placeholder="Profile, username, player name or FIDE id"
        busy={search.isFetching && term.length >= 2}
      />
      {error !== null && <ErrorBox error={error} title="Could not add the opponent" />}
      {term.length < 2 ? (
        suggestions.length > 0 && (
          <>
            <h3 className="lib-section-title">From my profiles and bookmarks</h3>
            <ProfileRows profiles={suggestions} bookmarkable={false} action={profileAction} max={12} />
          </>
        )
      ) : search.isError ? (
        <ErrorBox error={search.error} title="Search failed" onRetry={() => void search.refetch()} />
      ) : r ? (
        <div className={search.isPlaceholderData ? 'lib-results lib-results--stale' : 'lib-results'}>
          <HitSection title="Profiles" count={r.profiles.length} empty="No profile matches.">
            <li className="lib-hits__plist">
              <ProfileRows profiles={r.profiles} bookmarkable={false} action={profileAction} />
            </li>
          </HitSection>
          <HitSection title="Lichess" count={r.lichess.length} unavailable={down.has('lichess')} empty="No match.">
            {r.lichess.map(h => (
              <ExternalHitRow key={h.username} hit={h} actions={accountAction(h.profileSlug, externalSource(h), h.username)} />
            ))}
          </HitSection>
          <HitSection title="Chess.com" count={r.chesscom.length} unavailable={down.has('chesscom')} empty="No exact match.">
            {r.chesscom.map(h => (
              <ExternalHitRow key={h.username} hit={h} actions={accountAction(h.profileSlug, externalSource(h), h.username)} />
            ))}
          </HitSection>
          {(r.reference.length > 0 || down.has('reference')) && (
            <HitSection title="Reference database" count={r.reference.length} unavailable={down.has('reference')}>
              {r.reference.map(p => (
                <ReferenceHitRow key={`${p.fideId ?? ''}:${p.name}`} player={p} actions={accountAction(p.profileSlug, referenceSource(p), p.name)} />
              ))}
            </HitSection>
          )}
        </div>
      ) : null}
    </div>
  );
}
