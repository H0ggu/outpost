/**
 * Unknown route (`*`): says what was not found and offers the usual ways on — home, players,
 * a player search — like lila's 404 page, with a piece from the user's own set.
 */
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Box, Button, ButtonLink, licon, Page } from '../components/index.ts';
import { paths } from '../paths.ts';
import './components/account/account.css';

export default function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const search = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(paths.search(term));
  };

  return (
    <Page title="Page not found" narrow>
      <Box className="acc-notfound">
        <div className="acc-notfound__art is2d" aria-hidden>
          <span className="acc-notfound__piece" />
        </div>
        <h1>
          <span className="acc-notfound__code">404</span> Page not found
        </h1>
        <p>
          There is nothing at <code className="acc-break">{location.pathname}</code>. The link may be old, or the profile may have
          moved to a new address.
        </p>
        <form className="acc-inline-form" role="search" onSubmit={search}>
          <label htmlFor="nf-search" className="visually-hidden">
            Search players
          </label>
          <input
            id="nf-search"
            type="search"
            className="form-control"
            placeholder="Search a player or profile"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <Button type="submit" icon={licon.Search} disabled={!q.trim()}>
            Search
          </Button>
        </form>
        <div className="acc-actions acc-actions--start">
          <ButtonLink to={paths.home} icon={licon.Back}>
            Home
          </ButtonLink>
          <ButtonLink to={paths.players} variant="secondary" icon={licon.Group}>
            Players
          </ButtonLink>
          <Link to={paths.broadcasts} className="acc-quiet-link">
            Live broadcasts
          </Link>
        </div>
      </Box>
    </Page>
  );
}
