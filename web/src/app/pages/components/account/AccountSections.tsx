/**
 * Account sections of /settings (PLAN §6, §10): change password, two-factor authentication
 * (TOTP: the current password, then a QR code + confirmation code to turn it on; the password or
 * a current code to turn it off) and the list of signed-in sessions with revoke.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { SessionRow, SessionUser } from '@outpost/shared/api';
import { ApiError } from '../../../api/client.ts';
import { Box, Button, EmptyState, ErrorBox, licon, Spinner } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { useChangePassword, useMySessions, useRevokeSession, useTotpChange, useTotpSetup, type TotpSetupResult } from '../../account-hooks.ts';
import { ConfirmDialog } from './Dialog.tsx';
import { describeUserAgent, relativeTime, useTimeFormat } from './format.ts';
import { Flash, formErrors, newPasswordProblems, PASSWORD_MIN_LENGTH, PasswordField, TextField } from './forms.tsx';
import { CopyButton } from './misc.tsx';
import './account.css';

/** A wrong current password comes back as 401/403; show it at that field. */
const wrongPassword = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === 'forbidden' || (error.code === 'unauthorized' && /password/i.test(error.message)));

/** A rejected TOTP code (401/403/400 mentioning the code). */
const wrongCode = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === 'totp_required' || ((error.code === 'forbidden' || error.code === 'unauthorized' || error.code === 'bad_request') && /code|totp/i.test(error.message)));

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

export function PasswordSection({ username }: { username: string }) {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const error = change.error;
  const { field, form } = formErrors(error, ['currentPassword', 'newPassword'], problems);
  const badCurrent = wrongPassword(error);
  if (badCurrent && !field.currentPassword) field.currentPassword = error instanceof ApiError ? error.message : 'Wrong password.';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    const p: Record<string, string> = {};
    if (!current) p.currentPassword = 'Enter your current password.';
    const np = newPasswordProblems(next, confirm);
    if (np.password) p.newPassword = np.password;
    else if (next === current) p.newPassword = 'Choose a password different from the current one.';
    if (np.confirm) p.confirm = np.confirm;
    setProblems(p);
    if (Object.keys(p).length) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          setDone(true);
        },
      },
    );
  };

  return (
    <Box title="Change password" level={2}>
      <form onSubmit={submit} noValidate className="acc-form acc-form--narrow" aria-label="Change password">
        {/* Lets password managers pair the new password with this account. */}
        <UsernameHint username={username} />
        <PasswordField
          label="Current password"
          name="current-password"
          autoComplete="current-password"
          value={current}
          onChange={e => setCurrent(e.target.value)}
          error={field.currentPassword}
        />
        <PasswordField
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={next}
          onChange={e => setNext(e.target.value)}
          help={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={field.newPassword}
        />
        <PasswordField
          label="Confirm new password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          error={field.confirm}
        />
        {form && !badCurrent && <Flash kind="failure">{form}</Flash>}
        {done && <Flash>Password changed. Other devices may have to sign in again.</Flash>}
        <div className="acc-actions acc-actions--start">
          <Button type="submit" icon={licon.Padlock} disabled={change.isPending}>
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </div>
      </form>
    </Box>
  );
}

/** Off-screen username field, so password managers know which account the new password is for. */
function UsernameHint({ username }: { username: string }) {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={username}
      readOnly
      tabIndex={-1}
      aria-hidden
      className="visually-hidden"
    />
  );
}

// ---------------------------------------------------------------------------
// Two-factor authentication
// ---------------------------------------------------------------------------

/** Base32 secret in groups of four for manual entry. */
export const groupSecret = (secret: string): string => secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/** The server's SVG QR code as an image (an <img> cannot run anything inside the SVG). */
const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The QR code to show: the server's PNG when it sends one (a data: URL only), else its SVG. */
export const totpQrSrc = (setup: TotpSetupResult): string =>
  setup.qrDataUrl && /^data:image\/(png|svg\+xml|gif|webp)[;,]/.test(setup.qrDataUrl) ? setup.qrDataUrl : svgDataUrl(setup.qrSvg);

export function TotpSection({ user }: { user: SessionUser }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Box
      title="Two-factor authentication"
      level={2}
      actions={
        user.totpEnabled ? (
          <span className="acc-badge acc-badge--done">
            <i data-icon={licon.Checkmark} aria-hidden /> On
          </span>
        ) : (
          <span className="acc-badge acc-badge--cancelled">Off</span>
        )
      }
    >
      <p className="acc-lead">
        Ask for a code from an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…) after the password when signing
        in.
      </p>
      {message && <Flash>{message}</Flash>}
      {/* The confirmation lives here: the form that turned it on or off is replaced by the other one. */}
      {user.totpEnabled ? (
        <TotpDisable username={user.username} onDone={() => setMessage('Two-factor authentication is off.')} />
      ) : (
        <TotpEnable
          username={user.username}
          onStart={() => setMessage(null)}
          onDone={() => setMessage('Two-factor authentication is on. You will need a code the next time you sign in.')}
        />
      )}
    </Box>
  );
}

function TotpEnable({ username, onStart, onDone }: { username: string; onStart: () => void; onDone: () => void }) {
  const setup = useTotpSetup();
  const change = useTotpChange();
  const [pending, setPending] = useState<TotpSetupResult | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (!pending) {
    const passwordRefused = wrongPassword(setup.error);
    const passwordError =
      problem ?? (passwordRefused ? (setup.error instanceof ApiError && setup.error.message) || 'Wrong password.' : undefined);
    const start = (e: FormEvent) => {
      e.preventDefault();
      if (!password) {
        setProblem('Enter your password.');
        return;
      }
      setProblem(null);
      onStart();
      setup.mutate(
        { password },
        {
          onSuccess: res => {
            setPending(res);
            setPassword('');
            setCode('');
            change.reset();
          },
        },
      );
    };
    return (
      <form className="acc-form acc-form--narrow" onSubmit={start} noValidate aria-label="Set up two-factor authentication">
        <UsernameHint username={username} />
        <PasswordField
          label="Current password"
          name="current-password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          help="Confirm it is you before adding an authenticator."
          error={passwordError}
        />
        {setup.isError && !passwordRefused && <ErrorBox error={setup.error} title="Could not start the setup" />}
        <div className="acc-actions acc-actions--start">
          <Button type="submit" icon={licon.Padlock} disabled={setup.isPending}>
            {setup.isPending ? 'Preparing…' : 'Set up two-factor authentication'}
          </Button>
        </div>
      </form>
    );
  }

  const error = change.error;
  const { field, form } = formErrors(error, ['code'], { code: problem });
  const codeRefused = wrongCode(error);
  if (codeRefused && !field.code) field.code = 'That code was not accepted. Check the time on your phone and try the current code.';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c)) {
      setProblem('Enter the 6-digit code shown by the app.');
      return;
    }
    setProblem(null);
    // Turning it on swaps this form for TotpDisable before the session refetch ends: the
    // promise still settles, a per-call onSuccess would not run.
    change.mutateAsync({ action: 'enable', code: c }).then(
      () => {
        setPending(null);
        onDone();
      },
      () => undefined,
    );
  };

  return (
    <form className="acc-totp" onSubmit={submit} noValidate aria-label="Turn on two-factor authentication">
      <ol className="acc-steps">
        <li>
          <strong>Scan the QR code</strong> with your authenticator app.
          <div className="acc-totp__qr">
            <img src={totpQrSrc(pending)} alt="QR code for your authenticator app" width={200} height={200} />
          </div>
          <div className="acc-totp__manual">
            <span className="muted">Or enter this key by hand:</span>
            <code className="acc-totp__secret" aria-label="Secret key">
              {groupSecret(pending.secret)}
            </code>
            <CopyButton text={pending.secret.replace(/\s+/g, '')} label="Copy key" />
            <a className="acc-quiet-link" href={pending.otpauthUrl}>
              Open in an authenticator app on this device
            </a>
          </div>
        </li>
        <li>
          <strong>Enter the 6-digit code</strong> the app shows for Outpost.
          <TextField
            label="Authentication code"
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={7}
            placeholder="123456"
            className="acc-code-field"
            value={code}
            onChange={e => setCode(e.target.value)}
            help={pending.expiresAt ? `Confirm ${relativeTime(pending.expiresAt)}, or start again.` : undefined}
            error={field.code}
          />
        </li>
      </ol>
      {form && !codeRefused && <Flash kind="failure">{form}</Flash>}
      <div className="acc-actions acc-actions--start">
        <Button type="submit" icon={licon.Checkmark} disabled={change.isPending}>
          {change.isPending ? 'Checking…' : 'Turn on'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setPending(null);
            setProblem(null);
            setup.reset();
          }}
          disabled={change.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Which proof the last "turn off" attempt sent, to put a refusal next to it. */
type DisableProof = 'password' | 'code' | 'both';

function TotpDisable({ username, onDone }: { username: string; onDone: () => void }) {
  const change = useTotpChange();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<DisableProof | null>(null);

  const error = change.error;
  const { field, form } = formErrors(error, ['password', 'code'], problems);
  // A refusal (403) is about whichever proof was sent; with both, it stays above the button.
  const refused = error instanceof ApiError && (error.code === 'forbidden' || error.code === 'unauthorized' || error.code === 'totp_required');
  const refusedAt = refused && sent !== 'both' ? sent : null;
  if (refusedAt === 'password' && !field.password) field.password = (error as ApiError).message || 'Wrong password.';
  if (refusedAt === 'code' && !field.code) field.code = (error as ApiError).message || 'That code was not accepted.';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p: Record<string, string> = {};
    const c = code.replace(/\s+/g, '');
    if (!password && !c) p.password = 'Enter your password or a current code.';
    if (c && !/^\d{6}$/.test(c)) p.code = 'Enter the current 6-digit code.';
    setProblems(p);
    if (Object.keys(p).length) return;
    setSent(password && c ? 'both' : password ? 'password' : 'code');
    // Turning it off swaps this form for TotpEnable before the session refetch ends (see above).
    change.mutateAsync({ action: 'disable', password, code: c }).then(onDone, () => undefined);
  };

  return (
    <form className="acc-form acc-form--narrow" onSubmit={submit} noValidate aria-label="Turn off two-factor authentication">
      <p className="muted">
        To turn it off, confirm with your password <strong>or</strong> a current code from your authenticator app.
      </p>
      <UsernameHint username={username} />
      <PasswordField
        label="Password"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        error={field.password}
      />
      <TextField
        label="Authentication code"
        name="totp"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        placeholder="123456"
        className="acc-code-field"
        value={code}
        onChange={e => setCode(e.target.value)}
        help="Lost your authenticator? The password alone is enough."
        error={field.code}
      />
      {form && !refusedAt && <Flash kind="failure">{form}</Flash>}
      <div className="acc-actions acc-actions--start">
        <Button type="submit" variant="red" icon={licon.X} disabled={change.isPending}>
          {change.isPending ? 'Turning off…' : 'Turn off two-factor authentication'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function SessionsSection() {
  const sessions = useMySessions();
  const revoke = useRevokeSession();
  const navigate = useNavigate();
  const fmt = useTimeFormat();
  const [confirmCurrent, setConfirmCurrent] = useState<SessionRow | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rows = sessions.data?.sessions ?? [];
  const sorted = [...rows].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  const others = sorted.filter(s => !s.current);

  return (
    <Box
      title="Sessions"
      level={2}
      actions={
        others.length > 0 && (
          <Button variant="secondary" size="sm" icon={licon.Power} onClick={() => setConfirmOthers(true)}>
            Sign out other sessions
          </Button>
        )
      }
    >
      <p className="muted">Browsers and devices signed in to your account. Revoke any you do not recognise.</p>
      {message && <Flash>{message}</Flash>}
      {revoke.isError && <Flash kind="failure">Could not revoke the session: {revoke.error instanceof Error ? revoke.error.message : ''}</Flash>}
      {sessions.isPending ? (
        <Spinner center />
      ) : sessions.isError ? (
        <ErrorBox error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : sorted.length === 0 ? (
        <EmptyState icon={licon.ScreenDesktop} title="No sessions" />
      ) : (
        <ul className="acc-sessions">
          {sorted.map(s => {
            const device = describeUserAgent(s.userAgent) ?? 'Unknown device';
            return (
              <li key={s.id} className={s.current ? 'acc-session acc-session--current' : 'acc-session'}>
                <i
                  data-icon={/iPhone|Android|iPad/.test(s.userAgent ?? '') ? licon.PhoneMobile : licon.ScreenDesktop}
                  className="acc-session__icon"
                  aria-hidden
                />
                <div className="acc-session__main">
                  <div className="acc-session__device" title={s.userAgent ?? undefined}>
                    {device}
                    {s.current && <span className="acc-badge acc-badge--done">This device</span>}
                  </div>
                  <div className="acc-session__meta">
                    {s.ip && <span>{s.ip}</span>}
                    <span title={fmt.dateTime(s.lastSeenAt)}>Active {relativeTime(s.lastSeenAt)}</span>
                    <span title={fmt.dateTime(s.createdAt)}>Signed in {fmt.date(s.createdAt)}</span>
                    <span title={fmt.dateTime(s.expiresAt)}>Expires {relativeTime(s.expiresAt)}</span>
                  </div>
                </div>
                <Button
                  variant={s.current ? 'secondary' : 'empty'}
                  size="sm"
                  icon={s.current ? licon.Power : licon.X}
                  disabled={revoke.isPending}
                  aria-label={s.current ? 'Sign out this device' : `Revoke ${device}${s.ip ? ` (${s.ip})` : ''}`}
                  onClick={() => {
                    setMessage(null);
                    if (s.current) setConfirmCurrent(s);
                    else revoke.mutate({ id: s.id, current: false }, { onSuccess: () => setMessage(`Signed out ${device}.`) });
                  }}
                >
                  {s.current ? 'Sign out' : 'Revoke'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {confirmCurrent && (
        <ConfirmDialog
          title="Sign out this device?"
          confirmLabel="Sign out"
          icon={licon.Power}
          onClose={() => setConfirmCurrent(null)}
          onConfirm={async () => {
            await revoke.mutateAsync({ id: confirmCurrent.id, current: true });
            navigate(paths.login(paths.settings), { replace: true });
          }}
        >
          <p>This ends the session you are using now.</p>
        </ConfirmDialog>
      )}
      {confirmOthers && (
        <ConfirmDialog
          title="Sign out other sessions?"
          confirmLabel={`Sign out ${others.length} session${others.length === 1 ? '' : 's'}`}
          icon={licon.Power}
          onClose={() => setConfirmOthers(false)}
          onConfirm={async () => {
            for (const s of others) await revoke.mutateAsync({ id: s.id, current: false });
            setMessage('Signed out every other session.');
          }}
        >
          <p>Every browser and device except this one will have to sign in again.</p>
        </ConfirmDialog>
      )}
    </Box>
  );
}

