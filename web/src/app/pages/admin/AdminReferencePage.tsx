/**
 * `/admin/reference` (PLAN §5 pluggable reference database; §6 GET /api/reference, POST
 * /api/admin/reference/broadcast-months and /import): the reference databases with their licence
 * and import state, a month picker for the database.lichess.org broadcast dumps (CC BY-SA 4.0),
 * and a PGN import (file upload with progress, or a URL) into an existing or a new named
 * reference database. Polls while an import is queued or running.
 */
import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { BroadcastMonthStatus, DatabaseInfo, Id, ImportResponse, IsoMonth, ReferenceInfo } from '@outpost/shared/api';
import { Box, Button, EmptyState, ErrorBox, licon, Spinner, Table, useDocumentTitle, type Column } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import { isActiveJob, useImportBroadcastMonths, useReferenceImport, useReferenceInfo } from '../account-hooks.ts';
import { formatBytes, formatCount, useTimeFormat } from '../components/account/format.ts';
import { describeError, Field, Flash, formErrors, RadioGroup, TextField } from '../components/account/forms.tsx';
import { JobStatusBadge, ProgressBar, progressText } from '../components/account/JobProgress.tsx';
import { groupMonthsByYear, MONTH_NAMES, monthLabel, selectableMonth } from '../components/account/months.ts';
import './admin.css';

export default function AdminReferencePage() {
  useDocumentTitle('Reference DB · Admin');
  const info = useReferenceInfo();
  if (info.isPending)
    return (
      <Box title="Reference databases" level={2}>
        <Spinner center />
      </Box>
    );
  if (info.isError && !info.data)
    return (
      <Box title="Reference databases" level={2}>
        <ErrorBox error={info.error} onRetry={() => void info.refetch()} />
      </Box>
    );
  const data = info.data!;
  return (
    <>
      <DatabasesBox info={data} />
      <BroadcastMonthsBox info={data} />
      <ImportBox databases={data.databases} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Databases and licences
// ---------------------------------------------------------------------------

function DatabasesBox({ info }: { info: ReferenceInfo }) {
  const fmt = useTimeFormat();
  const columns: Column<DatabaseInfo>[] = [
    {
      key: 'name',
      header: 'Database',
      render: d => (
        <div className="adm-refdb">
          <Link to={paths.database(d.id)} className="adm-refdb__name">
            {d.name}
          </Link>
          {d.sourceLabel && <span className="adm-refdb__src">{d.sourceLabel}</span>}
          {d.importJob && (isActiveJob(d.importJob) || d.importJob.status === 'error') && (
            <div className="adm-refdb__job">
              <JobStatusBadge job={d.importJob} />
              {isActiveJob(d.importJob) && <ProgressBar job={d.importJob} label={`${d.name} import progress`} />}
              <span className="adm-job__text">{d.importJob.status === 'error' ? d.importJob.error : progressText(d.importJob)}</span>
            </div>
          )}
        </div>
      ),
    },
    { key: 'games', header: 'Games', align: 'num', render: d => formatCount(d.gameCount) },
    {
      key: 'licence',
      header: 'Licence',
      hideBelow: 640,
      render: d => (d.licence ? <span className="adm-licence">{d.licence}</span> : <span className="muted">not stated</span>),
    },
    {
      key: 'vis',
      header: 'Visibility',
      hideBelow: 820,
      render: d => (
        <span title={d.visibility === 'public' ? 'Every user can explore it' : 'Only admins see it'}>
          <i data-icon={d.visibility === 'public' ? licon.Globe : licon.Padlock} aria-hidden /> {d.visibility === 'public' ? 'Public' : 'Private'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      hideBelow: 960,
      render: d => <span title={fmt.dateTime(d.createdAt)}>{fmt.date(d.createdAt)}</span>,
    },
  ];

  return (
    <Box
      title="Reference databases"
      level={2}
      pad={false}
      actions={<span className="muted">{formatCount(info.totalGames)} games</span>}
    >
      <p className="adm-pad muted">
        Over-the-board games for the masters explorer, FIDE player profiles and opponent prep. Choose which database the Studio's
        “Masters” explorer uses in <Link to={paths.admin.settings}>Settings</Link>.
      </p>
      <Table
        className="adm-refdbs"
        columns={columns}
        rows={info.databases}
        rowKey={d => d.id}
        empty={<EmptyState icon={licon.Book} title="No reference database yet">Import broadcast months or a PGN below.</EmptyState>}
      />
      {info.attribution.length > 0 && (
        <div className="adm-pad adm-pad--top adm-attribution">
          <h3>Attribution</h3>
          {info.attribution.map(line => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Broadcast months
// ---------------------------------------------------------------------------

const MONTH_STATUS_TEXT: Record<BroadcastMonthStatus['status'], string> = {
  available: 'Not imported',
  queued: 'Queued',
  importing: 'Importing',
  imported: 'Imported',
  error: 'Failed',
};

function BroadcastMonthsBox({ info }: { info: ReferenceInfo }) {
  const importMonths = useImportBroadcastMonths();
  const [selected, setSelected] = useState<Set<IsoMonth>>(new Set());
  const [target, setTarget] = useState<string>('');
  const [result, setResult] = useState<string | null>(null);
  const fmt = useTimeFormat();

  const months = info.broadcastMonths;
  const byYear = useMemo(() => groupMonthsByYear(months), [months]);
  const byMonth = useMemo(() => new Map(months.map(m => [m.month, m])), [months]);
  const imported = months.filter(m => m.status === 'imported');
  const importedGames = imported.reduce((n, m) => n + m.games, 0);
  const missing = months.filter(m => m.status === 'available' || m.status === 'error').map(m => m.month);
  // Months can only be chosen while not already queued or importing.
  const chosen = [...selected].filter(m => {
    const s = byMonth.get(m);
    return s !== undefined && selectableMonth(s);
  });

  const toggle = (m: IsoMonth) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen.length) return;
    setResult(null);
    importMonths.mutate(
      { months: [...chosen].sort(), ...(target ? { databaseId: Number(target) } : {}) },
      {
        onSuccess: res => {
          setSelected(new Set());
          setResult(`${res.jobs.length} month${res.jobs.length === 1 ? '' : 's'} queued for import.`);
        },
      },
    );
  };

  return (
    <Box
      title="Lichess broadcasts"
      level={2}
      actions={
        <span className="muted">
          {imported.length} of {months.length} months · {formatCount(importedGames)} games
        </span>
      }
    >
      <p className="muted">
        Monthly dumps of every official Lichess broadcast from{' '}
        <a href="https://database.lichess.org/#broadcasts" target="_blank" rel="noreferrer noopener">
          database.lichess.org
        </a>
        , licensed CC BY-SA 4.0. Each month is downloaded and imported as a background job; importing a month again only adds
        games that are missing.
      </p>
      {months.length === 0 ? (
        <EmptyState icon={licon.RadioTower} title="No broadcast months listed">
          The list of published months could not be loaded. Check the status panel in Settings.
        </EmptyState>
      ) : (
        <form onSubmit={submit} aria-label="Import broadcast months">
          <div className="adm-months" role="group" aria-label="Broadcast months">
            {byYear.map(([year, row]) => (
              <div key={year} className="adm-months__year">
                <span className="adm-months__label">{year}</span>
                <div className="adm-months__row">
                  {row.map((m, i) => {
                    if (!m) return <span key={i} className="adm-month adm-month--none" aria-hidden />;
                    const can = selectableMonth(m);
                    const on = selected.has(m.month) && can;
                    const title = [
                      `${monthLabel(m.month)}: ${MONTH_STATUS_TEXT[m.status]}`,
                      m.games ? `${formatCount(m.games)} games` : null,
                      m.importedAt ? `imported ${fmt.date(m.importedAt)}` : null,
                      m.error ?? null,
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <button
                        key={m.month}
                        type="button"
                        className={['adm-month', `adm-month--${m.status}`, on && 'adm-month--on'].filter(Boolean).join(' ')}
                        aria-pressed={on}
                        disabled={!can}
                        title={title}
                        aria-label={title}
                        onClick={() => toggle(m.month)}
                      >
                        <span className="adm-month__name">{MONTH_NAMES[Number(m.month.slice(5, 7)) - 1]}</span>
                        <span className="adm-month__state" aria-hidden>
                          {m.status === 'imported' ? (
                            m.games >= 1000 ? `${Math.round(m.games / 1000)}k` : m.games
                          ) : m.status === 'queued' || m.status === 'importing' ? (
                            <i data-icon={m.status === 'importing' ? licon.Reload : licon.Clock} className={m.status === 'importing' ? 'adm-spin' : undefined} />
                          ) : m.status === 'error' ? (
                            <i data-icon={licon.CautionCircle} />
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <ul className="adm-legend" aria-label="Legend">
            <li className="adm-legend__imported">Imported (games)</li>
            <li className="adm-legend__available">Not imported</li>
            <li className="adm-legend__importing">Queued or importing</li>
            <li className="adm-legend__error">Failed</li>
          </ul>
          <div className="adm-months__bar">
            <Button variant="secondary" size="sm" disabled={!missing.length} onClick={() => setSelected(new Set(missing))}>
              Select all not imported ({missing.length})
            </Button>
            <Button variant="empty" size="sm" disabled={!selected.size} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            {info.databases.length > 1 && (
              <label className="adm-inline-select">
                <span>Into</span>
                <select className="form-control" value={target} onChange={e => setTarget(e.target.value)}>
                  <option value="">Lichess broadcasts (built-in)</option>
                  {info.databases.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="adm-months__spacer" />
            <Button type="submit" icon={licon.Download} disabled={!chosen.length || importMonths.isPending}>
              {importMonths.isPending ? 'Queueing…' : chosen.length ? `Import ${chosen.length} month${chosen.length === 1 ? '' : 's'}` : 'Import'}
            </Button>
          </div>
          {importMonths.isError && <Flash kind="failure">{describeError(importMonths.error)}</Flash>}
          {result && (
            <Flash>
              {result} Follow them in <Link to={paths.admin.jobs}>Jobs</Link>.
            </Flash>
          )}
        </form>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// PGN import (file or URL)
// ---------------------------------------------------------------------------

/** Accepted upload types (the server detects zstd and gzip by content). */
const ACCEPT = '.pgn,.zst,.gz,.txt,application/x-chess-pgn,application/vnd.chess-pgn,application/zstd,application/gzip,text/plain';

function ImportBox({ databases }: { databases: DatabaseInfo[] }) {
  const importRef = useReferenceImport();
  const [source, setSource] = useState<'file' | 'url'>('file');
  const [target, setTarget] = useState<'new' | 'existing'>(databases.length ? 'existing' : 'new');
  const [databaseId, setDatabaseId] = useState<string>(databases[0] ? String(databases[0].id) : '');
  const [name, setName] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [licence, setLicence] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [queued, setQueued] = useState<ImportResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const useExisting = target === 'existing' && databases.length > 0;
  const { field, form } = formErrors(importRef.error, ['url', 'file', 'databaseId', 'databaseName', 'sourceLabel', 'licence'], problems);
  const cancelled = importRef.error instanceof DOMException && importRef.error.name === 'AbortError';

  const pickFile = (f: File | null | undefined) => {
    setFile(f ?? null);
    setProblems(p => ({ ...p, file: '' }));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files[0]);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQueued(null);
    const p: Record<string, string> = {};
    if (source === 'file' && !file) p.file = 'Choose a PGN file.';
    if (source === 'url') {
      const u = url.trim();
      if (!u) p.url = 'Enter the address of a PGN file.';
      else if (!/^https?:\/\/\S+$/i.test(u)) p.url = 'Use a full http(s):// address.';
    }
    if (!useExisting && !name.trim()) p.databaseName = 'Name the new reference database.';
    setProblems(p);
    if (Object.keys(p).length) return;

    const labels = {
      ...(sourceLabel.trim() ? { sourceLabel: sourceLabel.trim() } : {}),
      ...(licence.trim() ? { licence: licence.trim() } : {}),
    };
    const into = useExisting ? { databaseId: Number(databaseId) as Id } : { databaseName: name.trim() };
    const done = (res: ImportResponse) => {
      setQueued(res);
      setProgress(null);
      setFile(null);
      setUrl('');
      if (fileInput.current) fileInput.current.value = '';
    };
    if (source === 'url') {
      importRef.mutate({ source: 'url', request: { url: url.trim(), ...into, ...labels } }, { onSuccess: done });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ loaded: 0, total: file!.size });
    importRef.mutate(
      {
        source: 'file',
        file: file!,
        request: { ...into, ...labels },
        onProgress: (loaded, total) => setProgress({ loaded, total }),
        signal: ctrl.signal,
      },
      { onSuccess: done, onError: () => setProgress(null) },
    );
  };

  const uploading = importRef.isPending && source === 'file';
  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  return (
    <Box title="Import PGN" level={2}>
      <form onSubmit={submit} noValidate className="acc-form" aria-label="Import PGN into a reference database">
        <RadioGroup
          legend="Games from"
          name="ref-source"
          value={source}
          onChange={v => {
            setSource(v);
            setProblems({});
            importRef.reset();
          }}
          options={[
            { value: 'file', label: 'A file', icon: licon.UploadCloud },
            { value: 'url', label: 'A URL', icon: licon.Link },
          ]}
        />
        {source === 'file' ? (
          <Field id="ref-file" label="PGN file" error={field.file} help="A .pgn file, optionally compressed (.pgn.zst, .pgn.gz), up to 2 GB.">
            <div
              className={['adm-drop', dragging && 'adm-drop--over', file && 'adm-drop--picked'].filter(Boolean).join(' ')}
              onDragOver={e => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <i data-icon={licon.UploadCloud} aria-hidden />
              <span>
                {file ? (
                  <>
                    <strong>{file.name}</strong> <span className="muted">({formatBytes(file.size)})</span>
                  </>
                ) : (
                  'Drop a file here, or'
                )}
              </span>
              <label className="button button-secondary button-thin adm-drop__pick">
                {file ? 'Choose another' : 'Choose a file'}
                <input
                  ref={fileInput}
                  id="ref-file"
                  type="file"
                  accept={ACCEPT}
                  className="visually-hidden"
                  aria-describedby="ref-file-help"
                  onChange={e => pickFile(e.target.files?.[0])}
                />
              </label>
            </div>
          </Field>
        ) : (
          <TextField
            id="ref-url"
            label="URL"
            type="url"
            inputMode="url"
            placeholder="https://…/games.pgn"
            value={url}
            onChange={e => setUrl(e.target.value)}
            error={field.url}
            help="A PGN file (also .zst or .gz), or a Lichess broadcast tournament or round page (a round needs the Lichess token)."
          />
        )}

        <RadioGroup
          legend="Into"
          name="ref-target"
          value={useExisting ? 'existing' : 'new'}
          onChange={setTarget}
          options={[
            { value: 'existing', label: 'An existing database', disabled: databases.length === 0 },
            { value: 'new', label: 'A new database' },
          ]}
        />
        {useExisting ? (
          <Field id="ref-db" label="Reference database" error={field.databaseId}>
            <select id="ref-db" className="form-control" value={databaseId} onChange={e => setDatabaseId(e.target.value)}>
              {databases.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} ({formatCount(d.gameCount)} games)
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <TextField
            id="ref-name"
            label="Name"
            placeholder="e.g. TWIC 2026"
            maxLength={120}
            value={name}
            onChange={e => setName(e.target.value)}
            error={field.databaseName}
          />
        )}
        <div className="adm-row">
          <TextField
            id="ref-label"
            label="Source"
            placeholder="Where the games come from"
            maxLength={120}
            value={sourceLabel}
            onChange={e => setSourceLabel(e.target.value)}
            error={field.sourceLabel}
            help={useExisting ? 'Leave empty to keep the current source.' : undefined}
          />
          <TextField
            id="ref-licence"
            label="Licence / attribution"
            placeholder="e.g. CC BY-SA 4.0"
            maxLength={500}
            value={licence}
            onChange={e => setLicence(e.target.value)}
            error={field.licence}
            help="Shown wherever these games appear. Only import games you may use."
          />
        </div>

        {uploading && progress && (
          <div className="adm-upload" role="status">
            <div className="acc-progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <span className="muted">
              Uploading {formatBytes(progress.loaded)} of {formatBytes(progress.total)} ({pct}%)
              {pct >= 100 && ' · the server is saving the file…'}
            </span>
          </div>
        )}
        {form && !cancelled && <Flash kind="failure">{form}</Flash>}
        {cancelled && <Flash kind="quiet">Upload cancelled.</Flash>}
        {queued && (
          <Flash>
            Import queued as job #{queued.job.id}. It runs in the background; follow it in <Link to={paths.admin.jobs}>Jobs</Link>.
          </Flash>
        )}
        <div className="acc-actions acc-actions--start">
          <Button type="submit" icon={licon.UploadCloud} disabled={importRef.isPending}>
            {importRef.isPending ? (source === 'file' ? 'Uploading…' : 'Queueing…') : 'Import'}
          </Button>
          {uploading && (
            <Button variant="secondary" icon={licon.X} onClick={() => abortRef.current?.abort()}>
              Cancel upload
            </Button>
          )}
        </div>
      </form>
    </Box>
  );
}
