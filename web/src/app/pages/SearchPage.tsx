import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ExternalPlayerHit } from '@outpost/shared/api';
import { useSearch, useSession } from '../api/hooks.ts';
import { Box, ButtonLink, EmptyState, licon, Page } from '../components/index.ts';
import { paths } from '../paths.ts';
import { MAX_QUERY_LENGTH, SearchField } from './components/library/controls.tsx';
import { newProfileHref, sourceIdentity, type PickedSource } from './components/library/newProfileQuery.ts';
import { ProfileRows } from './components/library/ProfileList.tsx';
import { QueryView } from './components/library/QueryView.tsx';
import {
  emptySiteText,
  ExternalHitRow,
  externalSource,
  HitSection,
  looksLikeUsername,
  ReferenceHitRow,
  referenceSource,
  siteListOrder,
  unavailableSet,
  type SiteList,
} from './components/library/SearchHits.tsx';
import { useDebouncedValue } from './library-hooks.ts';
import './components/library/library.css';
import './SearchPage.css';

/**
 * PLAN §9 `/search?q=`, §6 GET /api/search: one box over local profiles, Lichess, Chess.com and
 * the reference database. Typing is debounced into the URL; each upstream list is independent, so
 * one site failing (`SearchResults.unavailable`) only flags its own section, and a site the query
 * wasn't sent to (`notSearched`) says so. The list with the best hit comes first. Accounts can be opened
 * (when a profile exists), turned into a profile, or picked together into one merged profile.
 */
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  // A longer link (the header box, a hand-typed URL) is cut to what the server accepts.
  const urlQ = (params.get('q') ?? '').slice(0, MAX_QUERY_LENGTH);
  const [q, setQ] = useState(urlQ);
  const written = useRef(urlQ);
  const debounced = useDebouncedValue(q, 300).trim();
  const session = useSession();
  const signedIn = !!session.data?.user;
  const [picked, setPicked] = useState<PickedSource[]>([]);

  // The header search box (or back/forward) changed the URL: follow it.
  useEffect(() => {
    if (urlQ !== written.current) {
      written.current = urlQ;
      setQ(urlQ);
    }
  }, [urlQ]);

  // Typing settled: write it to the URL (replace, so history isn't one entry per keystroke).
  useEffect(() => {
    if (debounced === written.current.trim()) return;
    written.current = debounced;
    setParams(debounced ? { q: debounced } : {}, { replace: true });
  }, [debounced, setParams]);

  const search = useSearch(debounced);
  const tooShort = debounced.length < 2;

  const isPicked = (s: PickedSource) => picked.some(p => sourceIdentity(p) === sourceIdentity(s));
  const togglePick = (s: PickedSource) =>
    setPicked(cur => (isPicked(s) ? cur.filter(p => sourceIdentity(p) !== sourceIdentity(s)) : [...cur, s]));

  const createActions = (source: PickedSource, label: string) =>
    signedIn ? (
      <>
        <label className="lib-checkbox lib-pick" title="Pick several accounts to merge them into one profile">
          <input type="checkbox" checked={isPicked(source)} onChange={() => togglePick(source)} aria-label={`Pick ${label}`} />
          <span className="lib-pick__text">Pick</span>
        </label>
        <ButtonLink to={newProfileHref([source])} size="sm" variant="secondary" icon={licon.PlusButton} aria-label={`Create a profile for ${label}`}>
          Profile
        </ButtonLink>
      </>
    ) : null;

  const externalActions = (h: ExternalPlayerHit) =>
    h.profileSlug ? (
      <ButtonLink to={paths.profile(h.profileSlug)} size="sm" variant="secondary" icon={licon.User}>
        Open
      </ButtonLink>
    ) : (
      createActions(externalSource(h), h.username)
    );

  return (
    <Page title={debounced ? `Search: ${debounced}` : 'Search'}>
      <Box title="Search players">
        <SearchField
          className="lib-search--big"
          value={q}
          onChange={setQ}
          label="Search players"
          placeholder="Username, player name or FIDE id"
          autoFocus
          busy={search.isFetching && !tooShort}
        />
        <p className="lib-hint">
          Searches profiles on this server, Lichess, Chess.com and the reference database (over-the-board players).
        </p>

        {tooShort ? (
          <EmptyState icon={licon.Search} title="Type at least 2 characters">
            <p>Try a username like “DrNykterstein”, a name like “Carlsen”, or a FIDE id.</p>
          </EmptyState>
        ) : (
          <QueryView query={search} what="search results">
            {r => {
              const down = unavailableSet(r);
              const total = r.profiles.length + r.lichess.length + r.chesscom.length + r.reference.length;
              const retry = () => void search.refetch();
              const lists: Record<SiteList, ReactNode> = {
                lichess: (
                  <HitSection
                    title="Lichess"
                    count={r.lichess.length}
                    unavailable={down.has('lichess')}
                    onRetry={retry}
                    empty={emptySiteText(r, 'lichess', 'No Lichess accounts match.')}
                  >
                    {r.lichess.map(h => (
                      <ExternalHitRow key={h.username} hit={h} actions={externalActions(h)} />
                    ))}
                  </HitSection>
                ),
                chesscom: (
                  <HitSection
                    title="Chess.com"
                    count={r.chesscom.length}
                    unavailable={down.has('chesscom')}
                    onRetry={retry}
                    empty={emptySiteText(r, 'chesscom', 'No Chess.com account with exactly this username.')}
                  >
                    {r.chesscom.map(h => (
                      <ExternalHitRow key={h.username} hit={h} actions={externalActions(h)} />
                    ))}
                  </HitSection>
                ),
                reference: (
                  <HitSection title="Reference database" count={r.reference.length} empty="No over-the-board players match.">
                    {r.reference.map(p => {
                      const src = referenceSource(p);
                      return (
                        <ReferenceHitRow
                          key={`${p.fideId ?? ''}:${p.name}`}
                          player={p}
                          actions={
                            p.profileSlug ? (
                              <ButtonLink to={paths.profile(p.profileSlug)} size="sm" variant="secondary" icon={licon.User}>
                                Open
                              </ButtonLink>
                            ) : src ? (
                              createActions(src, p.name)
                            ) : null
                          }
                        />
                      );
                    })}
                  </HitSection>
                ),
              };
              return (
                <div className={search.isPlaceholderData ? 'lib-results lib-results--stale' : 'lib-results'} aria-busy={search.isFetching}>
                  {total === 0 && down.size === 0 && (
                    <EmptyState icon={licon.Search} title={`No players found for “${r.q}”`}>
                      <p>Check the spelling, or add the account by hand below.</p>
                    </EmptyState>
                  )}

                  {r.profiles.length > 0 && (
                    <HitSection title="Profiles on this server" count={r.profiles.length}>
                      <li className="lib-hits__plist">
                        <ProfileRows profiles={r.profiles} bookmarkable={signedIn} />
                      </li>
                    </HitSection>
                  )}

                  {siteListOrder(r).map(site => (
                    <Fragment key={site}>{lists[site]}</Fragment>
                  ))}

                  {signedIn && looksLikeUsername(r.q) && <ManualAdd q={r.q} />}
                  {!signedIn && (
                    <p className="lib-hint">
                      <Link to={paths.login(paths.search(r.q))}>Sign in</Link> to create profiles from these accounts.
                    </p>
                  )}
                </div>
              );
            }}
          </QueryView>
        )}
      </Box>

      {picked.length > 0 && (
        <div className="lib-pickbar" role="region" aria-label="Picked accounts">
          <span className="lib-pickbar__text">
            <span>
              <strong>{picked.length}</strong> {picked.length === 1 ? 'account' : 'accounts'} picked
            </span>
            <span className="lib-pickbar__names">{picked.map(p => p.label ?? p.key).join(', ')}</span>
          </span>
          <span className="lib-actions">
            <button type="button" className="button button-empty button-thin" onClick={() => setPicked([])}>
              Clear
            </button>
            <ButtonLink to={newProfileHref(picked)} size="sm" icon={licon.PlusButton}>
              Create profile
            </ButtonLink>
          </span>
        </div>
      )}
    </Page>
  );
}

/** "Not listed?" — create a profile for the typed username on either site anyway. */
function ManualAdd({ q }: { q: string }) {
  return (
    <div className="lib-manual">
      <span className="muted">Not listed, or a site didn't answer? Use “{q}” anyway:</span>
      <span className="lib-actions">
        <ButtonLink to={newProfileHref([{ kind: 'lichess', key: q }])} size="sm" variant="secondary">
          Lichess account
        </ButtonLink>
        <ButtonLink to={newProfileHref([{ kind: 'chesscom', key: q }])} size="sm" variant="secondary">
          Chess.com account
        </ButtonLink>
      </span>
    </div>
  );
}
