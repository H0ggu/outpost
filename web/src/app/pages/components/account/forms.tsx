/**
 * Form building blocks of the account and admin pages, in lila's form style (ui/lib/css/form):
 * labelled fields with help and error text, a password field with a reveal button, lila's
 * `cmn-toggle` switch and `group.radio` segmented choice, and `.flash` messages. Field errors come
 * from the API's `validation` issues (`details.issues[].path`), so server-side rules show up next
 * to the field they are about. The username and password rules are the contract's account policy
 * (`ACCOUNT_USERNAME_RE`, `USERNAME_MIN/MAX_LENGTH`, `PASSWORD_MIN/MAX_LENGTH`, decision 10).
 */
import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import {
  ACCOUNT_USERNAME_RE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@outpost/shared/api';
import { ApiError } from '../../../api/client.ts';
import { licon, type LiconValue } from '../../../components/index.ts';
import './account.css';

// ---------------------------------------------------------------------------
// API errors → messages
// ---------------------------------------------------------------------------

/** Friendly text for an API failure (the server's own message unless a code needs explaining). */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'network':
        return 'Cannot reach the Outpost server. Check the connection and try again.';
      case 'rate_limited':
        return 'Too many attempts. Wait a minute, then try again.';
      case 'csrf':
        return 'The server refused the request (origin check). Reload the page and try again.';
      case 'payload_too_large':
        return error.message && !/^HTTP \d+$/.test(error.message) ? error.message : 'The upload is too large.';
      case 'internal':
        return error.message && error.message !== 'Internal server error'
          ? error.message
          : 'The server hit an unexpected error. Try again; if it keeps happening, check the server log.';
      default:
        return error.message || 'Request failed';
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.';
  if (error instanceof Error) return error.message;
  return String(error);
}

/** One validation issue from the server (zod: `path`; Fastify schema errors: `instancePath`). */
interface Issue {
  path?: string;
  instancePath?: string;
  message?: string;
}

/** Field name → message, from a `validation` error's `details.issues`. */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(error instanceof ApiError) || (error.code !== 'validation' && error.code !== 'bad_request')) return out;
  const issues = (error.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return out;
  for (const raw of issues as Issue[]) {
    const path = (raw.path ?? raw.instancePath ?? '').replace(/^\//, '').split(/[./]/)[0] ?? '';
    if (path && raw.message && !(path in out)) out[path] = raw.message;
  }
  return out;
}

/**
 * Splits an API error into per-field messages (for the fields this form shows) and a form-level
 * message for everything else. `extra` adds client-side field messages, which win.
 */
export function formErrors(
  error: unknown,
  fields: readonly string[],
  extra: Record<string, string | null | undefined> = {},
): { field: Record<string, string>; form: string | null } {
  const field: Record<string, string> = {};
  const fromApi = fieldErrorsFrom(error);
  let unplaced = false;
  for (const [k, v] of Object.entries(fromApi)) {
    if (fields.includes(k)) field[k] = v;
    else unplaced = true;
  }
  for (const [k, v] of Object.entries(extra)) if (v) field[k] = v;
  const anyIssues = Object.keys(fromApi).length > 0;
  const form = error && (!anyIssues || unplaced) ? describeError(error) : null;
  return { field, form };
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Props shared by the field components. */
interface FieldChrome {
  label: ReactNode;
  /** Help text under the control. */
  help?: ReactNode;
  /** Error under the control (marks it invalid). */
  error?: string | null | undefined;
  className?: string;
}

/** Ids for a control and its help / error text. */
function useFieldIds(id: string | undefined, help: unknown, error: unknown) {
  const auto = useId();
  const base = id ?? `f${auto.replace(/:/g, '')}`;
  const describedBy = [help ? `${base}-help` : null, error ? `${base}-error` : null].filter(Boolean).join(' ') || undefined;
  return { id: base, describedBy };
}

/** Label, help and error around any control (`children` gets the id from `id`). */
export function Field({ id, label, help, error, className, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className={['form-group', 'acc-field', error && 'acc-field--invalid', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className="acc-label">
        {label}
      </label>
      {children}
      {help && (
        <div className="acc-help" id={`${id}-help`}>
          {help}
        </div>
      )}
      {error && (
        <div className="form-error" id={`${id}-error`}>
          {error}
        </div>
      )}
    </div>
  );
}

/** A labelled text input (`type` text, email, url, number, search…). */
export function TextField({
  label,
  help,
  error,
  className,
  id: idProp,
  ref,
  ...input
}: FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { ref?: Ref<HTMLInputElement> }) {
  const { id, describedBy } = useFieldIds(idProp, help, error);
  return (
    <Field id={id} label={label} help={help} error={error} className={className}>
      <input
        type="text"
        {...input}
        ref={ref}
        id={id}
        className="form-control"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
    </Field>
  );
}

/** A password input with a show/hide button. */
export function PasswordField({
  label,
  help,
  error,
  className,
  id: idProp,
  ...input
}: FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'>) {
  const { id, describedBy } = useFieldIds(idProp, help, error);
  const [shown, setShown] = useState(false);
  return (
    <Field id={id} label={label} help={help} error={error} className={className}>
      <div className="acc-password">
        <input
          {...input}
          id={id}
          type={shown ? 'text' : 'password'}
          className="form-control"
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <button
          type="button"
          className="acc-password__reveal"
          data-icon={licon.Eye}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          title={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown(s => !s)}
        />
      </div>
    </Field>
  );
}

/** lila's `cmn-toggle`: an on/off switch with its label (a checkbox with `role="switch"`). */
export function Toggle({
  checked,
  onChange,
  label,
  help,
  disabled,
  id: idProp,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const { id, describedBy } = useFieldIds(idProp, help, null);
  return (
    <div className="acc-toggle-row">
      <label className="acc-toggle" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.checked)}
        />
        <span className="acc-toggle__track" aria-hidden />
        <span className="acc-toggle__label">{label}</span>
      </label>
      {help && (
        <div className="acc-help" id={`${id}-help`}>
          {help}
        </div>
      )}
    </div>
  );
}

/** One choice of a `RadioGroup`. */
export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LiconValue;
  disabled?: boolean;
  /** Tooltip / extra description. */
  title?: string;
}

/** lila's `group.radio`: a segmented choice inside a fieldset with a legend. */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  help,
  error,
  className,
}: {
  legend: ReactNode;
  name: string;
  value: T;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (value: T) => void;
  help?: ReactNode;
  error?: string | null | undefined;
  className?: string;
}) {
  const { id, describedBy } = useFieldIds(undefined, help, error);
  return (
    <fieldset className={['form-group', 'acc-fieldset', className].filter(Boolean).join(' ')} aria-describedby={describedBy}>
      <legend className="acc-label">{legend}</legend>
      <div className="acc-radio">
        {options.map(o => (
          <label key={o.value} className={o.value === value ? 'active' : undefined} title={o.title} data-disabled={o.disabled || undefined}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span data-icon={o.icon}>{o.label}</span>
          </label>
        ))}
      </div>
      {help && (
        <div className="acc-help" id={`${id}-help`}>
          {help}
        </div>
      )}
      {error && (
        <div className="form-error" id={`${id}-error`}>
          {error}
        </div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** lila's `.flash`: a success / warning / failure / quiet message. */
export function Flash({
  kind = 'success',
  children,
  className,
}: {
  kind?: 'success' | 'warning' | 'failure' | 'quiet';
  children: ReactNode;
  className?: string;
}) {
  const icon =
    kind === 'success' ? licon.Checkmark : kind === 'failure' ? licon.CautionCircle : kind === 'warning' ? licon.CautionTriangle : licon.InfoCircle;
  return (
    <div className={['acc-flash', `acc-flash--${kind}`, className].filter(Boolean).join(' ')} role={kind === 'failure' ? 'alert' : 'status'}>
      <i data-icon={icon} aria-hidden />
      <div className="acc-flash__body">{children}</div>
    </div>
  );
}

/** A form-level error (`null` renders nothing). */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <Flash kind="failure">{message}</Flash>;
}

/** A value that clears itself `ms` after it was last set (for short-lived notes such as "Saved"). */
export function useTransient<T>(ms = 2500): [T | null, (value: T) => void] {
  const [value, setValue] = useState<{ v: T; n: number } | null>(null);
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setValue(null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [value?.v ?? null, (v: T) => setValue(prev => ({ v, n: (prev?.n ?? 0) + 1 }))];
}

/** Client-side check of a new username (already trimmed); undefined when it is fine. */
export function usernameProblem(name: string): string | undefined {
  if (!name) return 'Choose a username.';
  if (name.length < USERNAME_MIN_LENGTH) return `Use at least ${USERNAME_MIN_LENGTH} characters.`;
  if (name.length > USERNAME_MAX_LENGTH) return `Use at most ${USERNAME_MAX_LENGTH} characters.`;
  if (!ACCOUNT_USERNAME_RE.test(name)) return 'Use only letters, digits, _ and -, starting with a letter or digit.';
  return undefined;
}

/** Help text of a new-username field, from the contract's account policy. */
export const USERNAME_HELP = `${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} letters, digits, _ or -.`;

/** Help text of a new-password field, from the contract's account policy. */
export const PASSWORD_HELP = `At least ${PASSWORD_MIN_LENGTH} characters.`;

/** Client-side check of a new password and its confirmation (the contract's policy; the server has the final say). */
export function newPasswordProblems(password: string, confirm: string): { password?: string; confirm?: string } {
  const out: { password?: string; confirm?: string } = {};
  if (password.length < PASSWORD_MIN_LENGTH) out.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  else if (password.length > PASSWORD_MAX_LENGTH) out.password = `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (confirm !== password) out.confirm = 'The passwords do not match.';
  return out;
}
