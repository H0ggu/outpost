import { useMemo, useState } from 'react';
import type { ProfileListQuery, ProfileListResponse } from '@outpost/shared/api';
import { useBookmarks, useProfiles, useSession } from '../api/hooks.ts';
import { Box, ButtonLink, EmptyState, licon, Page, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { ParamTabs, useParamTab, type ParamTab } from './components/library/controls.tsx';
import { filterProfiles, ProfileTable } from './components/library/ProfileList.tsx';
import { QueryView, type QueryLike } from './components/library/QueryView.tsx';
import './components/library/library.css';

type PlayersTab = ProfileListQuery['scope'] | 'bookmarks';

const ALL_TABS: ReadonlyArray<ParamTab<PlayersTab>> = [
  { value: 'public', label: 'Public', icon: licon.Globe },
  { value: 'mine', label: 'My profiles', icon: licon.User },
  { value: 'recent', label: 'Recently viewed', icon: licon.Clock },
  { value: 'bookmarks', label: 'Bookmarks', icon: licon.Star },
];

/**
 * PLAN §9 `/players`, §5 players list: public profiles, my profiles, recently viewed and bookmarks
 * (GET /api/profiles?scope=, /api/bookmarks), as tabs in the query string (`?tab=`), with a quick
 * name filter. Signed-out visitors (anonymous browsing) only get the public tab.
 */
export default function PlayersPage() {
  const session = useSession();
  const signedIn = !!session.data?.user;
  const tabs = signedIn ? ALL_TABS : ALL_TABS.slice(0, 1);
  const tab = useParamTab(tabs);
  const [filter, setFilter] = useState('');

  return (
    <Page title="Players">
      <Box
        title="Players"
        pad={false}
        actions={
          signedIn && (
            <ButtonLink to={paths.newProfile} size="sm" icon={licon.PlusButton}>
              New profile
            </ButtonLink>
          )
        }
      >
        {session.isPending ? (
          <Spinner center />
        ) : (
          <>
            {tabs.length > 1 && <ParamTabs tabs={tabs} label="Player lists" />}
            <div className="lib-filterbar">
              <input
                type="search"
                className="lib-filter-input"
                placeholder="Filter by name or account"
                aria-label="Filter players"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
            </div>
            {tab === 'bookmarks' ? (
              <BookmarksList filter={filter} />
            ) : (
              <ScopeList key={tab} scope={tab} filter={filter} signedIn={signedIn} />
            )}
          </>
        )}
      </Box>
    </Page>
  );
}

const EMPTY: Record<PlayersTab, { title: string; text: string }> = {
  public: { title: 'No public profiles yet', text: 'Profiles their owners make public are listed here.' },
  mine: { title: 'You have no profiles yet', text: 'Create one from a Lichess or Chess.com account.' },
  recent: { title: 'Nothing viewed yet', text: 'Profiles you open are remembered here.' },
  bookmarks: { title: 'No bookmarks yet', text: 'Star a profile to keep it close.' },
};

function ScopeList({ scope, filter, signedIn }: { scope: ProfileListQuery['scope']; filter: string; signedIn: boolean }) {
  const q = useProfiles(scope);
  return <ListBody query={q} tab={scope} filter={filter} signedIn={signedIn} />;
}

function BookmarksList({ filter }: { filter: string }) {
  const q = useBookmarks();
  return <ListBody query={q} tab="bookmarks" filter={filter} signedIn />;
}

function ListBody({
  query,
  tab,
  filter,
  signedIn,
}: {
  query: QueryLike<ProfileListResponse>;
  tab: PlayersTab;
  filter: string;
  signedIn: boolean;
}) {
  const rows = useMemo(() => filterProfiles(query.data?.profiles ?? [], filter), [query.data, filter]);
  return (
    <div className="lib-listbody">
      <QueryView query={query} what="these players">
        {d =>
          d.profiles.length === 0 ? (
            <EmptyState icon={tab === 'bookmarks' ? licon.StarOutline : licon.Group} title={EMPTY[tab].title}>
              <p>{EMPTY[tab].text}</p>
              {tab === 'mine' && (
                <ButtonLink to={paths.newProfile} icon={licon.PlusButton}>
                  New profile
                </ButtonLink>
              )}
            </EmptyState>
          ) : (
            <ProfileTable
              profiles={rows}
              bookmarkable={signedIn}
              showOwner={tab !== 'mine'}
              empty={<p className="muted lib-noresults">No player matches “{filter.trim()}”.</p>}
            />
          )
        }
      </QueryView>
    </div>
  );
}
