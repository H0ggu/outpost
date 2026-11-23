/**
 * `/setup` (PLAN §9, §10; §6 POST /api/setup with `SetupRequest`): creates the first admin with
 * the one-time setup token (SETUP_TOKEN, or the one Outpost printed to its log). Once an admin
 * exists the page only points to sign-in. Success signs the admin in and opens the instance
 * settings.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useSession } from '../api/hooks.ts';
import { Button, ButtonLink, EmptyState, ErrorBox, licon, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { useSetup } from './account-hooks.ts';
import { Flash, formErrors, newPasswordProblems, PASSWORD_MIN_LENGTH, PasswordField, TextField } from './components/account/forms.tsx';
import { AuthCard, useGoTo } from './components/account/misc.tsx';

export default function SetupPage() {
  const session = useSession();
  if (session.isPending) return <Spinner center />;
  if (session.isError) {
    return (
      <AuthCard title="Set up Outpost">
        <ErrorBox error={session.error} onRetry={() => void session.refetch()} />
      </AuthCard>
    );
  }
  if (!session.data.setupRequired) {
    const user = session.data.user;
    return (
      <AuthCard title="Set up Outpost">
        <EmptyState icon={licon.Checkmark} title="This Outpost is already set up">
          <p>An admin account exists. {user ? 'You are signed in.' : 'Sign in to continue.'}</p>
          {user ? (
            <ButtonLink to={user.role === 'admin' ? paths.admin.settings : paths.home} icon={licon.Forward}>
              {user.role === 'admin' ? 'Instance settings' : 'Home'}
            </ButtonLink>
          ) : (
            <ButtonLink to={paths.login()} icon={licon.User}>
              Sign in
            </ButtonLink>
          )}
        </EmptyState>
      </AuthCard>
    );
  }
  return <SetupForm />;
}

function SetupForm() {
  const setup = useSetup();
  const goTo = useGoTo();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});

  const error = setup.error;
  const { field, form } = formErrors(error, ['token', 'username', 'password'], problems);
  // A wrong token is refused with 401/403: show it at the token field.
  const tokenRefused = error instanceof ApiError && (error.code === 'forbidden' || error.code === 'unauthorized');
  if (tokenRefused && !field.token) field.token = error.message || 'That setup token is not valid.';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p: Record<string, string> = {};
    if (!token.trim()) p.token = 'Paste the setup token from the server log.';
    if (!username.trim()) p.username = 'Choose a username.';
    else if (username.trim().length < 2) p.username = 'Use at least 2 characters.';
    Object.assign(p, newPasswordProblems(password, confirm));
    setProblems(p);
    if (Object.keys(p).length) return;
    setup.mutate({ token: token.trim(), username: username.trim(), password }, { onSuccess: () => goTo(paths.admin.settings) });
  };

  return (
    <AuthCard
      title="Set up Outpost"
      intro={
        <>
          <p>Create the first account. It becomes the admin of this Outpost: it manages users, invites and instance settings.</p>
          <p className="acc-help">
            The setup token is the <code>SETUP_TOKEN</code> environment variable, or the one-time token Outpost printed to its log
            at start-up (for Docker: <code>docker compose logs outpost</code>). It stops working once the admin exists.
          </p>
        </>
      }
      footer={
        <span>
          Already set up? <Link to={paths.login()}>Sign in</Link>
        </span>
      }
    >
      <form onSubmit={submit} noValidate className="acc-form" aria-label="Create the admin account">
        <TextField
          label="Setup token"
          name="token"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoFocus
          className="acc-mono-field"
          value={token}
          onChange={e => setToken(e.target.value)}
          error={field.token}
        />
        <TextField
          label="Admin username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          value={username}
          onChange={e => setUsername(e.target.value)}
          error={field.username}
        />
        <PasswordField
          label="Password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          help={`At least ${PASSWORD_MIN_LENGTH} characters. Turn on two-factor authentication in your settings afterwards.`}
          error={field.password}
        />
        <PasswordField
          label="Confirm password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          error={field.confirm}
        />
        {form && !tokenRefused && <Flash kind="failure">{form}</Flash>}
        <div className="acc-actions">
          <Button type="submit" icon={licon.Checkmark} disabled={setup.isPending} className="acc-submit">
            {setup.isPending ? 'Creating…' : 'Create admin account'}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
