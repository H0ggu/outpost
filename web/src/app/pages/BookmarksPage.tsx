import { useMemo, useState } from 'react';
import { useBookmarks } from '../api/hooks.ts';
import { Box, ButtonLink, EmptyState, licon, Page } from '../components/index.ts';
import { paths } from '../paths.ts';
import { filterProfiles, ProfileTable } from './components/library/ProfileList.tsx';
import { QueryView } from './components/library/QueryView.tsx';
import './components/library/library.css';

/** The filter box appears from this many bookmarks. */
const FILTER_FROM = 5;

/**
 * PLAN §9 `/bookmarks`, §6 GET /api/bookmarks: the profiles I starred, most recent first (server
 * order), with a filter and the star to remove one.
 */
export default function BookmarksPage() {
  const bookmarks = useBookmarks();
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => filterProfiles(bookmarks.data?.profiles ?? [], filter), [bookmarks.data, filter]);
  const count = bookmarks.data?.profiles.length ?? 0;

  return (
    <Page title="Bookmarks">
      <Box title="Bookmarks" pad={false}>
        <div className="lib-listbody">
          <QueryView query={bookmarks} what="your bookmarks">
            {() =>
              count === 0 ? (
                <EmptyState icon={licon.StarOutline} title="No bookmarks yet">
                  <p>Open a player's profile and click the star, or star players in the lists.</p>
                  <ButtonLink to={paths.players} icon={licon.Group} variant="secondary">
                    Browse players
                  </ButtonLink>
                </EmptyState>
              ) : (
                <>
                  {/* Shown for longer lists, and kept while a filter is typed (unstarring can drop the count). */}
                  {(count > FILTER_FROM || filter !== '') && (
                    <div className="lib-filterbar">
                      <input
                        type="search"
                        className="lib-filter-input"
                        placeholder="Filter bookmarks"
                        aria-label="Filter bookmarks"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                      />
                    </div>
                  )}
                  <ProfileTable
                    profiles={rows}
                    bookmarkable
                    showOwner
                    empty={<p className="muted lib-noresults">No bookmark matches “{filter.trim()}”.</p>}
                  />
                </>
              )
            }
          </QueryView>
        </div>
      </Box>
    </Page>
  );
}
