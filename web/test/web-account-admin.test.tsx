import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminSettings, BroadcastMonthStatus, ReferenceInfo } from '@outpost/shared/api';
import { ACCOUNT_POLL } from '../src/app/pages/account-hooks.ts';
import AdminJobsPage from '../src/app/pages/admin/AdminJobsPage.tsx';
import AdminLayout from '../src/app/pages/admin/AdminLayout.tsx';
import AdminReferencePage from '../src/app/pages/admin/AdminReferencePage.tsx';
import AdminSettingsPage from '../src/app/pages/admin/AdminSettingsPage.tsx';
import AdminUsersPage from '../src/app/pages/admin/AdminUsersPage.tsx';
import {
  ADMIN,
  adminSettings,
  adminStatus,
  adminUser,
  apiError,
  invite,
  job,
  later,
  NOW,
  referenceDb,
  renderAt,
  session,
  user,
  withFakeApi,
} from './web-account-helpers.tsx';

const api = withFakeApi();

/** Admin session plus the status the admin menu shows. */
const asAdmin = () =>
  api()
    .on('GET', '/api/session', session(ADMIN))
    .on('GET', '/api/admin/status', adminStatus())
    .on('GET', '/api/jobs/mine', { jobs: [] });

describe('AdminLayout', () => {
  const tree = (path: string) =>
    renderAt(<div />, {
      path,
      route: 'unused',
      extraRoutes: [
        {
          path: 'admin',
          element: <AdminLayout />,
          children: [
            { path: 'settings', element: <p>Settings section</p> },
            { path: 'users', element: <p>Users section</p> },
          ],
        },
      ],
    });

  it('keeps non-admins out', async () => {
    api().on('GET', '/api/session', session(user()));
    tree('/admin/settings');
    expect(await screen.findByText('Admins only')).toBeTruthy();
    expect(screen.queryByText('Settings section')).toBeNull();
    expect(api().find('GET', '/api/admin/status')).toHaveLength(0);
  });

  it('asks visitors to sign in', async () => {
    api().on('GET', '/api/session', session(null));
    tree('/admin/users');
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe('/login?next=%2Fadmin%2Fusers');
  });

  it('shows the section menu and a status summary to admins', async () => {
    asAdmin();
    tree('/admin/users');
    expect(await screen.findByText('Users section')).toBeTruthy();
    const menu = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(menu).getByRole('link', { name: 'Users' }).getAttribute('aria-current')).toBe('page');
    expect(within(menu).getByRole('link', { name: 'Reference DB' }).getAttribute('href')).toBe('/admin/reference');
    expect(await within(menu).findByText('13 MB')).toBeTruthy();
    expect(within(menu).getByText('Valid')).toBeTruthy();
    expect(within(menu).getByText('1/2 up')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Settings + status
// ---------------------------------------------------------------------------

describe('AdminSettingsPage', () => {
  /** A settings server applying PUTs. */
  const settingsServer = (start: AdminSettings = adminSettings()) => {
    let current = structuredClone(start);
    asAdmin()
      .on('GET', '/api/admin/settings', () => current)
      .on('GET', '/api/reference', { databases: [referenceDb({ id: 4, name: 'TWIC' })], totalGames: 1, broadcastMonths: [], attribution: [] })
      .on('PUT', '/api/admin/settings', req => {
        const b = req.body as Record<string, unknown>;
        current = { ...current, ...b } as AdminSettings;
        if ('lichessToken' in b)
          current.lichessToken = b.lichessToken === null ? { set: false, masked: null, fromEnv: false } : { set: true, masked: 'lip_…new1', fromEnv: false };
        return current;
      });
    return () => current;
  };

  it('saves only the changed settings and shows the server answer', async () => {
    const current = settingsServer();
    // Slow refetches after the save, as over a network: the form is re-keyed before they answer.
    api()
      .on('GET', '/api/session', () => later(40, null).then(() => session(ADMIN, { signupMode: current().signupMode })))
      .on('GET', '/api/admin/status', () => later(40, adminStatus()));
    const { qc } = renderAt(<AdminSettingsPage />, { path: '/admin/settings', layout: true });
    const save = await screen.findByRole('button', { name: 'Save settings' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Open' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Anonymous browsing' }));
    fireEvent.change(screen.getByLabelText('Update cooldown (minutes)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Daily auto-refresh'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Masters database'), { target: { value: 'reference:4' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(save);
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    expect(api().find('PUT', '/api/admin/settings')[0]?.body).toEqual({
      signupMode: 'open',
      anonymousBrowsing: true,
      autoRefreshHourUtc: 4,
      updateCooldownMinutes: 30,
      mastersSource: 'reference:4',
    });
    expect(current().signupMode).toBe('open');
    expect(screen.getByText('No changes')).toBeTruthy();
    // The session knows the new sign-up mode (and is refetched).
    await waitFor(() => expect(qc.getQueryData<{ signupMode: string }>(['session'])?.signupMode).toBe('open'));
  });

  it('replaces and removes the Lichess token without ever showing it', async () => {
    settingsServer();
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    expect(await screen.findByText('lip_…a1b2')).toBeTruthy();
    const input = screen.getByLabelText('Lichess API token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'lip_bad token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/only letters, digits and _/)).toBeTruthy();
    expect(api().find('PUT', '/api/admin/settings')).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'lip_Good_123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('lip_…new1')).toBeTruthy();
    expect(api().find('PUT', '/api/admin/settings')[0]?.body).toEqual({ lichessToken: 'lip_Good_123' });
    expect((screen.getByLabelText('Lichess API token') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    expect(screen.getByText('Will be removed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Not set')).toBeTruthy();
    expect(api().find('PUT', '/api/admin/settings')[1]?.body).toEqual({ lichessToken: null });
  });

  it('says when env variables override the token and the contact', async () => {
    settingsServer(
      adminSettings({ lichessToken: { set: true, masked: 'lip_…envv', fromEnv: true }, chesscomContact: 'env@example.org', chesscomContactFromEnv: true }),
    );
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    expect(await screen.findByText('lip_…envv')).toBeTruthy();
    expect(screen.getByText('LICHESS_TOKEN')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove token' })).toBeNull();
    const contact = screen.getByLabelText('Chess.com contact') as HTMLInputElement;
    expect(contact.disabled).toBe(true);
    expect(contact.value).toBe('env@example.org');
    expect(screen.getByText('CHESSCOM_CONTACT')).toBeTruthy();
  });

  it('checks ranges and maps server validation to the field', async () => {
    settingsServer();
    api().on('PUT', '/api/admin/settings', apiError(400, 'validation', 'initialSyncMonths: too big', { issues: [{ path: 'initialSyncMonths', message: 'Too big' }] }));
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    const cooldown = await screen.findByLabelText('Update cooldown (minutes)');
    fireEvent.change(cooldown, { target: { value: '99999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/from 0 to 10,080/)).toBeTruthy();
    fireEvent.change(cooldown, { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('First import (months)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Too big')).toBeTruthy();
    expect(screen.getByLabelText('First import (months)').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((screen.getByLabelText('First import (months)') as HTMLInputElement).value).toBe('0');
  });

  it('explains that closed sign-up refuses invite links too', async () => {
    settingsServer(adminSettings({ signupMode: 'closed' }));
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    expect(await screen.findByText(/Nobody can create an account, not even with an invite link/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Invite only' }));
    expect(screen.getByText(/Only people with an invite link or code/)).toBeTruthy();
  });

  it('offers broadcast auto-import (decision 22)', async () => {
    settingsServer(adminSettings({ broadcastAutoImport: false }));
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    fireEvent.click(await screen.findByRole('switch', { name: 'Import finished broadcast rounds automatically' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api().find('PUT', '/api/admin/settings')[0]?.body).toEqual({ broadcastAutoImport: true }));
  });

  it('says broadcast auto-import needs the Lichess token when none is set', async () => {
    settingsServer(adminSettings({ lichessToken: { set: false, masked: null, fromEnv: false } }));
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    await screen.findByRole('switch', { name: 'Import finished broadcast rounds automatically' });
    expect(screen.getByText(/which is not set: nothing is imported until you add one/)).toBeTruthy();
  });

  it('shows the status panel: versions, size, token, upstreams, counts', async () => {
    settingsServer();
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    expect(await screen.findByRole('heading', { name: 'Status' })).toBeTruthy();
    expect(await screen.findByText('v26.13.1')).toBeTruthy();
    expect(screen.getByText('3.51.0')).toBeTruthy();
    expect(screen.getByText('2h 0m')).toBeTruthy();
    expect(screen.getAllByText('13 MB').length).toBeGreaterThan(0);
    expect(screen.getByText('bot')).toBeTruthy();
    expect(screen.getByText('1/2 reachable')).toBeTruthy();
    expect(screen.getByText('timeout')).toBeTruthy();
    expect(screen.getByText('api.chess.com')).toBeTruthy();
    expect(screen.getByText('50,000')).toBeTruthy();
    api().on('GET', '/api/admin/status', adminStatus({ lichessToken: { configured: true, valid: false, userId: null, scopes: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Invalid')).toBeTruthy();
  });

  it('explains a missing token in the status panel', async () => {
    settingsServer();
    api().on('GET', '/api/admin/status', adminStatus({ lichessToken: { configured: false, valid: null, userId: null, scopes: [] } }));
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    expect(await screen.findByText(/need a token/)).toBeTruthy();
  });

  it('shows load errors', async () => {
    asAdmin()
      .on('GET', '/api/admin/settings', apiError(403, 'forbidden', 'Admins only'))
      .on('GET', '/api/admin/status', apiError(500, 'internal', 'probe crashed'));
    renderAt(<AdminSettingsPage />, { path: '/admin/settings' });
    expect(await screen.findByText('Admins only')).toBeTruthy();
    expect(await screen.findByText('Could not load the status')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Users and invites
// ---------------------------------------------------------------------------

describe('AdminUsersPage', () => {
  const usersServer = () => {
    let users = [adminUser({ id: 1, username: 'root', role: 'admin', totpEnabled: true }), adminUser(), adminUser({ id: 3, username: 'bob', disabled: true, lastSeenAt: null })];
    let invites = [invite(), invite({ code: 'used1', usedBy: { id: 2, username: 'alice' }, usedAt: NOW })];
    asAdmin()
      .on('GET', '/api/admin/settings', adminSettings())
      .on('GET', '/api/admin/users', () => ({ users }))
      .on('PATCH', /^\/api\/admin\/users\/\d+$/, req => {
        const id = Number(req.path.split('/').pop());
        const patch = req.body as Record<string, unknown>;
        users = users.map(u =>
          u.id === id
            ? { ...u, ...('role' in patch ? { role: patch.role as 'admin' | 'user' } : {}), ...('disabled' in patch ? { disabled: !!patch.disabled } : {}), ...('resetTotp' in patch ? { totpEnabled: false } : {}) }
            : u,
        );
        return users.find(u => u.id === id);
      })
      .on('DELETE', /^\/api\/admin\/users\/\d+$/, req => {
        users = users.filter(u => u.id !== Number(req.path.split('/').pop()));
        return { ok: true };
      })
      .on('GET', '/api/admin/invites', () => ({ invites }))
      .on('POST', '/api/admin/invites', req => {
        const inv = invite({ code: 'fresh-777', createdAt: Date.now(), expiresAt: (req.body as { expiresInDays?: number }).expiresInDays ? Date.now() + 7 * 86_400_000 : null });
        invites = [inv, ...invites];
        return inv;
      })
      .on('DELETE', /^\/api\/admin\/invites\//, req => {
        invites = invites.filter(i => i.code !== decodeURIComponent(req.path.split('/').pop()!));
        return { ok: true };
      });
  };

  const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
  const menuAction = (name: string, action: string) => {
    fireEvent.click(within(row(name)).getByRole('button', { name: `Actions for ${name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: action }));
  };

  it('lists users with their role and state', async () => {
    usersServer();
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(within(row('root')).getByText('2FA')).toBeTruthy();
    expect(within(row('root')).getByText('(you)')).toBeTruthy();
    expect(within(row('bob')).getByText('Disabled')).toBeTruthy();
    expect(within(row('bob')).getByText('never')).toBeTruthy();
    expect(screen.getByText('3 accounts')).toBeTruthy();
    expect(document.title).toBe('Users · Admin · Outpost');
  });

  it('protects my own account and the last admin', async () => {
    usersServer();
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    await screen.findByText('alice');
    fireEvent.click(within(row('root')).getByRole('button', { name: 'Actions for root' }));
    expect((screen.getByRole('menuitem', { name: 'Make regular user' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: 'Disable account' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: 'Delete account' }) as HTMLButtonElement).disabled).toBe(true);
    // The server refuses admin resets of your own account: those go through Settings.
    const password = screen.getByRole('menuitem', { name: 'Set a new password' }) as HTMLButtonElement;
    expect(password.disabled).toBe(true);
    expect(password.title).toMatch(/Settings/);
    expect((screen.getByRole('menuitem', { name: 'Turn off two-factor' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('promotes, disables and enables users', async () => {
    usersServer();
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    await screen.findByText('alice');
    menuAction('alice', 'Make admin');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Make admin' }));
    expect(await screen.findByText('alice is now an admin.')).toBeTruthy();
    expect(api().find('PATCH', '/api/admin/users/2')[0]?.body).toEqual({ role: 'admin' });
    await waitFor(() => expect(within(row('alice')).getByText('Admin')).toBeTruthy());

    menuAction('alice', 'Disable account');
    expect(await screen.findByText('alice is disabled and signed out.')).toBeTruthy();
    expect(api().find('PATCH', '/api/admin/users/2')[1]?.body).toEqual({ disabled: true });
    menuAction('bob', 'Enable account');
    await waitFor(() => expect(api().find('PATCH', '/api/admin/users/3')[0]?.body).toEqual({ disabled: false }));
  });

  it('turns off two-factor and sets a new password', async () => {
    usersServer();
    api().on('GET', '/api/session', session(user({ id: 9, username: 'other', role: 'admin' })));
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    await screen.findByText('alice');
    menuAction('root', 'Turn off two-factor');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off two-factor' }));
    expect(await screen.findByText('Two-factor authentication is off for root.')).toBeTruthy();
    expect(api().find('PATCH', '/api/admin/users/1')[0]?.body).toEqual({ resetTotp: true });

    menuAction('alice', 'Set a new password');
    const dialog = screen.getByRole('dialog', { name: 'New password for alice' });
    fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set password' }));
    expect(await within(dialog).findByText('Use at least 8 characters.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: 'brand-new-pass' } });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), { target: { value: 'brand-new-pass' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText(/New password set for alice/)).toBeTruthy();
    expect(api().find('PATCH', '/api/admin/users/2')[0]?.body).toEqual({ password: 'brand-new-pass' });
  });

  it('deletes a user only after the name is typed', async () => {
    usersServer();
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    await screen.findByText('alice');
    menuAction('alice', 'Delete account');
    const dialog = screen.getByRole('dialog', { name: 'Delete alice?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete account' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'alic' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'alice' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('alice was deleted.')).toBeTruthy();
    expect(api().find('DELETE', '/api/admin/users/2')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('alice', { selector: '.adm-user__name *, .adm-user__name' })).toBeNull();
  });

  it('keeps the dialog open with the error when deleting fails', async () => {
    usersServer();
    api().on('DELETE', '/api/admin/users/2', apiError(409, 'conflict', 'alice owns public databases'));
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    await screen.findByText('alice');
    menuAction('alice', 'Delete account');
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'alice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    expect(await within(dialog).findByText('alice owns public databases')).toBeTruthy();
  });

  it('creates, copies and deletes invites', async () => {
    usersServer();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    expect(await screen.findByText('abc123')).toBeTruthy();
    // Used invites are tucked away.
    expect(screen.queryByText('used1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 used or expired invite' }));
    expect(screen.getByText('used1')).toBeTruthy();
    expect(screen.getByText(/Used by alice/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Expires after'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    const link = (await screen.findByRole('textbox', { name: 'Invite link' })) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/signup?invite=fresh-777`);
    expect(api().find('POST', '/api/admin/invites')[0]?.body).toEqual({ expiresInDays: 7 });
    fireEvent.click(within(link.closest('.adm-fresh') as HTMLElement).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/signup?invite=fresh-777`));
    expect(await screen.findByText('Copied')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete invite abc123' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete invite' }));
    await waitFor(() => expect(screen.queryByText('abc123')).toBeNull());
    expect(api().find('DELETE', '/api/admin/invites/abc123')).toHaveLength(1);
  });

  it('creates never-expiring invites and notes when invites are not needed', async () => {
    usersServer();
    api().on('GET', '/api/admin/settings', adminSettings({ signupMode: 'open' }));
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    expect(await screen.findByText(/Sign-up is open to anyone, so nobody needs an invite/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Expires after'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    await waitFor(() => expect(api().find('POST', '/api/admin/invites')[0]?.body).toEqual({}));
  });

  it('warns that invite links do not work while sign-up is closed, and switches to invite only', async () => {
    usersServer();
    let settings = adminSettings({ signupMode: 'closed' });
    api()
      .on('GET', '/api/admin/settings', () => settings)
      .on('PUT', '/api/admin/settings', req => {
        settings = { ...settings, ...(req.body as object) };
        return settings;
      });
    renderAt(<AdminUsersPage />, { path: '/admin/users' });
    expect(await screen.findByText(/invite links do not work until sign-up is invite-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to invite only' }));
    await waitFor(() => expect(screen.queryByText(/invite links do not work/)).toBeNull());
    expect(api().find('PUT', '/api/admin/settings')[0]?.body).toEqual({ signupMode: 'invite' });
  });
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

describe('AdminJobsPage', () => {
  const page = (jobs = [job(), job({ id: 2, status: 'error', error: 'HTTP 429 from lichess.org', finishedAt: NOW - 1000 }), job({ id: 3, status: 'done', progress: { done: 5, total: 5, message: null } })]) => ({
    total: jobs.length,
    page: 1,
    pageSize: 50,
    counts: { queued: 0, running: 1, done: 1, error: 1, cancelled: 0 },
    jobs,
  });

  it('lists jobs with counts, progress and errors', async () => {
    asAdmin().on('GET', '/api/admin/jobs', page());
    renderAt(<AdminJobsPage />, { path: '/admin/jobs' });
    expect(await screen.findByText('HTTP 429 from lichess.org')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^All 3$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Failed 1$/ })).toBeTruthy();
    expect(screen.getAllByRole('progressbar')[0]?.getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('button', { name: 'Cancel job 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry job 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run job 3 again' })).toBeTruthy();
    expect(api().find('GET', '/api/admin/jobs')[0]?.query.toString()).toBe('page=1&pageSize=50');
  });

  it('filters by status, kind and lane through the URL', async () => {
    asAdmin().on('GET', '/api/admin/jobs', page());
    const { location } = renderAt(<AdminJobsPage />, { path: '/admin/jobs' });
    await screen.findByText('HTTP 429 from lichess.org');
    fireEvent.click(screen.getByRole('button', { name: /^Failed 1$/ }));
    await waitFor(() => expect(location()).toBe('/admin/jobs?status=error'));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'broadcastMonth' } });
    fireEvent.change(screen.getByLabelText('Lane'), { target: { value: 'local' } });
    await waitFor(() => expect(location()).toBe('/admin/jobs?status=error&kind=broadcastMonth&lane=local'));
    await waitFor(() =>
      expect(api().find('GET', '/api/admin/jobs').at(-1)?.query.toString()).toBe('page=1&pageSize=50&status=error&kind=broadcastMonth&lane=local'),
    );
  });

  it('ignores unknown filter values in the URL and pages through results', async () => {
    asAdmin().on('GET', '/api/admin/jobs', req => ({ ...page(), total: 120, page: Number(req.query.get('page')) }));
    const { location } = renderAt(<AdminJobsPage />, { path: '/admin/jobs?status=bogus&page=2' });
    expect(await screen.findByText('51–100 of 120')).toBeTruthy();
    expect(api().find('GET', '/api/admin/jobs')[0]?.query.toString()).toBe('page=2&pageSize=50');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(location()).toContain('page=3'));
    fireEvent.click(await screen.findByRole('button', { name: /Previous/ }));
    await waitFor(() => expect(location()).toContain('page=2'));
  });

  it('retries and cancels, reporting conflicts', async () => {
    asAdmin()
      .on('GET', '/api/admin/jobs', page())
      .on('POST', '/api/admin/jobs/2/retry', job({ id: 7, status: 'queued' }))
      .on('POST', '/api/admin/jobs/1/cancel', apiError(409, 'conflict', 'Job 1 already finished'));
    renderAt(<AdminJobsPage />, { path: '/admin/jobs' });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry job 2' }));
    expect(await screen.findByText('Job #2 queued again as #7.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job 1' }));
    expect(await screen.findByText('Job #1: Job 1 already finished')).toBeTruthy();
  });

  it('refreshes on its own while jobs run, and can be paused', async () => {
    const saved = { ...ACCOUNT_POLL };
    ACCOUNT_POLL.jobsActiveMs = 30;
    ACCOUNT_POLL.jobsIdleMs = 60_000;
    try {
      asAdmin().on('GET', '/api/admin/jobs', page());
      renderAt(<AdminJobsPage />, { path: '/admin/jobs' });
      await screen.findByText('HTTP 429 from lichess.org');
      await waitFor(() => expect(api().find('GET', '/api/admin/jobs').length).toBeGreaterThanOrEqual(3));
      fireEvent.click(screen.getByRole('switch', { name: 'Auto-refresh' }));
      const n = api().find('GET', '/api/admin/jobs').length;
      await new Promise(r => setTimeout(r, 120));
      expect(api().find('GET', '/api/admin/jobs').length).toBe(n);
    } finally {
      Object.assign(ACCOUNT_POLL, saved);
    }
  });

  it('shows an empty state with a way to clear filters', async () => {
    asAdmin().on('GET', '/api/admin/jobs', { ...page([]), counts: { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 } });
    const { location } = renderAt(<AdminJobsPage />, { path: '/admin/jobs?lane=chesscom' });
    expect(await screen.findByText('No jobs match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(location()).toBe('/admin/jobs'));
    expect(await screen.findByText('No jobs yet')).toBeTruthy();
  });

  it('shows a load error with retry', async () => {
    asAdmin().on('GET', '/api/admin/jobs', apiError(500, 'internal', 'db is locked'));
    renderAt(<AdminJobsPage />, { path: '/admin/jobs' });
    expect(await screen.findByText('db is locked')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Reference DB
// ---------------------------------------------------------------------------

/** A stand-in for XMLHttpRequest (multipart uploads with progress). */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  private uploadListeners: Record<string, Array<(e: unknown) => void>> = {};
  upload = { addEventListener: (t: string, f: (e: unknown) => void) => (this.uploadListeners[t] ??= []).push(f) };
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.fire('abort');
  }
  progress(loaded: number, total: number) {
    for (const f of this.uploadListeners.progress ?? []) f({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.fire('load');
  }
  private fire(t: string) {
    for (const f of this.listeners[t] ?? []) f({});
  }
}

describe('AdminReferencePage', () => {
  const month = (m: string, status: BroadcastMonthStatus['status'], games = 0): BroadcastMonthStatus => ({ month: m, status, games, importedAt: status === 'imported' ? NOW : null });
  const info = (o: Partial<ReferenceInfo> = {}): ReferenceInfo => ({
    databases: [referenceDb(), referenceDb({ id: 2, name: 'Club archive', sourceLabel: null, licence: null, visibility: 'private', gameCount: 900 })],
    totalGames: 120_900,
    broadcastMonths: [month('2026-10', 'importing'), month('2026-09', 'available'), month('2026-08', 'imported', 12_345), month('2026-07', 'error'), month('2025-12', 'available')],
    attribution: ['Lichess broadcast games, CC BY-SA 4.0.'],
    ...o,
  });

  it('lists the reference databases with licences and attribution', async () => {
    asAdmin().on('GET', '/api/reference', info());
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    expect((await screen.findByRole('link', { name: 'Club archive' })).getAttribute('href')).toBe('/databases/2');
    expect(screen.getByText('120,900 games')).toBeTruthy();
    expect(screen.getAllByText('CC BY-SA 4.0')[0]).toBeTruthy();
    expect(screen.getByText('not stated')).toBeTruthy();
    expect(screen.getByText('Lichess broadcast games, CC BY-SA 4.0.')).toBeTruthy();
    expect(screen.getByText('1 of 5 months · 12,345 games')).toBeTruthy();
  });

  it('imports the chosen broadcast months', async () => {
    asAdmin()
      .on('GET', '/api/reference', info())
      .on('POST', '/api/admin/reference/broadcast-months', { jobs: [job({ id: 11 }), job({ id: 12 })] });
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    const importing = await screen.findByRole('button', { name: /^Oct 2026: Importing/ });
    expect((importing as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Sep 2026: Not imported/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Aug 2026: Imported · 12,345 games/ }));
    expect(screen.getByRole('button', { name: /^Sep 2026/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 months' }));
    expect(await screen.findByText(/2 months queued for import/)).toBeTruthy();
    expect(api().find('POST', '/api/admin/reference/broadcast-months')[0]?.body).toEqual({ months: ['2026-08', '2026-09'] });
  });

  it('selects every month not imported yet, into another database', async () => {
    asAdmin()
      .on('GET', '/api/reference', info())
      .on('POST', '/api/admin/reference/broadcast-months', { jobs: [job()] });
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    fireEvent.click(await screen.findByRole('button', { name: 'Select all not imported (3)' }));
    // The built-in database is the default choice, listed once.
    const into = screen.getByLabelText('Into') as HTMLSelectElement;
    expect([...into.options].map(o => [o.value, o.textContent])).toEqual([
      ['', 'Lichess broadcasts (built-in)'],
      ['2', 'Club archive'],
    ]);
    fireEvent.change(screen.getByLabelText('Into'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 months' }));
    await waitFor(() =>
      expect(api().find('POST', '/api/admin/reference/broadcast-months')[0]?.body).toEqual({ months: ['2025-12', '2026-07', '2026-09'], databaseId: 2 }),
    );
  });

  it('polls while an import runs', async () => {
    const saved = ACCOUNT_POLL.referenceMs;
    ACCOUNT_POLL.referenceMs = 30;
    try {
      let calls = 0;
      asAdmin().on('GET', '/api/reference', () => (++calls < 3 ? info() : info({ broadcastMonths: [month('2026-10', 'imported', 5)] })));
      renderAt(<AdminReferencePage />, { path: '/admin/reference' });
      expect(await screen.findByText('1 of 1 months · 5 games')).toBeTruthy();
      const n = calls;
      await new Promise(r => setTimeout(r, 120));
      expect(calls).toBe(n);
    } finally {
      ACCOUNT_POLL.referenceMs = saved;
    }
  });

  it('imports a PGN from a URL into a new named database', async () => {
    asAdmin()
      .on('GET', '/api/reference', info())
      .on('POST', '/api/admin/reference/import', { job: job({ id: 31, kind: 'referenceImport' }) });
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    fireEvent.click(await screen.findByRole('radio', { name: 'A URL' }));
    fireEvent.click(screen.getByRole('radio', { name: 'A new database' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Enter the address of a PGN file.')).toBeTruthy();
    expect(screen.getByText('Name the new reference database.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'ftp://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Use a full http(s):// address.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.org/twic.pgn.zst' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'TWIC' } });
    fireEvent.change(screen.getByLabelText('Licence / attribution'), { target: { value: 'With permission' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Import queued as job #31/)).toBeTruthy();
    expect(api().find('POST', '/api/admin/reference/import')[0]?.body).toEqual({
      url: 'https://example.org/twic.pgn.zst',
      databaseName: 'TWIC',
      licence: 'With permission',
    });
  });

  it('imports into a database that appeared after the page loaded', async () => {
    let created = false;
    asAdmin()
      .on('GET', '/api/reference', () => (created ? info({ databases: [referenceDb({ id: 7, gameCount: 345_678 })] }) : info({ databases: [], totalGames: 0 })))
      .on('POST', '/api/admin/reference/broadcast-months', () => {
        created = true;
        return { jobs: [job({ id: 11 })] };
      })
      .on('POST', '/api/admin/reference/import', { job: job({ id: 32, kind: 'referenceImport' }) });
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    // A fresh instance: no database yet, so the import form starts on "a new database".
    expect(await screen.findByText('No reference database yet')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'An existing database' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Sep 2026: Not imported/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 month' }));
    // The first broadcast import creates the built-in database; the page refetches.
    expect(await screen.findByRole('link', { name: 'Lichess broadcasts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'A URL' }));
    fireEvent.click(screen.getByRole('radio', { name: 'An existing database' }));
    expect((screen.getByLabelText('Reference database') as HTMLSelectElement).value).toBe('7');
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com/games.pgn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Import queued as job #32/)).toBeTruthy();
    expect(api().find('POST', '/api/admin/reference/import')[0]?.body).toEqual({ url: 'https://example.com/games.pgn', databaseId: 7 });
  });

  it('falls back to a listed database when the chosen one disappears', async () => {
    let gone = false;
    asAdmin()
      .on('GET', '/api/reference', () => (gone ? info({ databases: [referenceDb()] }) : info()))
      .on('POST', '/api/admin/reference/broadcast-months', () => {
        gone = true;
        return { jobs: [job()] };
      })
      .on('POST', '/api/admin/reference/import', { job: job({ id: 33, kind: 'referenceImport' }) });
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    fireEvent.click(await screen.findByRole('radio', { name: 'A URL' }));
    fireEvent.change(screen.getByLabelText('Reference database'), { target: { value: '2' } });
    // Something refetches the list without "Club archive" (deleted elsewhere).
    fireEvent.click(screen.getByRole('button', { name: /^Sep 2026: Not imported/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 month' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Club archive' })).toBeNull());
    expect((screen.getByLabelText('Reference database') as HTMLSelectElement).value).toBe('1');
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com/more.pgn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api().find('POST', '/api/admin/reference/import')[0]?.body).toEqual({ url: 'https://example.com/more.pgn', databaseId: 1 }));
  });

  it('explains a refused URL (no token for a broadcast round)', async () => {
    asAdmin()
      .on('GET', '/api/reference', info())
      .on(
        'POST',
        '/api/admin/reference/import',
        apiError(503, 'upstream_unavailable', 'Importing a Lichess broadcast round needs a Lichess API token', { reason: 'no_token' }),
      );
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    fireEvent.click(await screen.findByRole('radio', { name: 'A URL' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://lichess.org/broadcast/x/y/abcd1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/needs a Lichess API token/)).toBeTruthy();
  });

  it('uploads a PGN file with progress into an existing database', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    asAdmin().on('GET', '/api/reference', info());
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    await screen.findByRole('radio', { name: 'A file' });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Choose a PGN file.')).toBeTruthy();
    const file = new File(['[Event "x"]\n\n1. e4 e5 *\n'], 'games.pgn', { type: 'application/x-chess-pgn' });
    fireEvent.change(screen.getByLabelText('PGN file'), { target: { files: [file] } });
    expect(screen.getByText('games.pgn')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reference database'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Club archive 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(FakeXhr.last?.body).not.toBeNull());
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/admin/reference/import');
    expect(xhr.headers['x-outpost']).toBe('1');
    expect(xhr.body?.get('databaseId')).toBe('2');
    expect(xhr.body?.get('sourceLabel')).toBe('Club archive 2026');
    expect((xhr.body?.get('file') as File).name).toBe('games.pgn');
    xhr.progress(13, 26);
    expect(await screen.findByText(/\(50%\)/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Upload progress' }).getAttribute('aria-valuenow')).toBe('50');
    xhr.respond(200, { job: job({ id: 44, kind: 'referenceImport', status: 'queued' }) });
    expect(await screen.findByText(/Import queued as job #44/)).toBeTruthy();
  });

  it('cancels an upload and reports a too-large file', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    asAdmin().on('GET', '/api/reference', info());
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    await screen.findByRole('radio', { name: 'A file' });
    const file = new File(['x'], 'big.pgn');
    fireEvent.change(screen.getByLabelText('PGN file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel upload' }));
    expect(await screen.findByText('Upload cancelled.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('PGN file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(FakeXhr.last?.body).not.toBeNull());
    FakeXhr.last!.respond(413, { error: { code: 'payload_too_large', message: 'The upload is over 2 GB' } });
    expect(await screen.findByText('The upload is over 2 GB')).toBeTruthy();
  });

  it('shows a load error', async () => {
    asAdmin().on('GET', '/api/reference', apiError(500, 'internal', 'catalog broke'));
    renderAt(<AdminReferencePage />, { path: '/admin/reference' });
    expect(await screen.findByText('catalog broke')).toBeTruthy();
  });
});
