/**
 * Small pieces of the account and admin pages: copy-to-clipboard, a row action menu, the
 * sign-in prompt for pages that need an account, and the centred card of the auth pages.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Box, Button, ButtonLink, EmptyState, licon, Page, type LiconValue } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { focusMenuItem, menuButtonKeyDown, menuKeyDown, type MenuFocus } from './menuKeys.ts';
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

/**
 * A gear button opening a small menu of row actions (keeps tables narrow on phones). The menu is
 * positioned against the viewport (`position: fixed`), so a table's scroll container cannot clip
 * it; it opens upwards when there is no room below, follows its button on scroll and resize, and
 * closes on Escape or a click elsewhere.
 */
export function RowMenu({ label, actions }: { label: string; actions: readonly RowAction[] }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<MenuFocus>('first');
  const open = pos !== null;

  // The menu takes focus when it opens (menuKeys.ts).
  useEffect(() => {
    if (open) focusMenuItem(menuRef.current, focusOnOpen.current);
  }, [open]);

  const place = () => {
    const el = toggleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    const roomBelow = window.innerHeight - r.bottom;
    setPos(roomBelow < 40 * actions.length + 24 && r.top > roomBelow ? { bottom: window.innerHeight - r.top + 2, right } : { top: r.bottom + 2, right });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
    // `place` only reads refs and props that do not change while open.
  }, [open]);

  const toggle = () => (open ? setPos(null) : place());
  const openAt = (focus: MenuFocus) => {
    focusOnOpen.current = focus;
    if (!open) place();
    else focusMenuItem(menuRef.current, focus);
  };
  const closeToToggle = () => {
    setPos(null);
    toggleRef.current?.focus();
  };

  return (
    <div className="acc-rowmenu" ref={ref}>
      <button
        ref={toggleRef}
        type="button"
        className="acc-rowmenu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-icon={licon.Gear}
        onClick={() => {
          focusOnOpen.current = 'first';
          toggle();
        }}
        onKeyDown={e => menuButtonKeyDown(e, openAt)}
      />
      {pos && (
        <div
          ref={menuRef}
          className="dropdown acc-rowmenu__menu"
          role="menu"
          aria-label={label}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right }}
          onKeyDown={e => menuKeyDown(e, closeToToggle)}
        >
          {actions.map(a => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-icon={a.icon}
              className={a.danger ? 'acc-danger' : undefined}
              disabled={a.disabled}
              title={a.title}
              onClick={() => {
                setPos(null);
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

/**
 * A safe in-app redirect target from `?next=`, else `fallback`: an absolute path on this origin,
 * normalised by the URL parser the way the router and the browser read it. Control characters
 * and backslashes are refused outright: browsers drop tabs and newlines inside URLs, so
 * `/\t/evil.example` would otherwise become the off-site `//evil.example` (which React Router
 * refuses to navigate to, with an uncaught error).
 */
export function safeNext(next: string | null | undefined, fallback: string = paths.home): string {
  if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return fallback;
  }
  if (url.origin !== window.location.origin) return fallback;
  const target = `${url.pathname}${url.search}${url.hash}`;
  // `//host` as a path would be read as off-site again by the next parser.
  if (target.startsWith('//') || /^\/(login|signup|setup)(\/|\?|#|$)/.test(target)) return fallback;
  return target;
}

/** Goes to an in-app path after sign-in; the Studio is a separate page and needs a document load. */
export function useGoTo(): (to: string) => void {
  const navigate = useNavigate();
  return (to: string) => {
    if (/^\/studio(\/|\?|$)/.test(to)) window.location.assign(to);
    else navigate(to, { replace: true });
  };
}

/** Goes to `to` once rendered (a full page load for the Studio, see `useGoTo`). */
export function GoTo({ to }: { to: string }) {
  const goTo = useGoTo();
  // Once per target; `goTo` is a new function on every render.
  useEffect(() => goTo(to), [to]);
  return null;
}
