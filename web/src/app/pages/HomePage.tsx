import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SessionInfo, SessionUser } from '@outpost/shared/api';
import { useBookmarks, useMyJobs, useProfiles, useSession } from '../api/hooks.ts';
import { ButtonLink, Card, ErrorBox, licon, Page, Spinner, type LiconValue } from '../components/index.ts';
import { paths } from '../paths.ts';
import { JobProgress, SearchField } from './components/library/controls.tsx';
import { ProfileRows } from './components/library/ProfileList.tsx';
import { QueryView } from './components/library/QueryView.tsx';
import './components/library/library.css';
import './HomePage.css';

/**
 * PLAN §9 route `/`: search box, my profiles, bookmarks, recently viewed, the update queue and
 * quick links (GET /api/profiles?scope=mine|recent, /api/bookmarks, /api/jobs/mine). Signed-out
 * visitors get a welcome page (and public profiles when anonymous browsing is on); a new user
 * with nothing yet gets a first-run guide.
 */
export default function HomePage() {
  const session = useSession();
  return (
    <Page title="Home">
      {session.isPending ? (
        <Spinner center />
      ) : session.isError || !session.data ? (
        <ErrorBox error={session.error} title="Cannot reach the Outpost server" onRetry={() => void session.refetch()} />
      ) : session.data.user ? (
        <SignedInHome user={session.data.user} />
      ) : (
        <Welcome session={session.data} />
      )}
    </Page>
  );
}

/** One quick link tile. */
interface QuickLink {
  label: string;
  hint: string;
  icon: LiconValue;
  to: string;
  /** Full page load (the Studio is a separate page). */
  external?: boolean;
}

const QUICK_LINKS: readonly QuickLink[] = [
  { label: 'Studio', hint: 'Analysis board, engine, my files', icon: licon.Microscope, to: paths.studio(), external: true },
  { label: 'Opening explorer', hint: 'Masters, Lichess and reference games', icon: licon.Book, to: paths.explorer },
  { label: 'Broadcasts', hint: 'Live over-the-board events', icon: licon.RadioTower, to: paths.broadcasts },
  { label: 'Databases', hint: 'Your PGN collections', icon: licon.List, to: paths.databases },
  { label: 'Prep', hint: 'Opponent report cards', icon: licon.Target, to: paths.prepList },
  { label: 'Players', hint: 'Public profiles and bookmarks', icon: licon.Group, to: paths.players },
];

function QuickLinks({ links = QUICK_LINKS }: { links?: readonly QuickLink[] }) {
  return (
    <nav className="lib-quick" aria-label="Quick links">
      {links.map(l => {
        const body = (
          <>
            <i data-icon={l.icon} aria-hidden />
            <span className="lib-quick__text">
              <strong>{l.label}</strong>
              <span>{l.hint}</span>
            </span>
          </>
        );
        return l.external ? (
          <a key={l.label} href={l.to} className="lib-quick__item">
            {body}
          </a>
        ) : (
          <Link key={l.label} to={l.to} className="lib-quick__item">
            {body}
          </Link>
        );
      })}
    </nav>
  );
}

/** The big search box; Enter opens the search page. */
function HomeSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <SearchField
      className="lib-search--big"
      value={q}
      onChange={setQ}
      onSubmit={v => {
        const term = v.trim();
        if (term) navigate(paths.search(term));
      }}
      label="Search players"
      placeholder="Lichess or Chess.com username, player name, FIDE id"
      autoFocus={autoFocus}
    />
  );
}

function SignedInHome({ user }: { user: SessionUser }) {
  const mine = useProfiles('mine');
  const recent = useProfiles('recent');
  const bookmarks = useBookmarks();
  const jobs = useMyJobs();

  const loaded = mine.data && recent.data && bookmarks.data;
  const firstRun =
    !!loaded && mine.data.profiles.length === 0 && recent.data.profiles.length === 0 && bookmarks.data.profiles.length === 0;
  const activeJobs = jobs.data?.jobs ?? [];

  return (
    <>
      <section className="box lib-home-hero">
        <div className="lib-home-hero__head">
          <h1>Hello, {user.username}</h1>
          <p className="lib-lead">Look up any Lichess or Chess.com player, or open one of your profiles.</p>
        </div>
        <HomeSearch autoFocus={false} />
        <QuickLinks />
      </section>

      {firstRun ? (
        <FirstRun />
      ) : (
        <div className="lib-home-grid">
          <Card
            title="My profiles"
            className="lib-home-card"
            actions={
              <ButtonLink to={paths.newProfile} size="sm" icon={licon.PlusButton}>
                New
              </ButtonLink>
            }
          >
            <QueryView query={mine} what="your profiles">
              {d => (
                <>
                  <ProfileRows
                    profiles={d.profiles}
                    bookmarkable
                    max={8}
                    empty={
                      <p className="muted lib-card-empty">
                        No profiles yet. <Link to={paths.newProfile}>Create one</Link> from your Lichess or Chess.com
                        account.
                      </p>
                    }
                  />
                  {d.profiles.length > 8 && (
                    <Link className="lib-more" to={`${paths.players}?tab=mine`}>
                      All {d.profiles.length} profiles
                    </Link>
                  )}
                </>
              )}
            </QueryView>
          </Card>

          <Card title="Bookmarks" className="lib-home-card">
            <QueryView query={bookmarks} what="your bookmarks">
              {d => (
                <>
                  <ProfileRows
                    profiles={d.profiles}
                    bookmarkable
                    max={6}
                    empty={
                      <p className="muted lib-card-empty">
                        Star a player <i data-icon={licon.StarOutline} aria-label="star" /> to keep them here.
                      </p>
                    }
                  />
                  {d.profiles.length > 6 && (
                    <Link className="lib-more" to={paths.bookmarks}>
                      All {d.profiles.length} bookmarks
                    </Link>
                  )}
                </>
              )}
            </QueryView>
          </Card>

          <Card title="Recently viewed" className="lib-home-card">
            <QueryView query={recent} what="recently viewed profiles">
              {d => (
                <>
                  <ProfileRows
                    profiles={d.profiles}
                    bookmarkable
                    max={6}
                    empty={<p className="muted lib-card-empty">Profiles you open show up here.</p>}
                  />
                  {d.profiles.length > 6 && (
                    <Link className="lib-more" to={`${paths.players}?tab=recent`}>
                      Show all
                    </Link>
                  )}
                </>
              )}
            </QueryView>
          </Card>

          {activeJobs.length > 0 && (
            <Card title="Updates in progress" className="lib-home-card">
              <div className="lib-stack">
                {activeJobs.slice(0, 5).map(j => (
                  <JobProgress key={j.id} job={j} />
                ))}
                {activeJobs.length > 5 && <p className="muted">and {activeJobs.length - 5} more queued</p>}
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

/** Shown to a signed-in user with no profiles, bookmarks or history yet. */
function FirstRun() {
  return (
    <section className="box lib-firstrun" aria-labelledby="firstrun-title">
      <div className="box__pad">
        <h2 id="firstrun-title">Let's get you set up</h2>
        <p className="lib-lead">Outpost builds statistics from public games. Three steps and you're in:</p>
        <ol className="lib-steps">
          <li>
            <i data-icon={licon.User} aria-hidden />
            <div>
              <strong>Create your profile</strong>
              <span>Add your Lichess and Chess.com usernames (as many as you have); they're merged into one page.</span>
            </div>
          </li>
          <li>
            <i data-icon={licon.Reload} aria-hidden />
            <div>
              <strong>Let it sync</strong>
              <span>Your games download in the background. The first import can take a few minutes.</span>
            </div>
          </li>
          <li>
            <i data-icon={licon.BarChart} aria-hidden />
            <div>
              <strong>Explore and prepare</strong>
              <span>Openings, opponents, activity and rating, then prep report cards for your next opponents.</span>
            </div>
          </li>
        </ol>
        <div className="lib-actions">
          <ButtonLink to={paths.newProfile} icon={licon.PlusButton}>
            Create my profile
          </ButtonLink>
          <ButtonLink to={paths.players} variant="secondary" icon={licon.Group}>
            Browse players
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

const FEATURES: ReadonlyArray<{ icon: LiconValue; title: string; text: string }> = [
  { icon: licon.BarChart, title: 'Statistics', text: 'Openings, opponents, activity and rating across all your accounts.' },
  { icon: licon.Book, title: 'Explorer', text: 'Your own opening tree with transpositions, next to masters and Lichess.' },
  { icon: licon.Target, title: 'Preparation', text: 'Printable report cards on the opponents you are about to face.' },
  { icon: licon.Microscope, title: 'Studio', text: "Lichess's analysis board with engine, explorers and your files." },
];

/** Signed-out home: what Outpost is, sign in / sign up, and public profiles when allowed. */
function Welcome({ session }: { session: SessionInfo }) {
  if (session.setupRequired)
    return (
      <section className="box lib-welcome">
        <div className="box__pad">
          <h1>Welcome to Outpost</h1>
          <p className="lib-lead">
            This server is brand new: nobody can sign in until the first admin account exists. Use the setup token printed
            in the server log.
          </p>
          <div className="lib-actions">
            <ButtonLink to={paths.setup} icon={licon.Gear}>
              Set up Outpost
            </ButtonLink>
          </div>
        </div>
      </section>
    );

  return (
    <>
      <section className="box lib-welcome">
        <div className="box__pad">
          <h1>Chess statistics and opponent prep</h1>
          <p className="lib-lead">
            Outpost turns public Lichess and Chess.com games into statistics and preparation, on your own server.
          </p>
          <ul className="lib-features">
            {FEATURES.map(f => (
              <li key={f.title}>
                <i data-icon={f.icon} aria-hidden />
                <div>
                  <strong>{f.title}</strong>
                  <span>{f.text}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="lib-actions">
            <ButtonLink to={paths.login()} icon={licon.User}>
              Sign in
            </ButtonLink>
            {session.signupMode !== 'closed' && (
              <ButtonLink to={paths.signup()} variant="secondary">
                {session.signupMode === 'invite' ? 'I have an invite' : 'Create an account'}
              </ButtonLink>
            )}
          </div>
        </div>
      </section>
      {session.anonymousBrowsing && <PublicProfiles />}
    </>
  );
}

function PublicProfiles() {
  const pub = useProfiles('public');
  return (
    <Card title="Public profiles" className="lib-home-card">
      <HomeSearch />
      <div className="lib-gap" />
      <QueryView query={pub} what="public profiles">
        {d => (
          <>
            <ProfileRows
              profiles={d.profiles}
              bookmarkable={false}
              max={12}
              empty={<p className="muted lib-card-empty">No public profiles yet.</p>}
            />
            {d.profiles.length > 12 && (
              <Link className="lib-more" to={paths.players}>
                All {d.profiles.length} profiles
              </Link>
            )}
          </>
        )}
      </QueryView>
    </Card>
  );
}
