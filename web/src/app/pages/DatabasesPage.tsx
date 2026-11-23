import { useCallback, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { DatabaseInfo, Visibility } from '@outpost/shared/api';
import { useSession } from '../api/hooks.ts';
import { Box, Button, EmptyState, ErrorBox, Icon, licon, Page, Table, type Column } from '../components/index.ts';
import { paths } from '../paths.ts';
import { ActionErrorToast } from './components/library/controls.tsx';
import { fullNumber, timeAgo } from './components/library/format.ts';
import { QueryView } from './components/library/QueryView.tsx';
import { isActiveJob, useCreateDatabase, useDatabases, useUpdateDatabase } from './library-hooks.ts';
import './components/library/library.css';
import './DatabasesPage.css';

/**
 * PLAN §9 `/databases`, §6 GET/POST /api/databases, §5 custom PGN databases: my databases (with a
 * visibility toggle and import status), public ones shared by others, and the reference databases;
 * plus a form to create a new one.
 */
export default function DatabasesPage() {
  const session = useSession();
  const me = session.data?.user;
  const databases = useDatabases();
  const [showCreate, setShowCreate] = useState(false);

  const groups = useMemo(() => {
    const all = databases.data?.databases ?? [];
    return {
      mine: all.filter(d => d.kind === 'games' && me && d.owner?.id === me.id),
      shared: all.filter(d => d.kind === 'games' && !(me && d.owner?.id === me.id)),
      reference: all.filter(d => d.kind === 'reference'),
    };
  }, [databases.data, me]);

  return (
    <Page title="Databases">
      <Box
        title="Databases"
        actions={
          me && (
            <Button size="sm" icon={licon.PlusButton} aria-expanded={showCreate} onClick={() => setShowCreate(s => !s)}>
              New database
            </Button>
          )
        }
      >
        <p className="lib-lead">
          Upload or paste PGN into your own collections, explore them, export them, or attach a player in them to a
          profile. Duplicates are skipped on import.
        </p>
        {me && showCreate && <CreateDatabase onCancel={() => setShowCreate(false)} />}
        <QueryView query={databases} what="databases">
          {d =>
            d.databases.length === 0 ? (
              <EmptyState icon={licon.List} title="No databases yet">
                <p>Create one, then upload a PGN file or paste games.</p>
                {me && !showCreate && (
                  <Button icon={licon.PlusButton} onClick={() => setShowCreate(true)}>
                    New database
                  </Button>
                )}
              </EmptyState>
            ) : (
              <>
                {me && (
                  <DbSection title="My databases" rows={groups.mine} variant="mine" empty="You have no databases yet." />
                )}
                {groups.shared.length > 0 && <DbSection title="Shared by others" rows={groups.shared} variant="shared" />}
                {groups.reference.length > 0 && <DbSection title="Reference databases" rows={groups.reference} variant="reference" />}
              </>
            )
          }
        </QueryView>
      </Box>
    </Page>
  );
}

function CreateDatabase({ onCancel }: { onCancel: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const create = useCreateDatabase();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [sourceLabel, setSourceLabel] = useState('');
  const [licence, setLicence] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError('Give the database a name.');
    setError(null);
    create.mutate(
      {
        name: n,
        visibility,
        ...(sourceLabel.trim() ? { sourceLabel: sourceLabel.trim() } : {}),
        ...(licence.trim() ? { licence: licence.trim() } : {}),
      },
      { onSuccess: db => navigate(paths.database(db.id)) },
    );
  };

  return (
    <form className="lib-panel" onSubmit={submit} aria-label="New database">
      <div className="lib-inline-form">
        <div className="form-group">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} type="text" value={name} maxLength={100} autoFocus onChange={e => setName(e.target.value)} />
        </div>
        <div className="form-group form-group--narrow">
          <label htmlFor={`${id}-vis`}>Visibility</label>
          <select id={`${id}-vis`} value={visibility} onChange={e => setVisibility(e.target.value as Visibility)}>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </div>
      </div>
      <div className="lib-inline-form lib-inline-form--spaced">
        <div className="form-group">
          <label htmlFor={`${id}-src`}>Source (optional)</label>
          <input id={`${id}-src`} type="text" value={sourceLabel} maxLength={200} placeholder="e.g. TWIC, club archive" onChange={e => setSourceLabel(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor={`${id}-lic`}>Licence (optional)</label>
          <input id={`${id}-lic`} type="text" value={licence} maxLength={200} placeholder="e.g. CC0" onChange={e => setLicence(e.target.value)} />
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {create.isError && <ErrorBox error={create.error} title="Could not create the database" />}
      <div className="lib-actions lib-actions--end">
        <Button variant="empty" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" icon={licon.Checkmark} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}

/** Private / public toggle of one of my databases; a failure is said in a toast. */
function VisibilityToggle({ db }: { db: DatabaseInfo }) {
  const update = useUpdateDatabase();
  const [failure, setFailure] = useState<{ error: unknown; wanted: Visibility } | null>(null);
  const dismiss = useCallback(() => setFailure(null), []);
  const next: Visibility = db.visibility === 'private' ? 'public' : 'private';
  return (
    <>
      <button
        type="button"
        className={`lib-vis lib-vis--${db.visibility}`}
        data-icon={db.visibility === 'private' ? licon.Padlock : licon.Globe}
        title={`Make ${next}`}
        aria-label={`${db.name} is ${db.visibility}; make it ${next}`}
        disabled={update.isPending}
        onClick={() => {
          setFailure(null);
          update.mutate({ id: db.id, patch: { visibility: next } }, { onError: error => setFailure({ error, wanted: next }) });
        }}
      >
        {db.visibility === 'private' ? 'Private' : 'Public'}
      </button>
      {failure && <ActionErrorToast error={failure.error} what={`make ${db.name} ${failure.wanted}`} onClose={dismiss} />}
    </>
  );
}

function DbSection({
  title,
  rows,
  variant,
  empty,
}: {
  title: string;
  rows: DatabaseInfo[];
  variant: 'mine' | 'shared' | 'reference';
  empty?: string;
}) {
  const columns: Column<DatabaseInfo>[] = [
    {
      key: 'name',
      header: 'Name',
      render: d => (
        <span className="lib-dbname">
          <Link to={paths.database(d.id)}>{d.name}</Link>
          {d.sourceLabel && <span className="lib-dbname__src">{d.sourceLabel}</span>}
        </span>
      ),
    },
    { key: 'games', header: 'Games', align: 'num', render: d => fullNumber(d.gameCount) },
  ];
  if (variant === 'mine') {
    columns.push({ key: 'vis', header: 'Visibility', render: d => <VisibilityToggle db={d} /> });
    columns.push({
      key: 'import',
      header: 'Import',
      hideBelow: 640,
      render: d =>
        isActiveJob(d.importJob) ? (
          <span className="lib-pill lib-pill--warn" data-icon={licon.Reload}>
            {d.importJob.status === 'queued' ? 'queued' : 'importing'}
          </span>
        ) : d.importJob?.status === 'error' ? (
          <span className="lib-pill bad" data-icon={licon.CautionTriangle}>
            failed
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    });
  } else
    columns.push({
      key: 'owner',
      header: variant === 'reference' ? 'Licence' : 'Owner',
      hideBelow: 560,
      render: d => <span className="muted">{variant === 'reference' ? (d.licence ?? '—') : (d.owner?.username ?? '—')}</span>,
    });
  columns.push({ key: 'created', header: 'Created', hideBelow: 760, render: d => <span className="muted">{timeAgo(d.createdAt)}</span> });

  return (
    <section className="lib-dbsection">
      <h2 className="lib-section-title">
        {variant === 'reference' ? <Icon glyph={licon.Book} /> : variant === 'shared' ? <Icon glyph={licon.Globe} /> : <Icon glyph={licon.User} />}
        {title}
        {rows.length > 0 && <span className="lib-count">{rows.length}</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <Table columns={columns} rows={rows} rowKey={d => d.id} className="lib-dbtable" />
      )}
    </section>
  );
}
