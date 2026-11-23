/**
 * Small pieces of the account and admin pages: copy-to-clipboard, a row action menu, the
 * sign-in prompt for pages that need an account, and the centred card of the auth pages.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Box, Button, ButtonLink, EmptyState, licon, Page, type LiconValue } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import './account.css';

/** Copies `text`; resolves false when the clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A button that copies `text` and says so for a moment. */
export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <Button
      variant="secondary"
      size={size}
      icon={state === 'copied' ? licon.Checkmark : licon.Clipboard}
      onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
      aria-live="polite"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}

/** One entry of a `RowMenu`. */
export interface RowAction {
  label: string;
  icon?: LiconValue;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled (tooltip). */
  title?: string;
}

/** A "…" button opening a small menu of row actions (keeps tables narrow on phones). */
export function RowMenu({ label, actions }: { label: string; actions: readonly RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="acc-rowmenu" ref={ref}>
      <button
        type="button"
        className="acc-rowmenu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-icon={licon.MoreTriangle}
        onClick={() => setOpen(o => !o)}
      />
      {open && (
        <div className="dropdown acc-rowmenu__menu" role="menu">
          {actions.map(a => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              data-icon={a.icon}
              className={a.danger ? 'acc-danger' : undefined}
              disabled={a.disabled}
              title={a.title}
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown instead of a page that needs an account. */
export function SignInPrompt({ title, children }: { title: string; children?: ReactNode }) {
  const location = useLocation();
  return (
    <Page title={title} narrow>
      <Box title={title}>
        <EmptyState icon={licon.Padlock} title="Sign in to continue">
          {children}
          <ButtonLink to={paths.login(`${location.pathname}${location.search}`)} icon={licon.User}>
            Sign in
          </ButtonLink>
        </EmptyState>
      </Box>
    </Page>
  );
}

/** The centred card of the sign-in, sign-up and setup pages (lila's `.auth` box). */
export function AuthCard({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Page title={title} narrow>
      <Box title={title} className="acc-auth">
        {intro && <div className="acc-auth__intro">{intro}</div>}
        {children}
        {footer && <div className="acc-auth__footer">{footer}</div>}
      </Box>
    </Page>
  );
}

/** A safe in-app redirect target from `?next=` (same origin, absolute path), else `fallback`. */
export function safeNext(next: string | null | undefined, fallback = paths.home): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/^\/(login|signup|setup)(\/|\?|$)/.test(next)) return fallback;
  return next;
}

/** Goes to an in-app path after sign-in; the Studio is a separate page and needs a document load. */
export function useGoTo(): (to: string) => void {
  const navigate = useNavigate();
  return (to: string) => {
    if (/^\/studio(\/|\?|$)/.test(to)) window.location.assign(to);
    else navigate(to, { replace: true });
  };
}
