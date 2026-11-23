/**
 * Site chrome in Lichess's layout: top bar with the Outpost wordmark (our own icon, never the
 * Lichess logo), main navigation, search box and user menu; content outlet; footer.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { SessionInfo } from '@outpost/shared/api';
import { licon } from '../lichess/licon.ts';
import { useLogout, useSession } from './api/hooks.ts';
import { paths } from './paths.ts';
import { usePrefs } from './prefs.ts';

export default function Layout() {
  const session = useSession();
  usePrefs(session.data);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const setupNeeded = session.data?.setupRequired && location.pathname !== paths.setup;

  return (
    <>
      <header className="site-header">
        <button
          type="button"
          className="menu-toggle"
          aria-label="Menu"
          aria-expanded={menuOpen}
          aria-controls="topnav"
          data-icon={licon.Hamburger}
          onClick={() => setMenuOpen(o => !o)}
        />
        <Link to={paths.home} className="site-title" aria-label="Outpost home">
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span>Outpost</span>
        </Link>
        <nav id="topnav" className={menuOpen ? 'topnav open' : 'topnav'} aria-label="Main">
          <NavLink to={paths.players}>Players</NavLink>
          <NavLink to={paths.prepList}>Prep</NavLink>
          <NavLink to={paths.broadcasts}>Broadcasts</NavLink>
          <NavLink to={paths.databases}>Databases</NavLink>
          {/* The Studio is its own page (studio.html): full navigation, not an SPA route. */}
          <a href={paths.studio()}>Studio</a>
        </nav>
        <div className="site-header__spacer" />
        <SearchBox />
        <UserMenu session={session.data} />
      </header>

      <main className="site-main">
        {setupNeeded && (
          <div className="error-box" style={{ marginBottom: '1rem' }}>
            <i data-icon={licon.InfoCircle} aria-hidden />
            <div className="error-box__body">
              This Outpost has no admin yet. <Link to={paths.setup}>Create the first admin account</Link> with the setup
              token from the server log.
            </div>
          </div>
        )}
        <Outlet />
      </main>

      <footer className="site-footer">
        Outpost{session.data ? ` ${session.data.version}` : ''} · free software under the AGPL-3.0 · board, pieces, sounds,
        fonts and analysis code from <a href="https://lichess.org/source">lichess.org</a> (see NOTICE.md) · not
        affiliated with Lichess or Chess.com
      </footer>
    </>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');

  useEffect(() => {
    if (location.pathname === '/search') setQ(params.get('q') ?? '');
  }, [location.pathname, params]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(paths.search(term));
  };

  return (
    <form className="site-search" role="search" onSubmit={onSubmit}>
      <i data-icon={licon.Search} aria-hidden />
      <input
        type="search"
        placeholder="Search players"
        aria-label="Search players"
        value={q}
        onChange={e => setQ(e.target.value)}
        autoComplete="off"
        spellCheck={false}
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

  const user = session?.user;
  if (!user) {
    return (
      <div className="user-menu">
        <Link to={paths.login(location.pathname === '/login' ? undefined : location.pathname)} data-icon={licon.User}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} data-icon={licon.User}>
        {user.username}
      </button>
      {open && (
        <div className="dropdown" role="menu">
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
            onClick={() => logout.mutate(undefined, { onSettled: () => navigate(paths.home) })}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
