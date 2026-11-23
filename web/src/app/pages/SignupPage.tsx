/**
 * `/signup` (PLAN §9; §6 POST /api/signup with `SignupRequest`). Follows the instance's sign-up
 * mode from `/api/session`: `closed` says no account can be created (invite links included),
 * `invite` asks for the invite code (prefilled from `?invite=`), `open` needs no code. Success signs the
 * new user in and goes home.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import type { SessionInfo } from '@outpost/shared/api';
import { ApiError } from '../api/client.ts';
import { useSession } from '../api/hooks.ts';
import { Button, ButtonLink, EmptyState, ErrorBox, licon, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { useSignup } from './account-hooks.ts';
import {
  Flash,
  formErrors,
  newPasswordProblems,
  PASSWORD_MIN_LENGTH,
  PasswordField,
  TextField,
  USERNAME_MAX_LENGTH,
  usernameProblem,
} from './components/account/forms.tsx';
import { AuthCard, useGoTo } from './components/account/misc.tsx';

export default function SignupPage() {
  const session = useSession();
  const invite = useSearchParams()[0].get('invite');
  if (session.isPending) return <Spinner center />;
  if (session.isError) {
    return (
      <AuthCard title="Create an account">
        <ErrorBox error={session.error} onRetry={() => void session.refetch()} />
      </AuthCard>
    );
  }
  if (session.data.user) return <Navigate to={paths.home} replace />;
  if (session.data.setupRequired) {
    return (
      <AuthCard title="Create an account">
        <EmptyState icon={licon.Tools} title="This Outpost is not set up yet">
          <p>The first account is the admin account, created with the setup token from the server log.</p>
          <ButtonLink to={paths.setup} icon={licon.Gear}>
            Set up Outpost
          </ButtonLink>
        </EmptyState>
      </AuthCard>
    );
  }
  if (session.data.signupMode === 'closed') {
    return (
      <AuthCard title="Create an account">
        <EmptyState icon={licon.Padlock} title="Sign-ups are closed">
          <p>New accounts cannot be created on this Outpost at the moment.</p>
          {invite && <p>Invite links work only while sign-up is invite-only. Ask the admin who sent you this one to switch it on.</p>}
          <ButtonLink to={paths.login()} variant="secondary" icon={licon.User}>
            Sign in
          </ButtonLink>
        </EmptyState>
      </AuthCard>
    );
  }
  return <SignupForm info={session.data} />;
}

function SignupForm({ info }: { info: SessionInfo }) {
  const [params] = useSearchParams();
  const signup = useSignup();
  const goTo = useGoTo();
  const inviteMode = info.signupMode === 'invite';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState(() => params.get('invite') ?? '');
  const [problems, setProblems] = useState<Record<string, string>>({});

  const error = signup.error;
  const { field, form } = formErrors(error, ['username', 'password', 'invite'], problems);
  // A taken name (409) belongs to the username field; a refused invite (403/404) to the invite field.
  const placed = error instanceof ApiError && (error.code === 'conflict' || (inviteMode && (error.code === 'forbidden' || error.code === 'not_found')));
  if (placed && error.code === 'conflict' && !field.username) field.username = error.message || 'That username is taken.';
  if (placed && error.code !== 'conflict' && !field.invite) field.invite = error.message || 'That invite code is not valid.';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p: Record<string, string> = {};
    const name = username.trim();
    const nameProblem = usernameProblem(name);
    if (nameProblem) p.username = nameProblem;
    Object.assign(p, newPasswordProblems(password, confirm));
    if (inviteMode && !invite.trim()) p.invite = 'Enter the invite code you were given.';
    setProblems(p);
    if (Object.keys(p).length) return;
    signup.mutate(
      { username: name, password, ...(inviteMode && invite.trim() ? { invite: invite.trim() } : {}) },
      { onSuccess: () => goTo(paths.home) },
    );
  };

  // Messages placed at a field are not repeated above the button.
  const formMessage = placed ? null : form;

  return (
    <AuthCard
      title="Create an account"
      intro={
        inviteMode ? (
          <p>Sign-ups on this Outpost need an invite code from its admin.</p>
        ) : (
          <p>Track your own games, prepare against opponents and keep your studies in one place.</p>
        )
      }
      footer={
        <span>
          Already have an account? <Link to={paths.login()}>Sign in</Link>
        </span>
      }
    >
      <form onSubmit={submit} noValidate className="acc-form" aria-label="Create an account">
        {inviteMode && (
          <TextField
            label="Invite code"
            name="invite"
            autoComplete="off"
            spellCheck={false}
            className="acc-mono-field"
            value={invite}
            onChange={e => setInvite(e.target.value)}
            error={field.invite}
          />
        )}
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          maxLength={USERNAME_MAX_LENGTH}
          value={username}
          onChange={e => setUsername(e.target.value)}
          help="2–30 letters, digits, _ or -. Shown to the other users of this Outpost."
          error={field.username}
        />
        <PasswordField
          label="Password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          help={`At least ${PASSWORD_MIN_LENGTH} characters.`}
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
        {formMessage && <Flash kind="failure">{formMessage}</Flash>}
        <div className="acc-actions">
          <Button type="submit" icon={licon.PlusButton} disabled={signup.isPending} className="acc-submit">
            {signup.isPending ? 'Creating…' : 'Create account'}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
