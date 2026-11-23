import { useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import type { UserPrefs } from '@outpost/shared/api';
import type { ProfileFilters } from '@outpost/shared/filters';
import { ApiError } from '../../api/client.ts';
import { browserTimeZone, useProfileHeader, useSession, useUpdatePrefs, useUrlFilters } from '../../api/hooks.ts';
import { Box, EmptyState, ErrorBox, licon, Page, Spinner, type TabItem } from '../../components/index.ts';
import { FILTERED_TABS, paths, PROFILE_TABS, type ProfileTab } from '../../paths.ts';
import { effectivePrefs } from '../../prefs.ts';
import { FiltersBar } from './components/FiltersBar.tsx';
import { ProfileHead } from './components/ProfileHead.tsx';
import type { ProfileContext } from './hooks.ts';
import './profile.css';

/**
 * Profile shell for `/u/:slug/*` (PLAN §5, §9): header (name, sources with sync status, update
 * button, bookmark), the tab bar, the filters bar on the tabs that share it, and the active tab
 * below. Tabs receive a `ProfileContext` through the outlet (`useProfile()` in ./hooks.ts).
 *
 * Tab links carry the filter query between the filtered tabs (FILTERED_TABS in paths.ts); the
 * Rating tab takes the date range only, and the other tabs start unfiltered.
 */
export default function ProfileLayout() {
  const { slug = '' } = useParams();
  const location = useLocation();
  const session = useSession();
  const header = useProfileHeader(slug);
  const [filters] = useUrlFilters();
  const updatePrefs = useUpdatePrefs();
  const [tzOverride, setTzOverride] = useState<UserPrefs['timezone'] | null>(null);

  const signedIn = !!session.data?.user;
  const prefs = effectivePrefs(session.data);
  const tzPref = tzOverride ?? prefs.timezone;
  const timeZone = tzPref === 'utc' ? 'UTC' : browserTimeZone();

  const tab = currentTab(location.pathname, slug);
  const h = header.data;

  if (header.isPending) {
    return (
      <Page title={slug}>
        <Spinner center label="Loading profile" />
      </Page>
    );
  }

  if (header.isError || !h) {
    const e = header.error;
    const notFound = e instanceof ApiError && (e.isNotFound || e.code === 'forbidden');
    const unauthorized = e instanceof ApiError && e.isUnauthorized;
    return (
      <Page title={notFound ? 'Profile not found' : slug}>
        <Box title={notFound ? 'Profile not found' : 'Profile'}>
          {notFound ? (
            <EmptyState icon={licon.User} title={`No profile called “${slug}”`}>
              <p>It may be private, renamed or deleted.</p>
              <Link to={paths.search(slug)}>Search for this player</Link>
            </EmptyState>
          ) : unauthorized ? (
            <EmptyState icon={licon.Padlock} title="Sign in to see this profile">
              <Link to={paths.login(location.pathname)}>Sign in</Link>
            </EmptyState>
          ) : (
            <ErrorBox error={e} onRetry={() => void header.refetch()} />
          )}
        </Box>
      </Page>
    );
  }

  const context: ProfileContext = {
    slug: h.slug,
    header: h,
    prefs: { ...prefs, timezone: tzPref },
    signedIn,
    timeZone,
    setTimeZonePref: tz => {
      setTzOverride(tz);
      if (signedIn) updatePrefs.mutate({ timezone: tz });
    },
  };

  const carry = (t: ProfileTab): ProfileFilters | undefined => {
    if (FILTERED_TABS.includes(t)) return filters;
    if (t === 'rating') return { period: filters.period, from: filters.from, to: filters.to };
    return undefined;
  };
  const tabs: TabItem[] = PROFILE_TABS.map(t => ({ to: paths.profile(h.slug, t.tab, carry(t.tab)), label: t.label, end: t.tab === '' }));
  if (h.canEdit) tabs.push({ to: paths.profile(h.slug, 'settings'), label: 'Settings', icon: licon.Gear });

  const tabLabel = tab === 'settings' ? 'Settings' : PROFILE_TABS.find(t => t.tab === tab)?.label;
  const showFilters = tab !== null && FILTERED_TABS.includes(tab);

  return (
    <Page title={tabLabel && tab !== '' ? `${h.displayName} · ${tabLabel}` : h.displayName}>
      <div className="profile-page">
        <ProfileHead header={h} signedIn={signedIn} filters={filters} tabs={tabs} />
        {showFilters && <FiltersBar header={h} hideColor={tab === 'explorer' || tab === 'openings'} />}
        <Outlet context={context} />
      </div>
    </Page>
  );
}

/** The tab segment of `/u/<slug>/<tab>` ('' for the overview), or null if unknown. */
function currentTab(pathname: string, slug: string): ProfileTab | null {
  const rest = pathname.replace(/\/+$/, '').split('/').slice(3);
  const seg = decodeURIComponent(rest[0] ?? '');
  if (!slug) return null;
  if (seg === '' || seg === 'settings') return seg;
  return PROFILE_TABS.some(t => t.tab === seg) ? (seg as ProfileTab) : null;
}
