import { useId, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Id, PrepSet, ProfileSummary } from '@outpost/shared/api';
import { TIME_CLASSES, type TimeClass } from '@outpost/shared/chess';
import { PERIODS, type Period, type ProfileFilters } from '@outpost/shared/filters';
import { ApiError } from '../api/client.ts';
import { browserTimeZone, useSession, useUrlFilters } from '../api/hooks.ts';
import { Box, Button, ButtonLink, Card, EmptyState, ErrorBox, licon, Page, Spinner, TIME_CLASS_LABELS } from '../components/index.ts';
import { paths } from '../paths.ts';
import { ConfirmButton } from './components/library/controls.tsx';
import { formatDateTime } from './components/library/format.ts';
import { OpponentPicker } from './components/library/OpponentPicker.tsx';
import { PrepReportCard } from './components/library/PrepReportCard.tsx';
import { SourceBadges } from './components/library/ProfileList.tsx';
import { isUnauthorized, QueryView, SignInPrompt } from './components/library/QueryView.tsx';
import { useDeletePrep, usePrepReport, usePrepSet, useUpdatePrep } from './library-hooks.ts';
import './components/library/library.css';
import './PrepPage.css';

const PERIOD_LABELS: Record<Period, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
};

/** Time classes offered in the prep filter (`unknown` is for PGN games and rarely useful here). */
const PREP_TCS = TIME_CLASSES.filter(tc => tc !== 'unknown');

/** Repertoire line lengths offered (plies; the server's default is 8, i.e. 4 moves each). */
export const LINE_PLIES = [6, 8, 10, 12, 16] as const;
const DEFAULT_PLIES = 8;

/** `?plies=` when it is one of LINE_PLIES, else undefined (the server default). */
export function parsePlies(v: string | null): number | undefined {
  const n = Number(v);
  return (LINE_PLIES as readonly number[]).includes(n) && n !== DEFAULT_PLIES ? n : undefined;
}

/** "Last 12 months · Blitz, Rapid · rated" — the filters in words (print header). */
export function describeFilters(f: ProfileFilters): string {
  const parts: string[] = [f.period ? PERIOD_LABELS[f.period] : 'All time'];
  if (f.tc?.length) parts.push(f.tc.map(tc => TIME_CLASS_LABELS[tc]).join(', '));
  if (f.rated) parts.push(f.rated === 'rated' ? 'rated only' : 'casual only');
  return parts.join(' · ');
}

/**
 * PLAN §9 `/prep/:id`, §5 tournament preparation, §6 GET/PUT/DELETE /api/prep/:id and
 * GET /api/prep/:id/report: manage the opponents (add from my profiles, bookmarks or search;
 * remove), filter the report (period, time controls, rated; kept in the URL), and read one report
 * card per opponent. "Print" gives a clean paper version (PrepPage.css, @media print).
 */
export default function PrepPage() {
  const { id = '' } = useParams();
  const prepId: Id | undefined = /^[1-9]\d{0,15}$/.test(id) ? Number(id) : undefined;
  const set = usePrepSet(prepId);

  if (prepId === undefined || (set.error instanceof ApiError && set.error.isNotFound))
    return (
      <Page title="Prep set not found">
        <Box title="Prep set not found">
          <EmptyState icon={licon.Target} title="This prep set doesn't exist (or isn't yours).">
            <ButtonLink to={paths.prepList} variant="secondary" icon={licon.Back}>
              All prep sets
            </ButtonLink>
          </EmptyState>
        </Box>
      </Page>
    );

  return (
    <Page title={set.data ? `Prep: ${set.data.name}` : 'Prep'}>
      <div className="lib-prep-page">
        {set.data ? (
          <PrepView set={set.data} />
        ) : set.isError ? (
          <Box title="Prep">
            {isUnauthorized(set.error) ? <SignInPrompt what="your prep" /> : <ErrorBox error={set.error} onRetry={() => void set.refetch()} />}
          </Box>
        ) : (
          <Spinner center />
        )}
      </div>
    </Page>
  );
}

function PrepView({ set }: { set: PrepSet }) {
  const location = useLocation();
  const justCreated = (location.state as { added?: boolean } | null)?.added === true;
  const [editing, setEditing] = useState(justCreated || set.opponents.length === 0);
  const update = useUpdatePrep();
  const ids = set.opponents.map(o => o.id);

  const setOpponents = (profileIds: Id[]) => update.mutateAsync({ id: set.id, body: { profileIds } });

  return (
    <>
      <PrepHeader set={set} />

      <Card
        title={`Opponents (${set.opponents.length})`}
        className="no-print lib-prep-opps"
        actions={
          set.opponents.length > 0 && (
            <Button size="sm" variant={editing ? 'empty' : 'secondary'} icon={editing ? licon.Checkmark : licon.PlusButton} onClick={() => setEditing(e => !e)} aria-expanded={editing}>
              {editing ? 'Done' : 'Add opponents'}
            </Button>
          )
        }
      >
        {set.opponents.length > 0 && (
          <ul className="lib-prep-opplist">
            {set.opponents.map(o => (
              <OpponentChip key={o.id} profile={o} disabled={update.isPending} onRemove={() => void setOpponents(ids.filter(x => x !== o.id)).catch(() => undefined)} />
            ))}
          </ul>
        )}
        {update.isError && <ErrorBox error={update.error} title="Could not save the opponents" />}
        {(editing || set.opponents.length === 0) && (
          <OpponentPicker existing={ids} busy={update.isPending} onAdd={pid => setOpponents(ids.includes(pid) ? ids : [...ids, pid])} />
        )}
      </Card>

      {set.opponents.length > 0 && <Report set={set} />}
    </>
  );
}

function PrepHeader({ set }: { set: PrepSet }) {
  const navigate = useNavigate();
  const update = useUpdatePrep();
  const del = useDeletePrep();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(set.name);
  const nameId = useId();
  const rename = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === set.name) return setRenaming(false);
    update.mutate({ id: set.id, body: { name: n } }, { onSuccess: () => setRenaming(false) });
  };
  return (
    <Box
      className="lib-prep-header"
      title={
        renaming ? (
          <form className="lib-rename" onSubmit={rename}>
            <label htmlFor={nameId} className="visually-hidden">
              Set name
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
            {set.name}
            <button
              type="button"
              className="lib-icon-btn lib-icon-btn--inline no-print"
              data-icon={licon.Pencil}
              aria-label="Rename"
              title="Rename"
              onClick={() => {
                setName(set.name);
                setRenaming(true);
              }}
            />
          </span>
        )
      }
      actions={
        <span className="lib-actions no-print">
          <Link to={paths.prepList} className="button button-empty button-thin" data-icon={licon.Back}>
            All sets
          </Link>
          {set.opponents.length > 0 && (
            <Button size="sm" variant="secondary" icon={licon.Download} onClick={() => window.print()}>
              Print
            </Button>
          )}
          <ConfirmButton size="sm" confirmLabel="Delete set" disabled={del.isPending} onConfirm={() => del.mutate(set.id, { onSuccess: () => navigate(paths.prepList, { replace: true }) })}>
            Delete
          </ConfirmButton>
        </span>
      }
    >
      {update.isError && <ErrorBox error={update.error} title="Could not rename" />}
      {del.isError && <ErrorBox error={del.error} title="Could not delete" />}
    </Box>
  );
}

function OpponentChip({ profile, onRemove, disabled }: { profile: ProfileSummary; onRemove: () => void; disabled: boolean }) {
  return (
    <li className="lib-prep-opp">
      <a href={`#prep-opp-${profile.id}`} className="lib-prep-opp__name">
        {profile.displayName}
      </a>
      <SourceBadges sources={profile.sources} max={2} />
      <button type="button" className="lib-icon-btn lib-icon-btn--danger" data-icon={licon.X} aria-label={`Remove ${profile.displayName}`} title="Remove from this set" disabled={disabled} onClick={onRemove} />
    </li>
  );
}

function PrepFilters({
  filters,
  setFilters,
  plies,
  setPlies,
}: {
  filters: ProfileFilters;
  setFilters: (f: ProfileFilters) => void;
  plies: number | undefined;
  setPlies: (plies: number | undefined) => void;
}) {
  const id = useId();
  const toggleTc = (tc: TimeClass) => {
    const cur = new Set(filters.tc ?? []);
    if (cur.has(tc)) cur.delete(tc);
    else cur.add(tc);
    setFilters({ ...filters, tc: [...cur] });
  };
  return (
    <div className="lib-prep-filters no-print" role="group" aria-label="Report filters">
      <div className="form-group">
        <label htmlFor={`${id}-period`}>Period</label>
        <select
          id={`${id}-period`}
          value={filters.period ?? ''}
          onChange={e => setFilters({ ...filters, period: (e.target.value || undefined) as Period | undefined, from: undefined, to: undefined })}
        >
          <option value="">All time</option>
          {PERIODS.filter(p => p !== '24h').map(p => (
            <option key={p} value={p}>
              {PERIOD_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="lib-tcs">
        <legend>Time controls</legend>
        {PREP_TCS.map(tc => (
          <label key={tc} className={filters.tc?.includes(tc) ? 'lib-tc lib-tc--on' : 'lib-tc'}>
            <input type="checkbox" className="visually-hidden" checked={!!filters.tc?.includes(tc)} onChange={() => toggleTc(tc)} />
            {TIME_CLASS_LABELS[tc]}
          </label>
        ))}
      </fieldset>
      <div className="form-group">
        <label htmlFor={`${id}-rated`}>Games</label>
        <select
          id={`${id}-rated`}
          value={filters.rated ?? ''}
          onChange={e => setFilters({ ...filters, rated: (e.target.value || undefined) as ProfileFilters['rated'] })}
        >
          <option value="">Rated and casual</option>
          <option value="rated">Rated only</option>
          <option value="unrated">Casual only</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor={`${id}-plies`}>Line length</label>
        <select id={`${id}-plies`} value={plies ?? DEFAULT_PLIES} onChange={e => setPlies(parsePlies(e.target.value))}>
          {LINE_PLIES.map(n => (
            <option key={n} value={n}>
              {n / 2} moves
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Report({ set }: { set: PrepSet }) {
  const session = useSession();
  const utc = session.data?.user?.prefs.timezone === 'utc';
  const tz = utc ? 'UTC' : browserTimeZone();
  const [filters, setFilters] = useUrlFilters();
  const [params, setParams] = useSearchParams();
  const plies = parsePlies(params.get('plies'));
  const setPlies = (n: number | undefined) =>
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (n === undefined) next.delete('plies');
      else next.set('plies', String(n));
      return next;
    });
  const report = usePrepReport(set.id, filters, tz, plies);

  return (
    <section className="lib-prep-report" aria-label="Report cards">
      <PrepFilters filters={filters} setFilters={f => setFilters(f)} plies={plies} setPlies={setPlies} />
      <QueryView query={report} what="this report" errorTitle="Could not build the report">
        {r => (
          <div className={report.isPlaceholderData ? 'lib-prep-cards lib-results--stale' : 'lib-prep-cards'} aria-busy={report.isFetching}>
            <p className="lib-prep-printhead">
              <strong>{r.prep.name}</strong> · {describeFilters(filters)} · lines of {(plies ?? DEFAULT_PLIES) / 2} moves · generated{' '}
              {formatDateTime(r.generatedAt, utc)}
            </p>
            {r.opponents.length === 0 ? (
              <EmptyState icon={licon.Target} title="No report yet">
                <p>The opponents in this set have no games yet. Check back once their profiles have synced.</p>
              </EmptyState>
            ) : (
              r.opponents.map(o => <PrepReportCard key={o.profile.id} report={o} filters={filters} utc={utc} />)
            )}
          </div>
        )}
      </QueryView>
    </section>
  );
}
