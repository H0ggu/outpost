import { Outlet } from 'react-router';
import { useSession } from '../../api/hooks.ts';
import { Box, EmptyState, licon, Page, Spinner, Tabs } from '../../components/index.ts';
import { paths } from '../../paths.ts';

const TABS = [
  { to: paths.admin.settings, label: 'Settings', icon: licon.Gear },
  { to: paths.admin.users, label: 'Users', icon: licon.Group },
  { to: paths.admin.jobs, label: 'Jobs', icon: licon.List },
  { to: paths.admin.reference, label: 'Reference DB', icon: licon.Book },
];

/**
 * Admin shell for `/admin/*` (PLAN §6 admin endpoints). The server enforces admin access;
 * this only avoids showing the pages to others.
 * TODO(web-other): status summary (GET /api/admin/status) above the tabs.
 */
export default function AdminLayout() {
  const session = useSession();
  if (session.isPending) return <Spinner center />;
  if (session.data?.user?.role !== 'admin') {
    return (
      <Page title="Admin">
        <Box title="Admin">
          <EmptyState icon={licon.Padlock} title="Admins only" />
        </Box>
      </Page>
    );
  }
  return (
    <Page title="Admin">
      <Box title="Admin" pad={false}>
        <Tabs items={TABS} label="Admin sections" />
      </Box>
      <Outlet />
    </Page>
  );
}
