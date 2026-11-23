/**
 * Admin shell for `/admin/*` (PLAN §6 admin endpoints) in lila's page-menu layout: the section
 * menu (settings, users, jobs, reference DB) with a one-line instance status under it, and the
 * section page next to it. The server enforces admin access; this only keeps the pages from
 * others.
 */
import { Outlet, useLocation } from 'react-router';
import { useSession } from '../../api/hooks.ts';
import { Box, EmptyState, ErrorBox, licon, Page, Spinner } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import { SignInPrompt } from '../components/account/misc.tsx';
import { PageMenu } from '../components/account/PageMenu.tsx';
import { StatusSummary } from '../components/account/StatusPanel.tsx';
import './admin.css';

const SECTIONS = [
  { to: paths.admin.settings, label: 'Settings', icon: licon.Gear },
  { to: paths.admin.users, label: 'Users', icon: licon.Group },
  { to: paths.admin.jobs, label: 'Jobs', icon: licon.List },
  { to: paths.admin.reference, label: 'Reference DB', icon: licon.Book },
];

export default function AdminLayout() {
  const session = useSession();
  const { pathname } = useLocation();
  if (session.isPending) return <Spinner center />;
  if (session.isError)
    return (
      <Page title="Admin">
        <ErrorBox error={session.error} onRetry={() => void session.refetch()} />
      </Page>
    );
  const user = session.data.user;
  if (!user) return <SignInPrompt title="Admin">The admin pages are for the admins of this Outpost.</SignInPrompt>;
  if (user.role !== 'admin') {
    return (
      <Page title="Admin" narrow>
        <Box title="Admin">
          <EmptyState icon={licon.Padlock} title="Admins only">
            <p>Your account is not an admin of this Outpost.</p>
          </EmptyState>
        </Box>
      </Page>
    );
  }
  // No <Page> here: it would set the document title after the section page set its own.
  return (
    <div className="page">
      <PageMenu
        label="Admin sections"
        items={SECTIONS.map(s => ({ ...s, active: pathname === s.to || pathname.startsWith(`${s.to}/`) }))}
        extra={<StatusSummary />}
      >
        <Outlet />
      </PageMenu>
    </div>
  );
}
