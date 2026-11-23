/**
 * `/login` (PLAN §9; §6 POST /api/login with `LoginRequest`). Two steps when the account has
 * TOTP on: username + password, then — after `401 totp_required` — the six-digit code, sent
 * together with the password again. On success the session is replaced and the browser goes to
 * `?next=` (same-origin paths only; the Studio gets a full page load) or home.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SessionInfo } from '@outpost/shared/api';
import { ApiError } from '../api/client.ts';
import { useSession } from '../api/hooks.ts';
import { Button, ErrorBox, licon, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { useLogin } from './account-hooks.ts';
import { Flash, formErrors, PasswordField, TextField } from './components/account/forms.tsx';
import { AuthCard, GoTo, safeNext, useGoTo } from './components/account/misc.tsx';

export default function LoginPage() {
  const session = useSession();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  if (session.isPending) return <Spinner center />;
  if (session.isError) {
    return (
      <AuthCard title="Sign in">
        <ErrorBox error={session.error} onRetry={() => void session.refetch()} />
      </AuthCard>
    );
  }
  if (session.data.user) return <GoTo to={next} />;
  return <LoginForm info={session.data} next={next} />;
}

function LoginForm({ info, next }: { info: SessionInfo; next: string }) {
  const login = useLogin();
  const goTo = useGoTo();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [missing, setMissing] = useState<Record<string, string>>({});
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'totp') codeRef.current?.focus();
  }, [step]);

  const error = login.error;
  const needsTotp = error instanceof ApiError && error.code === 'totp_required';
  // `totp_required` is the cue for the second step (or, on it, a rejected code shown at the field).
  const shownError = needsTotp ? null : error;
  const { field, form } = formErrors(shownError, ['username', 'password', 'totp'], missing);
  const badCredentials = shownError instanceof ApiError && shownError.code === 'unauthorized';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!username.trim()) problems.username = 'Enter your username.';
    if (!password) problems.password = 'Enter your password.';
    const code = totp.replace(/\s+/g, '');
    if (step === 'totp' && !/^\d{6}$/.test(code)) problems.totp = 'Enter the 6-digit code from your authenticator app.';
    setMissing(problems);
    if (Object.keys(problems).length) return;
    login.mutate(
      { username: username.trim(), password, ...(step === 'totp' ? { totp: code } : {}) },
      {
        onSuccess: () => goTo(next),
        onError: err => {
          if (err instanceof ApiError && err.code === 'totp_required') {
            if (step === 'totp') setMissing({ totp: 'That code was not accepted. Codes change every 30 seconds; try the current one.' });
            setStep('totp');
            setTotp('');
          }
        },
      },
    );
  };

  const footer = (
    <>
      {info.signupMode !== 'closed' && (
        <span>
          New here? <Link to={paths.signup()}>Create an account</Link>
        </span>
      )}
      <span className="muted">Forgot your password? Ask the admin of this Outpost to reset it.</span>
    </>
  );

  return (
    <AuthCard title="Sign in" footer={footer}>
      {info.setupRequired && (
        <Flash kind="warning">
          This Outpost has no admin yet. <Link to={paths.setup}>Create the first admin account</Link>.
        </Flash>
      )}
      <form onSubmit={submit} noValidate className="acc-form" aria-label="Sign in">
        {step === 'password' ? (
          <>
            <TextField
              label="Username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              error={field.username}
            />
            <PasswordField
              label="Password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              error={field.password}
            />
          </>
        ) : (
          <>
            <p className="acc-lead">
              <i data-icon={licon.Padlock} aria-hidden /> Two-factor authentication is on for <strong>{username.trim()}</strong>.
              Enter the code from your authenticator app.
            </p>
            <TextField
              ref={codeRef}
              label="Authentication code"
              name="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={7}
              placeholder="123456"
              className="acc-code-field"
              value={totp}
              onChange={e => setTotp(e.target.value)}
              error={field.totp}
            />
          </>
        )}
        {form && (
          <Flash kind="failure">
            {badCredentials && step === 'password' ? 'Wrong username or password.' : form}
          </Flash>
        )}
        <div className="acc-actions">
          {step === 'totp' && (
            <Button
              variant="secondary"
              onClick={() => {
                setStep('password');
                setTotp('');
                setMissing({});
                login.reset();
              }}
            >
              Back
            </Button>
          )}
          <Button type="submit" icon={licon.User} disabled={login.isPending} className="acc-submit">
            {login.isPending ? 'Signing in…' : step === 'totp' ? 'Verify and sign in' : 'Sign in'}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
