import { Outlet, useParams } from 'react-router';
import { useProfileHeader } from '../../api/hooks.ts';
import { Box, ErrorBox, Page, Tabs, type TabItem } from '../../components/index.ts';
import { paths, PROFILE_TABS } from '../../paths.ts';

/**
 * Profile shell for `/u/:slug/*` (PLAN §5, §9): header (name, sources with sync status, update
 * button, bookmark), the tab bar, and the active tab below. Tabs that share the filters bar
 * (FILTERED_TABS in paths.ts) keep the filter query when switching.
 * TODO(web-profile): header with sources, ratings, update/queue state, bookmark; filters bar.
 */
export default function ProfileLayout() {
  const { slug = '' } = useParams();
  const header = useProfileHeader(slug);
  const name = header.data?.displayName ?? slug;

  const tabs: TabItem[] = PROFILE_TABS.map(t => ({ to: paths.profile(slug, t.tab), label: t.label, end: t.tab === '' }));
  if (header.data?.canEdit) tabs.push({ to: paths.profile(slug, 'settings'), label: 'Settings' });

  return (
    <Page title={name}>
      <Box title={name} pad={false}>
        <Tabs items={tabs} label="Profile sections" />
      </Box>
      {header.isError && <ErrorBox error={header.error} onRetry={() => void header.refetch()} />}
      <Outlet />
    </Page>
  );
}
