import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { API_ROUTES, type DatabaseInfo, type DbGameRow, type Id } from '@outpost/shared/api';
import { ApiError } from '../api/client.ts';
import { useProfiles, useSession } from '../api/hooks.ts';
import { Box, Button, ButtonLink, Card, EmptyState, ErrorBox, licon, Page, Spinner, Table, type Column } from '../components/index.ts';
import { paths } from '../paths.ts';
import { ConfirmButton, Pagination, SearchField } from './components/library/controls.tsx';
import { formatDate, fullNumber, movesFromPlies, resultLabel, timeAgo } from './components/library/format.ts';
import { ImportPanel } from './components/library/ImportPanel.tsx';
import { newProfileHref } from './components/library/newProfileQuery.ts';
import { isUnauthorized, SignInPrompt } from './components/library/QueryView.tsx';
import {
  useAddProfileSource,
  useDatabase,
  useDatabaseGames,
  useDebouncedValue,
  useDeleteDatabase,
  useDeleteDatabaseGame,
  useUpdateDatabase,
} from './library-hooks.ts';
import './components/library/library.css';
import './DatabasesPage.css';

/** Games per page of the database table. */
export const DB_PAGE_SIZE = 50;

/** Viewport widths (px) below which the wide text columns of the games table are hidden. */
export const GAME_COLUMN_BREAKPOINTS = { opening: 820, event: 1100 } as const;

/**
 * PLAN §9 `/databases/:id`, §6 database endpoints, §5 custom PGN databases: details, rename /
 * visibility / delete, PGN import (upload or paste, followed as a job to a final summary), export,
 * the games table (paginated, searchable, open in the Studio, delete), and "attach as profile" by
 * player name.
 */
export default function DatabasePage() {
  const { id = '' } = useParams();
  const dbId: Id | undefined = /^[1-9]\d{0,15}$/.test(id) ? Number(id) : undefined;
  const db = useDatabase(dbId);

  if (dbId === undefined || (db.error instanceof ApiError && db.error.isNotFound))
    return (
      <Page title="Database not found">
        <Box title="Database not found">
          <EmptyState icon={licon.List} title="This database doesn't exist, or it's private.">
            <ButtonLink to={paths.databases} variant="secondary" icon={licon.Back}>
              All databases
            </ButtonLink>
          </EmptyState>
        </Box>
      </Page>
    );

  return (
    <Page title={db.data?.name ?? 'Database'}>
      {db.data ? (
        <DatabaseView db={db.data} />
      ) : db.isError ? (
        <Box title="Database">
          {isUnauthorized(db.error) ? (
            <SignInPrompt what="this database" />
          ) : (
            <ErrorBox error={db.error} onRetry={() => void db.refetch()} />
          )}
        </Box>
      ) : (
        <Spinner center />
      )}
    </Page>
  );
}

function DatabaseView({ db }: { db: DatabaseInfo }) {
  const session = useSession();
  const signedIn = !!session.data?.user;
  const canImport = db.canEdit && db.kind === 'games';
  return (
    <>
      <DatabaseHeader db={db} />
      {canImport && (
        <Card title="Import games">
          <ImportPanel db={db} />
        </Card>
      )}
      <GamesBox db={db} />
      {signedIn && db.kind === 'games' && <AttachPlayer db={db} />}
    </>
  );
}

function DatabaseHeader({ db }: { db: DatabaseInfo }) {
  const navigate = useNavigate();
  const update = useUpdateDatabase();
  const del = useDeleteDatabase();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(db.name);
  const nameId = useId();

  const rename = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === db.name) return setRenaming(false);
    update.mutate({ id: db.id, patch: { name: n } }, { onSuccess: () => setRenaming(false) });
  };

  const meta = [
    db.kind === 'reference' ? 'Reference database' : 'Game collection',
    db.owner ? `by ${db.owner.username}` : null,
    `created ${timeAgo(db.createdAt)}`,
    db.sourceLabel ? `source: ${db.sourceLabel}` : null,
    db.licence ? `licence: ${db.licence}` : null,
  ].filter(Boolean);

  return (
    <Box
      title={
        renaming ? (
          <form className="lib-rename" onSubmit={rename}>
            <label htmlFor={nameId} className="visually-hidden">
              Database name
            </label>
            <input id={nameId} type="text" value={name} maxLength={100} autoFocus onChange={e => setName(e.target.value)} />
            <Button type="submit" size="sm" disabled={update.isPending}>
              Save
            </Button>
            <Button variant="empty" size="sm" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <span className="lib-dbtitle">
            {db.name}
            {db.canEdit && (
              <button
                type="button"
                className="lib-icon-btn lib-icon-btn--inline"
                data-icon={licon.Pencil}
                aria-label="Rename"
                title="Rename"
                onClick={() => {
                  setName(db.name);
                  setRenaming(true);
                }}
              />
            )}
          </span>
        )
      }
      actions={
        <>
          <a className="button button-secondary button-thin" href={API_ROUTES.databaseExport(db.id)} download data-icon={licon.Download}>
            Export PGN
          </a>
          <a
            className="button button-secondary button-thin"
            href={paths.studio({ explorer: `player:db:${db.id}`, color: 'white' })}
            data-icon={licon.Book}
          >
            Explore
          </a>
        </>
      }
    >
      <div className="lib-dbmeta">
        <span className={`lib-pill${db.visibility === 'public' ? ' lib-pill--good' : ''}`} data-icon={db.visibility === 'private' ? licon.Padlock : licon.Globe}>
          {db.visibility}
        </span>
        <strong className="lib-dbmeta__count">{fullNumber(db.gameCount)} games</strong>
        <span className="muted">{meta.join(' · ')}</span>
      </div>
      {update.isError && <ErrorBox error={update.error} title="Could not save" />}
      {db.canEdit && (
        <div className="lib-actions lib-dbadmin">
          <Button
            variant="secondary"
            size="sm"
            icon={db.visibility === 'private' ? licon.Globe : licon.Padlock}
            disabled={update.isPending}
            onClick={() => update.mutate({ id: db.id, patch: { visibility: db.visibility === 'private' ? 'public' : 'private' } })}
          >
            {db.visibility === 'private' ? 'Make public' : 'Make private'}
          </Button>
          <ConfirmButton
            size="sm"
            confirmLabel={`Delete ${fullNumber(db.gameCount)} games for good`}
            disabled={del.isPending}
            onConfirm={() => del.mutate(db.id, { onSuccess: () => navigate(paths.databases, { replace: true }) })}
          >
            Delete database
          </ConfirmButton>
        </div>
      )}
      {del.isError && <ErrorBox error={del.error} title="Could not delete the database" />}
    </Box>
  );
}

function GamesBox({ db }: { db: DatabaseInfo }) {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [q, setQ] = useState(urlQ);
  const term = useDebouncedValue(q, 300).trim();
  const written = useRef(urlQ);
  const games = useDatabaseGames(db.id, page, DB_PAGE_SIZE, urlQ);
  const delGame = useDeleteDatabaseGame(db.id);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (urlQ !== written.current) {
      written.current = urlQ;
      setQ(urlQ);
    }
  }, [urlQ]);

  useEffect(() => {
    if (term === written.current.trim()) return;
    written.current = term;
    setParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (term) next.set('q', term);
        else next.delete('q');
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [term, setParams]);

  const goPage = (p: number) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (p > 1) next.set('page', String(p));
      else next.delete('page');
      return next;
    });
    topRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };

  const data = games.data;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize))) : 1;
  const pastEnd = !!data && !games.isPlaceholderData && data.games.length === 0 && data.total > 0 && page > lastPage;
  useEffect(() => {
    if (!pastEnd) return;
    setParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (lastPage > 1) next.set('page', String(lastPage));
        else next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [pastEnd, lastPage, setParams]);

  const columns = useMemo<Column<DbGameRow>[]>(() => {
    const player = (p: DbGameRow['white'], side: 'white' | 'black') => (
      <span className={`lib-gplayer lib-gplayer--${side}`}>
        <i className="lib-gplayer__color" aria-label={side} />
        {p.title && <span className="title-badge">{p.title}</span>}
        <span className="lib-gplayer__name" title={p.name}>
          {p.name}
        </span>
        {p.rating !== null && <span className="lib-gplayer__rating">{p.rating}</span>}
      </span>
    );
    // Column widths live in DatabasesPage.css (`table-layout: fixed`): the fixed columns get theirs,
    // Players / Event / Opening share the rest and ellipsize, so the table never outgrows its box.
    const cols: Column<DbGameRow>[] = [
      {
        key: 'players',
        header: 'Players',
        render: g => (
          <span className="lib-gplayers">
            {player(g.white, 'white')}
            {player(g.black, 'black')}
          </span>
        ),
      },
      { key: 'result', header: 'Result', align: 'center', render: g => <span className="lib-result">{resultLabel(g.result)}</span> },
      { key: 'date', header: 'Date', hideBelow: 480, render: g => <span className="muted lib-clip">{formatDate(g.endedAt, true)}</span> },
      {
        key: 'event',
        header: 'Event',
        hideBelow: GAME_COLUMN_BREAKPOINTS.event,
        render: g => (
          <span className="lib-clip" title={[g.event, g.round && `round ${g.round}`].filter(Boolean).join(', ') || undefined}>
            {g.event ?? '—'}
            {g.round ? <span className="muted"> · R{g.round}</span> : null}
          </span>
        ),
      },
      {
        key: 'opening',
        header: 'Opening',
        hideBelow: GAME_COLUMN_BREAKPOINTS.opening,
        render: g => (
          <span className="lib-clip" title={g.openingName ?? undefined}>
            {g.eco && <span className="lib-eco">{g.eco}</span>} {g.openingName ?? ''}
          </span>
        ),
      },
      { key: 'moves', header: 'Moves', align: 'num', hideBelow: 600, render: g => movesFromPlies(g.plies) },
      {
        key: 'actions',
        header: <span className="visually-hidden">Actions</span>,
        align: 'right',
        render: g => <GameActions game={g} canDelete={db.canEdit} onDelete={() => delGame.mutate(g.id)} />,
      },
    ];
    return cols;
  }, [db.canEdit, delGame]);

  return (
    <Box title="Games" level={2} pad={false}>
      <div ref={topRef} className="lib-gamesbar">
        <SearchField value={q} onChange={setQ} label="Search games" placeholder="Player or event" busy={games.isFetching} />
        {data && (
          <span className="muted lib-nowrap">
            {urlQ ? `${fullNumber(data.total)} matching` : `${fullNumber(data.total)} games`}
          </span>
        )}
      </div>
      {delGame.isError && (
        <div className="lib-pad-x">
          <ErrorBox error={delGame.error} title="Could not delete the game" />
        </div>
      )}
      {data ? (
        data.games.length === 0 && data.total > 0 ? (
          // Past the last page (a stale ?page=, the last game of the page deleted, another tab):
          // the effect above moves to the last page; until then, say so and offer the pages.
          <div>
            <EmptyState icon={licon.List} title={`Page ${fullNumber(page)} is empty`}>
              <p>
                This {urlQ ? 'search' : 'database'} has {fullNumber(lastPage)} {lastPage === 1 ? 'page' : 'pages'}.
              </p>
            </EmptyState>
            <Pagination page={Math.min(page, lastPage)} pageSize={data.pageSize} total={data.total} onPage={goPage} />
          </div>
        ) : data.games.length === 0 ? (
          <EmptyState icon={licon.List} title={urlQ ? `No games match “${urlQ}”` : 'No games yet'}>
            {!urlQ && db.canEdit && db.kind === 'games' && <p>Import a PGN file above to fill this database.</p>}
          </EmptyState>
        ) : (
          <div className={['lib-tablehost', games.isPlaceholderData && 'lib-results--stale'].filter(Boolean).join(' ')}>
            <Table columns={columns} rows={data.games} rowKey={g => g.id} className={db.canEdit ? 'lib-gtable' : 'lib-gtable lib-gtable--readonly'} />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={goPage} />
          </div>
        )
      ) : games.isError ? (
        <div className="lib-pad-x lib-pad-b">
          <ErrorBox error={games.error} onRetry={() => void games.refetch()} />
        </div>
      ) : (
        <Spinner center />
      )}
    </Box>
  );
}

/**
 * Row actions of the games table: open in the Studio, and delete in two steps. The armed state
 * (red "Delete" + cancel) takes the place of both icons, so the column keeps one width; on narrow
 * screens the confirm button is icon-only (DatabasesPage.css).
 */
export function GameActions({ game, canDelete, onDelete }: { game: DbGameRow; canDelete: boolean; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  const vs = `${game.white.name} vs ${game.black.name}`;
  if (armed)
    return (
      <span className="lib-rowactions">
        <Button
          variant="red"
          size="sm"
          icon={licon.Trash}
          className="lib-rowactions__confirm"
          aria-label={`Confirm: delete ${vs}`}
          title="Delete this game for good"
          autoFocus
          onClick={() => {
            setArmed(false);
            onDelete();
          }}
        >
          <span className="lib-rowactions__text">Delete</span>
        </Button>
        <Button variant="empty" size="sm" icon={licon.X} aria-label="Cancel" title="Keep the game" onClick={() => setArmed(false)} />
      </span>
    );
  return (
    <span className="lib-rowactions">
      <a
        className="button button-empty button-thin"
        href={paths.studio({ game: game.id })}
        data-icon={licon.Microscope}
        title="Open in the Studio"
        aria-label={`Analyse ${vs}`}
      />
      {canDelete && (
        <Button variant="empty" size="sm" icon={licon.Trash} aria-label={`Delete ${vs}`} title="Delete this game" onClick={() => setArmed(true)} />
      )}
    </span>
  );
}

/** Make a profile (new, or add to one of mine) from a player name in this database. */
function AttachPlayer({ db }: { db: DatabaseInfo }) {
  const id = useId();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const term = useDebouncedValue(name, 300).trim();
  const suggestions = useDatabaseGames(db.id, 1, DB_PAGE_SIZE, term.length >= 2 ? term : '');
  const mine = useProfiles('mine');
  const add = useAddProfileSource();
  const player = name.trim();

  const names = useMemo(() => {
    const t = term.toLowerCase();
    const seen = new Map<string, number>();
    for (const g of suggestions.data?.games ?? [])
      for (const n of [g.white.name, g.black.name]) if (!t || n.toLowerCase().includes(t)) seen.set(n, (seen.get(n) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([n]) => n);
  }, [suggestions.data, term]);

  const attach = (e: FormEvent) => {
    e.preventDefault();
    if (!player || !target) return;
    add.mutate({ slug: target, source: { kind: 'pgn', key: player, databaseId: db.id } });
  };

  return (
    <Card title="Attach a player to a profile">
      <p className="lib-hint lib-attach__intro">
        Games where this exact name plays White or Black become a source of the profile, next to its online accounts.
      </p>
      <form className="lib-attach" onSubmit={attach}>
        <div className="lib-inline-form">
          <div className="form-group">
            <label htmlFor={`${id}-player`}>Player name, as written in the PGN</label>
            <input
              id={`${id}-player`}
              type="text"
              list={`${id}-names`}
              value={name}
              autoComplete="off"
              placeholder="e.g. Carlsen, Magnus"
              onChange={e => {
                setName(e.target.value);
                add.reset();
              }}
            />
            <datalist id={`${id}-names`}>
              {names.map(n => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          <ButtonLink
            to={newProfileHref([{ kind: 'pgn', key: player, databaseId: db.id }], player)}
            icon={licon.PlusButton}
            aria-disabled={!player}
            onClick={e => {
              if (!player) e.preventDefault();
            }}
          >
            New profile
          </ButtonLink>
        </div>
        <div className="lib-inline-form lib-inline-form--spaced">
          <div className="form-group">
            <label htmlFor={`${id}-target`}>…or add to one of my profiles</label>
            <select id={`${id}-target`} value={target} onChange={e => setTarget(e.target.value)}>
              <option value="">{mine.isPending ? 'Loading…' : mine.data?.profiles.length ? 'Choose a profile…' : 'You have no profiles'}</option>
              {(mine.data?.profiles ?? []).map(p => (
                <option key={p.id} value={p.slug}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" icon={licon.Link} disabled={!player || !target || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add to profile'}
          </Button>
        </div>
        {add.isSuccess && (
          <p className="good lib-attach__done" role="status">
            Added “{player}” to <Link to={paths.profile(add.data.slug)}>{add.data.displayName}</Link>.
          </p>
        )}
        {add.isError && <ErrorBox error={add.error} title="Could not attach the player" />}
      </form>
    </Card>
  );
}
