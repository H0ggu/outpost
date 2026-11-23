import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { PrepSet } from '@outpost/shared/api';
import { Box, Button, EmptyState, ErrorBox, licon, Page } from '../components/index.ts';
import { paths } from '../paths.ts';
import { ConfirmButton } from './components/library/controls.tsx';
import { plural, timeAgo } from './components/library/format.ts';
import { QueryView } from './components/library/QueryView.tsx';
import { useCreatePrep, useDeletePrep, usePrepList } from './library-hooks.ts';
import './components/library/library.css';
import './PrepPage.css';

/**
 * PLAN §9 `/prep`, §6 GET/POST /api/prep: my prep sets (named lists of opponent profiles) and a
 * form to start a new one, which opens it so opponents can be added.
 */
export default function PrepListPage() {
  const list = usePrepList();
  return (
    <Page title="Prep">
      <Box title="Tournament prep">
        <p className="lib-lead">
          Make a set of opponents (a tournament, a club match, a league round) and get a printable report card for each:
          their White and Black repertoire, weak lines, recent games and when they play.
        </p>
        <QueryView query={list} what="your prep sets">
          {d => (
            <>
              <CreatePrep first={d.sets.length === 0} />
              {d.sets.length === 0 ? (
                <EmptyState icon={licon.Target} title="No prep sets yet">
                  <p>Name your first set above, then add opponents to it.</p>
                </EmptyState>
              ) : (
                <ul className="lib-prepsets">
                  {d.sets.map(s => (
                    <PrepSetRow key={s.id} set={s} />
                  ))}
                </ul>
              )}
            </>
          )}
        </QueryView>
      </Box>
    </Page>
  );
}

function CreatePrep({ first }: { first: boolean }) {
  const id = useId();
  const navigate = useNavigate();
  const create = useCreatePrep();
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate({ name: n, profileIds: [] }, { onSuccess: set => navigate(paths.prep(set.id), { state: { added: true } }) });
  };
  return (
    <form className="lib-prep-create" onSubmit={submit} aria-label="New prep set">
      <div className="lib-inline-form">
        <div className="form-group">
          <label htmlFor={`${id}-name`}>{first ? 'Name your first set' : 'New set'}</label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            maxLength={100}
            placeholder="e.g. Club championship 2026"
            onChange={e => setName(e.target.value)}
          />
        </div>
        <Button type="submit" icon={licon.PlusButton} disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
      {create.isError && <ErrorBox error={create.error} title="Could not create the set" />}
    </form>
  );
}

function PrepSetRow({ set }: { set: PrepSet }) {
  const del = useDeletePrep();
  const names = set.opponents.map(o => o.displayName);
  return (
    <li className="lib-prepset">
      <Link to={paths.prep(set.id)} className="lib-prepset__main">
        <span className="lib-prepset__name">
          <i data-icon={licon.Target} aria-hidden />
          {set.name}
        </span>
        <span className="lib-prepset__opps">
          {names.length === 0 ? 'No opponents yet' : `${plural(names.length, 'opponent')}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`}
        </span>
        <span className="lib-prepset__meta">updated {timeAgo(set.updatedAt)}</span>
      </Link>
      <ConfirmButton size="sm" variant="empty" label={`Delete ${set.name}`} confirmLabel="Delete" disabled={del.isPending} onConfirm={() => del.mutate(set.id)} />
      {del.isError && <span className="form-error">{del.error.message}</span>}
    </li>
  );
}
