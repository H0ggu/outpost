/**
 * Site chrome in Lichess's layout: top bar with the Outpost wordmark (our own icon, never the
 * Lichess logo), main navigation (a drop-down panel on phones, with the search box inside),
 * player search, my running jobs, and the user menu; content outlet; footer with the AGPL notice
 * and the NOTICE.md attribution. Applies the theme, board and piece preferences (true black by
 * default).
 */
import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { SessionInfo } from '@outpost/shared/api';
import { licon } from '../lichess/licon.ts';
import { useLogout, useSession } from './api/hooks.ts';
import { Button } from './components/index.ts';
import { JobsIndicator } from './pages/components/account/JobsIndicator.tsx';
import { paths } from './paths.ts';
import { usePrefs } from './prefs.ts';
import './Layout.css';

// Loaded on demand: the dialog bundles NOTICE.md.
const NoticeDialog = lazy(async () => ({ default: (await import('./pages/components/account/NoticeDialog.tsx')).NoticeDialog }));

/** The licence text at the FSF. */
const AGPL_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

/** Main navigation (SPA routes; the Studio is added as a full-page link). */
const NAV = [
  { to: paths.home, label: 'Home', end: true },
  { to: paths.players, label: 'Players' },
  { to: paths.databases, label: 'Databases' },
  { to: paths.prepList, label: 'Prep' },
  { to: paths.broadcasts, label: 'Broadcasts' },
  { to: paths.explorer, label: 'Explorer' },
] as const;

export default function Layout() {
  const session = useSession();
  usePrefs(session.data);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // The phone menu closes on Escape and on a tap outside the header.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const info = session.data;
  const user = info?.user ?? null;
  // The auth pages explain setup themselves.
  const setupNeeded = info?.setupRequired && !/^\/(setup|login|signup)(\/|$)/.test(location.pathname);

  return (
    <>
      <a href="#main" className="site-skip">
        Skip to content
      </a>
      <header className="site-header" ref={headerRef}>
        <button
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Menu'}
          aria-expanded={menuOpen}
          aria-controls="topnav"
          data-icon={menuOpen ? licon.X : licon.Hamburger}
          onClick={() => setMenuOpen(o => !o)}
        />
        <Link to={paths.home} className="site-title" aria-label="Outpost home">
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span>Outpost</span>
        </Link>
        <nav id="topnav" className={menuOpen ? 'topnav open' : 'topnav'} aria-label="Main">
          <SearchBox variant="menu" />
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} end={'end' in item ? item.end : false}>
              {item.label}
            </NavLink>
          ))}
          {/* The Studio is its own page (studio.html): full navigation, not an SPA route. */}
          <a href={paths.studio()}>Studio</a>
        </nav>
        <div className="site-header__spacer" />
        <SearchBox variant="bar" />
        {user && <JobsIndicator isAdmin={user.role === 'admin'} />}
        <UserMenu session={info} />
      </header>

      <main id="main" className="site-main" tabIndex={-1}>
        {session.isError && !info && (
          <div className="site-banner site-banner--bad" role="alert">
            <i data-icon={licon.CautionTriangle} aria-hidden />
            <span>Cannot reach the Outpost server. Some pages will not load until it is back.</span>
            <Button variant="secondary" size="sm" icon={licon.Reload} onClick={() => void session.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {setupNeeded && (
          <div className="site-banner" role="status">
            <i data-icon={licon.InfoCircle} aria-hidden />
            <span>
              This Outpost has no admin yet. <Link to={paths.setup}>Create the first admin account</Link> with the setup token
              from the server log.
            </span>
          </div>
        )}
        <Outlet />
      </main>

      <footer className="site-footer">
        <p>
          <strong>Outpost</strong>
          {info?.version ? ` ${info.version}` : ''} is free software under the{' '}
          <a href={AGPL_URL} target="_blank" rel="noreferrer noopener">
            GNU AGPL v3 or later
          </a>
          . Board, pieces, sounds, fonts and analysis code come from the{' '}
          <a href="https://lichess.org/source" target="_blank" rel="noreferrer noopener">
            lichess.org
          </a>{' '}
          open-source projects.
        </p>
        <p>
          <button type="button" className="site-footer__link" onClick={() => setNoticeOpen(true)}>
            Notices and attribution
          </button>{' '}
          · Not affiliated with Lichess or Chess.com
        </p>
      </footer>
      {noticeOpen && (
        <Suspense fallback={null}>
          <NoticeDialog onClose={() => setNoticeOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

/** Player search → /search?q=. `bar` sits in the header; `menu` is inside the phone menu. */
function SearchBox({ variant }: { variant: 'bar' | 'menu' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const id = useId();

  useEffect(() => {
    setQ(location.pathname === '/search' ? (params.get('q') ?? '') : '');
  }, [location.pathname, params]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(paths.search(term));
  };

  return (
    <form className={variant === 'bar' ? 'site-search' : 'site-search site-search--menu'} role="search" onSubmit={onSubmit}>
      <label htmlFor={id} className="visually-hidden">
        Search players
      </label>
      <i data-icon={licon.Search} aria-hidden />
      <input
        id={id}
        type="search"
        placeholder="Search players"
        value={q}
        onChange={e => setQ(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
      />
    </form>
  );
}

function UserMenu({ session }: { session: SessionInfo | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

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

  if (!session) return <div className="user-menu" />;
  const user = session.user;
  if (!user) {
    const here = `${location.pathname}${location.search}`;
    const onAuthPage = /^\/(login|signup|setup)(\/|$)/.test(location.pathname);
    return (
      <div className="user-menu user-menu--anon">
        {!session.setupRequired && session.signupMode !== 'closed' && location.pathname !== '/signup' && (
          <Link to={paths.signup()} className="user-menu__signup">
            Sign up
          </Link>
        )}
        <Link to={paths.login(onAuthPage || here === '/' ? undefined : here)} data-icon={licon.User}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu (${user.username})`}
        onClick={() => setOpen(o => !o)}
        data-icon={licon.User}
      >
        <span className="user-menu__name">{user.username}</span>
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="user-menu__who" aria-hidden>
            Signed in as <strong>{user.username}</strong>
          </div>
          <Link to={paths.bookmarks} role="menuitem" data-icon={licon.Star}>
            Bookmarks
          </Link>
          <Link to={paths.newProfile} role="menuitem" data-icon={licon.PlusButton}>
            New profile
          </Link>
          <Link to={paths.settings} role="menuitem" data-icon={licon.Gear}>
            Settings
          </Link>
          {user.role === 'admin' && (
            <Link to={paths.admin.root} role="menuitem" data-icon={licon.Cogs}>
              Admin
            </Link>
          )}
          <hr />
          <button
            type="button"
            role="menuitem"
            data-icon={licon.Power}
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSettled: () => navigate(paths.home) })}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
