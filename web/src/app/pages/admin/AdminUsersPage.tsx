/**
 * `/admin/users` (PLAN §6 GET /api/admin/users, PATCH/DELETE /api/admin/users/:id, GET/POST/DELETE
 * /api/admin/invites): the accounts of this Outpost — role, disable, reset password or two-factor,
 * delete (typed confirmation) — and the invite links used when sign-up is invite-only.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AdminUser, Invite, SessionUser } from '@outpost/shared/api';
import { useSession } from '../../api/hooks.ts';
import { Box, Button, EmptyState, ErrorBox, licon, Spinner, Table, useDocumentTitle, type Column } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import {
  useAdminSettings,
  useAdminUsers,
  useCreateInvite,
  useDeleteAdminUser,
  useDeleteInvite,
  useInvites,
  useUpdateAdminSettings,
  useUpdateAdminUser,
} from '../account-hooks.ts';
import { ConfirmDialog, Modal } from '../components/account/Dialog.tsx';
import { relativeTime, useTimeFormat } from '../components/account/format.ts';
import { describeError, Flash, formErrors, newPasswordProblems, PASSWORD_MIN_LENGTH, PasswordField } from '../components/account/forms.tsx';
import { inviteLink, inviteState } from '../components/account/invites.ts';
import { CopyButton, RowMenu, type RowAction } from '../components/account/misc.tsx';
import './admin.css';

type Dialog =
  | { kind: 'delete'; user: AdminUser }
  | { kind: 'password'; user: AdminUser }
  | { kind: 'totp'; user: AdminUser }
  | { kind: 'role'; user: AdminUser; role: AdminUser['role'] }
  | null;

export default function AdminUsersPage() {
  useDocumentTitle('Users · Admin');
  const me = useSession().data?.user ?? null;
  return (
    <>
      <UsersBox me={me} />
      <InvitesBox />
    </>
  );
}

function UsersBox({ me }: { me: SessionUser | null }) {
  const users = useAdminUsers();
  const update = useUpdateAdminUser();
  const remove = useDeleteAdminUser();
  const fmt = useTimeFormat();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'failure'; text: string } | null>(null);

  const patch = (user: AdminUser, body: Parameters<typeof update.mutate>[0]['patch'], done: string) => {
    setMessage(null);
    update.mutate(
      { id: user.id, patch: body },
      {
        onSuccess: () => setMessage({ kind: 'success', text: done }),
        onError: e => setMessage({ kind: 'failure', text: `${user.username}: ${describeError(e)}` }),
      },
    );
  };

  const list = users.data?.users ?? [];
  const admins = list.filter(u => u.role === 'admin' && !u.disabled).length;

  const columns: Column<AdminUser>[] = [
    {
      key: 'user',
      header: 'User',
      render: u => (
        <div className="adm-user">
          <span className="adm-user__name">
            <i data-icon={u.role === 'admin' ? licon.Crown : licon.User} aria-hidden />
            {u.username}
            {u.id === me?.id && <span className="muted"> (you)</span>}
          </span>
          <span className="adm-user__tags">
            {u.role === 'admin' && <span className="acc-badge acc-badge--running">Admin</span>}
            {u.disabled && <span className="acc-badge acc-badge--error">Disabled</span>}
            {u.totpEnabled && (
              <span className="acc-badge acc-badge--done" title="Two-factor authentication is on">
                2FA
              </span>
            )}
          </span>
        </div>
      ),
    },
    {
      key: 'profiles',
      header: 'Profiles',
      align: 'num',
      hideBelow: 520,
      render: u => u.profileCount,
    },
    {
      key: 'seen',
      header: 'Last seen',
      hideBelow: 700,
      render: u => (u.lastSeenAt ? <span title={fmt.dateTime(u.lastSeenAt)}>{relativeTime(u.lastSeenAt)}</span> : <span className="muted">never</span>),
    },
    {
      key: 'created',
      header: 'Joined',
      hideBelow: 860,
      render: u => <span title={fmt.dateTime(u.createdAt)}>{fmt.date(u.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="acc-sr">Actions</span>,
      align: 'right',
      render: u => {
        const self = u.id === me?.id;
        const lastAdmin = u.role === 'admin' && !u.disabled && admins <= 1;
        const actions: RowAction[] = [
          u.role === 'admin'
            ? {
                label: 'Make regular user',
                icon: licon.User,
                disabled: self || lastAdmin,
                title: self ? 'You cannot change your own role' : lastAdmin ? 'The last admin cannot be demoted' : undefined,
                onSelect: () => setDialog({ kind: 'role', user: u, role: 'user' }),
              }
            : { label: 'Make admin', icon: licon.Crown, onSelect: () => setDialog({ kind: 'role', user: u, role: 'admin' }) },
          u.disabled
            ? { label: 'Enable account', icon: licon.Checkmark, onSelect: () => patch(u, { disabled: false }, `${u.username} can sign in again.`) }
            : {
                label: 'Disable account',
                icon: licon.NotAllowed,
                disabled: self || lastAdmin,
                title: self ? 'You cannot disable yourself' : lastAdmin ? 'The last admin cannot be disabled' : undefined,
                onSelect: () => patch(u, { disabled: true }, `${u.username} is disabled and signed out.`),
              },
          // Your own password and two-factor change in Settings, with your current password (the
          // server refuses an admin reset of your own account).
          {
            label: 'Set a new password',
            icon: licon.Padlock,
            disabled: self,
            title: self ? 'Change your own password in Settings → Password' : undefined,
            onSelect: () => setDialog({ kind: 'password', user: u }),
          },
          ...(u.totpEnabled
            ? [
                {
                  label: 'Turn off two-factor',
                  icon: licon.Shield,
                  disabled: self,
                  title: self ? 'Turn off your own two-factor in Settings → Two-factor' : undefined,
                  onSelect: () => setDialog({ kind: 'totp', user: u }),
                } satisfies RowAction,
              ]
            : []),
          {
            label: 'Delete account',
            icon: licon.Trash,
            danger: true,
            disabled: self,
            title: self ? 'You cannot delete your own account here' : undefined,
            onSelect: () => setDialog({ kind: 'delete', user: u }),
          },
        ];
        return <RowMenu label={`Actions for ${u.username}`} actions={actions} />;
      },
    },
  ];

  return (
    <Box
      title="Users"
      level={2}
      pad={false}
      actions={users.data && <span className="muted">{list.length} account{list.length === 1 ? '' : 's'}</span>}
    >
      {message && (
        <div className="adm-pad">
          <Flash kind={message.kind}>{message.text}</Flash>
        </div>
      )}
      {users.isPending ? (
        <Spinner center />
      ) : users.isError ? (
        <div className="adm-pad">
          <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
        </div>
      ) : (
        <Table
          className="adm-users"
          columns={columns}
          rows={[...list].sort((a, b) => a.username.localeCompare(b.username))}
          rowKey={u => u.id}
          empty={<EmptyState icon={licon.Group} title="No users yet" />}
        />
      )}

      {dialog?.kind === 'role' && (
        <ConfirmDialog
          title={dialog.role === 'admin' ? `Make ${dialog.user.username} an admin?` : `Make ${dialog.user.username} a regular user?`}
          confirmLabel={dialog.role === 'admin' ? 'Make admin' : 'Make regular user'}
          variant="primary"
          icon={dialog.role === 'admin' ? licon.Crown : licon.User}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await update.mutateAsync({ id: dialog.user.id, patch: { role: dialog.role } });
            setMessage({ kind: 'success', text: `${dialog.user.username} is now ${dialog.role === 'admin' ? 'an admin' : 'a regular user'}.` });
          }}
        >
          <p>
            {dialog.role === 'admin'
              ? 'Admins manage users, invites, instance settings, jobs and the reference database, and can edit every profile.'
              : 'They keep their account and profiles, without access to the admin pages.'}
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'totp' && (
        <ConfirmDialog
          title={`Turn off two-factor for ${dialog.user.username}?`}
          confirmLabel="Turn off two-factor"
          icon={licon.Shield}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await update.mutateAsync({ id: dialog.user.id, patch: { resetTotp: true } });
            setMessage({ kind: 'success', text: `Two-factor authentication is off for ${dialog.user.username}.` });
          }}
        >
          <p>Use this when they lost their authenticator. They sign in with the password alone and can set it up again.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${dialog.user.username}?`}
          confirmLabel="Delete account"
          typeToConfirm={dialog.user.username}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await remove.mutateAsync(dialog.user.id);
            setMessage({ kind: 'success', text: `${dialog.user.username} was deleted.` });
          }}
        >
          <p>
            This permanently deletes the account and signs it out everywhere. It cannot be undone.
            {dialog.user.profileCount > 0 && (
              <>
                {' '}
                They own {dialog.user.profileCount} profile{dialog.user.profileCount === 1 ? '' : 's'}.
              </>
            )}
          </p>
          <p className="muted">To keep the account but stop it from signing in, disable it instead.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'password' && (
        <PasswordDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={() => setMessage({ kind: 'success', text: `New password set for ${dialog.user.username}; their sessions were ended.` })}
        />
      )}
    </Box>
  );
}

function PasswordDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const update = useUpdateAdminUser();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const { field, form } = formErrors(update.error, ['password'], problems);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = newPasswordProblems(password, confirm);
    setProblems({ ...(p.password ? { password: p.password } : {}), ...(p.confirm ? { confirm: p.confirm } : {}) });
    if (p.password || p.confirm) return;
    update.mutate(
      { id: user.id, patch: { password } },
      {
        onSuccess: () => {
          onDone();
          onClose();
        },
      },
    );
  };

  return (
    <Modal title={`New password for ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="acc-form" aria-label={`New password for ${user.username}`}>
        <p className="muted">This signs {user.username} out everywhere. Give them the new password through a safe channel.</p>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          help={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={field.password}
        />
        <PasswordField label="Confirm password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} error={field.confirm} />
        {form && <Flash kind="failure">{form}</Flash>}
        <div className="acc-actions">
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" icon={licon.Padlock} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Set password'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const EXPIRY_OPTIONS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 0, label: 'Never' },
] as const;

function InvitesBox() {
  const invites = useInvites();
  const create = useCreateInvite();
  const remove = useDeleteInvite();
  const settings = useAdminSettings();
  const openInvites = useUpdateAdminSettings();
  const fmt = useTimeFormat();
  const [days, setDays] = useState<number>(7);
  const [fresh, setFresh] = useState<Invite | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Invite | null>(null);
  const [showUsed, setShowUsed] = useState(false);

  const all = invites.data?.invites ?? [];
  const now = Date.now();
  const visible = all.filter(i => showUsed || inviteState(i, now) === 'open').sort((a, b) => b.createdAt - a.createdAt);
  const hidden = all.length - visible.length;
  const mode = settings.data?.signupMode;

  const columns: Column<Invite>[] = [
    {
      key: 'code',
      header: 'Invite',
      render: i => (
        <div className="adm-invite">
          <code className="adm-invite__code">{i.code}</code>
          <span className="adm-invite__state">
            {inviteState(i, now) === 'used' ? (
              <span className="muted">
                Used{i.usedBy ? ` by ${i.usedBy.username}` : ''}
                {i.usedAt ? ` ${relativeTime(i.usedAt, now)}` : ''}
              </span>
            ) : inviteState(i, now) === 'expired' ? (
              <span className="bad">Expired</span>
            ) : (
              <span className="good">{i.expiresAt ? `Expires ${relativeTime(i.expiresAt, now)}` : 'Never expires'}</span>
            )}
          </span>
        </div>
      ),
    },
    {
      key: 'by',
      header: 'Created',
      hideBelow: 640,
      render: i => (
        <span title={fmt.dateTime(i.createdAt)}>
          {fmt.date(i.createdAt)}
          {i.createdBy && <span className="muted"> by {i.createdBy.username}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="acc-sr">Actions</span>,
      align: 'right',
      render: i => (
        <div className="adm-invite__actions">
          {inviteState(i, now) === 'open' && <CopyButton text={inviteLink(i.code)} label="Copy link" />}
          <Button variant="empty" size="sm" icon={licon.Trash} aria-label={`Delete invite ${i.code}`} title="Delete invite" onClick={() => setConfirmDelete(i)} />
        </div>
      ),
    },
  ];

  return (
    <Box title="Invites" level={2} pad={false}>
      <div className="adm-pad">
        {mode === 'closed' && (
          <Flash kind="warning" className="adm-flash-action">
            <span>
              Sign-up is <strong>closed</strong>: nobody can create an account, so invite links do not work until sign-up is
              invite-only.
            </span>{' '}
            <Button
              size="sm"
              variant="secondary"
              icon={licon.Envelope}
              disabled={openInvites.isPending}
              onClick={() => openInvites.mutate({ signupMode: 'invite' })}
            >
              {openInvites.isPending ? 'Switching…' : 'Switch to invite only'}
            </Button>
            {openInvites.isError && <span className="bad"> {describeError(openInvites.error)}</span>}
          </Flash>
        )}
        {mode === 'open' && (
          <Flash kind="quiet">
            Sign-up is open to anyone, so nobody needs an invite. Links you create here only matter once sign-up is invite-only
            (change it in <Link to={paths.admin.settings}>Settings</Link>).
          </Flash>
        )}
        <form
          className="adm-invite-form"
          onSubmit={e => {
            e.preventDefault();
            setFresh(null);
            create.mutate(days > 0 ? { expiresInDays: days } : {}, { onSuccess: inv => setFresh(inv) });
          }}
        >
          <label htmlFor="adm-invite-expiry">Expires after</label>
          <select id="adm-invite-expiry" className="form-control" value={days} onChange={e => setDays(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map(o => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
          <Button type="submit" icon={licon.PlusButton} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create invite'}
          </Button>
        </form>
        {create.isError && <Flash kind="failure">Could not create the invite: {describeError(create.error)}</Flash>}
        {fresh && (
          <div className="adm-fresh" role="status">
            <span>New invite link{fresh.expiresAt ? ` (expires ${fmt.dateTime(fresh.expiresAt)})` : ''}:</span>
            <input className="form-control acc-mono" readOnly value={inviteLink(fresh.code)} onFocus={e => e.currentTarget.select()} aria-label="Invite link" />
            <CopyButton text={inviteLink(fresh.code)} label="Copy link" size="md" />
          </div>
        )}
        {remove.isError && <Flash kind="failure">Could not delete the invite: {describeError(remove.error)}</Flash>}
      </div>
      {invites.isPending ? (
        <Spinner center />
      ) : invites.isError ? (
        <div className="adm-pad">
          <ErrorBox error={invites.error} onRetry={() => void invites.refetch()} />
        </div>
      ) : (
        <Table
          className="adm-invites"
          columns={columns}
          rows={visible}
          rowKey={i => i.code}
          empty={<EmptyState icon={licon.Envelope} title={all.length ? 'No open invites' : 'No invites yet'} />}
        />
      )}
      {hidden > 0 || showUsed ? (
        <div className="adm-pad adm-pad--top">
          <Button variant="empty" size="sm" onClick={() => setShowUsed(s => !s)}>
            {showUsed ? 'Hide used and expired invites' : `Show ${hidden} used or expired invite${hidden === 1 ? '' : 's'}`}
          </Button>
        </div>
      ) : null}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this invite?"
          confirmLabel="Delete invite"
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => {
            await remove.mutateAsync(confirmDelete.code);
            if (fresh?.code === confirmDelete.code) setFresh(null);
          }}
        >
          <p>
            The link with code <code>{confirmDelete.code}</code> stops working.
            {inviteState(confirmDelete) === 'used' && ' The account created with it is not affected.'}
          </p>
        </ConfirmDialog>
      )}
    </Box>
  );
}
