/**
 * PGN import into a database (PLAN §6 POST /api/databases/:id/import): upload a `.pgn` file
 * (multipart) or paste PGN text. The import is a job: the panel follows it through
 * `DatabaseInfo.importJob` (the database query polls while it is queued or running) and shows a
 * final summary — imported, duplicates, skipped — when it ends.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { PGN_PASTE_MAX_BYTES, PGN_UPLOAD_MAX_BYTES, type DatabaseInfo, type Id, type JobInfo } from '@outpost/shared/api';
import { Button, ErrorBox, licon } from '../../../components/index.ts';
import { isActiveJob, libraryKeys, useImportPgn } from '../../library-hooks.ts';
import { JobProgress } from './controls.tsx';
import { fullNumber, plural, timeAgo } from './format.ts';

/** Upload limit (PLAN §10: PGN 50 MB; the contract's `PGN_UPLOAD_MAX_BYTES`). */
export const MAX_PGN_BYTES = PGN_UPLOAD_MAX_BYTES;
/** Pasted PGN limit (the contract's `PGN_PASTE_MAX_BYTES`): bigger collections are uploaded as a file. */
export const MAX_PASTE_BYTES = PGN_PASTE_MAX_BYTES;

const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;

/** The end of an import as shown to the user. */
export interface ImportOutcome {
  status: JobInfo['status'];
  /** Games added (from the job's counters, else the change in game count). */
  added: number;
  counts: Record<string, number>;
  error: string | null;
  totalNow: number;
}

/** A job we started (or found running) and are following to its end. */
interface Tracked {
  jobId: Id;
  /** Game count when we started following. */
  before: number;
  last: JobInfo;
}

/**
 * Turns the end of a followed import into the summary. `finished` is its final state when the
 * database still reports it (failed or cancelled); otherwise the server's `lastImport` when it is
 * this job (its counters are final); otherwise the last progress seen while polling, which may lag
 * behind, so the change in game count is the better measure of what was added.
 */
export function importOutcome(tracked: Tracked, finished: JobInfo | null, db: DatabaseInfo): ImportOutcome {
  const final = finished ?? (db.lastImport && db.lastImport.id === tracked.jobId ? db.lastImport : null);
  const job = final ?? tracked.last;
  const counts = { ...(job.progress?.counts ?? {}) };
  // Gone from `importJob` without a final state: the server only keeps queued, running and failed ones.
  const status = isActiveJob(job) ? 'done' : job.status;
  const delta = Math.max(0, db.gameCount - tracked.before);
  let added = counts.imported ?? 0;
  if (status === 'done') added = final ? (counts.imported ?? delta) : Math.max(counts.imported ?? 0, delta);
  if (status === 'done' && !final && counts.imported !== undefined) counts.imported = added;
  return { status, added, counts, error: job.error ?? null, totalNow: db.gameCount };
}

/** How the server names the reasons a game was skipped (`skip:<reason>` counters). */
const SKIP_REASONS: Record<string, string> = {
  variant: 'variant',
  fromPosition: 'from a set-up position',
  noResult: 'unfinished',
  noMoves: 'no moves',
  illegalMove: 'illegal move',
};

/** The counters of an import (other than `imported`) as list items: count and label. */
export function importCountItems(counts: Record<string, number>): Array<{ key: string; n: number; label: string }> {
  const items: Array<{ key: string; n: number; label: string }> = [];
  const reasons = Object.entries(counts)
    .filter(([k, n]) => k.startsWith('skip:') && n > 0)
    .map(([k, n]) => `${fullNumber(n)} ${SKIP_REASONS[k.slice(5)] ?? k.slice(5)}`);
  for (const [key, n] of Object.entries(counts)) {
    if (key === 'imported' || key.startsWith('skip:')) continue;
    if (key === 'duplicates') items.push({ key, n, label: n === 1 ? 'duplicate skipped' : 'duplicates skipped' });
    else if (key === 'skipped')
      items.push({ key, n, label: reasons.length ? `skipped (${reasons.join(', ')})` : 'skipped (variants, empty or unreadable)' });
    else if (key === 'errors') items.push({ key, n, label: n === 1 ? 'error' : 'errors' });
    else items.push({ key, n, label: key });
  }
  return items;
}

/** One-line summary of a finished import: "380 imported, 36 duplicates skipped, 4 skipped (…)". */
export function importSummaryText(counts: Record<string, number>): string {
  return [`${fullNumber(counts.imported ?? 0)} imported`, ...importCountItems(counts).filter(i => i.n > 0).map(i => `${fullNumber(i.n)} ${i.label}`)].join(', ');
}

export function ImportPanel({ db }: { db: DatabaseInfo }) {
  const id = useId();
  const qc = useQueryClient();
  const importPgn = useImportPgn(db.id);
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const current = db.importJob;

  // Follow the import: pick up a running one, keep its latest progress, and summarise its end.
  useEffect(() => {
    if (!tracked) {
      if (isActiveJob(current)) setTracked({ jobId: current.id, before: db.gameCount, last: current });
      return;
    }
    const finish = (finished: JobInfo | null) => {
      setOutcome(importOutcome(tracked, finished, db));
      setTracked(null);
      void qc.invalidateQueries({ queryKey: [...libraryKeys.database(db.id), 'games'] });
      void qc.invalidateQueries({ queryKey: libraryKeys.databases, exact: true });
    };
    if (current && current.id === tracked.jobId) {
      if (isActiveJob(current)) {
        if (current !== tracked.last) setTracked({ ...tracked, last: current });
      } else finish(current);
    } else finish(null); // the server only reports queued/running/failed imports: gone means done (see lastImport)
  }, [current, db, tracked, qc]);

  const pickFile = (f: File | null | undefined) => {
    setOutcome(null);
    if (!f) return setFile(null);
    if (f.size > MAX_PGN_BYTES) {
      setFile(null);
      return setError(`That file is ${(f.size / 1048576).toFixed(0)} MB; the limit is ${mb(MAX_PGN_BYTES)}. Split it or import it in parts.`);
    }
    setError(null);
    setFile(f);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setOutcome(null);
    if (mode === 'file' && !file) return setError('Choose a .pgn file first.');
    if (mode === 'paste' && !text.trim()) return setError('Paste some PGN first.');
    if (mode === 'paste' && new Blob([text]).size > MAX_PASTE_BYTES)
      return setError(`That is more than ${mb(MAX_PASTE_BYTES)} of text: save it as a .pgn file and upload it instead (up to ${mb(MAX_PGN_BYTES)}).`);
    setError(null);
    importPgn.mutate(mode === 'file' ? { file: file! } : { pgn: text }, {
      onSuccess: ({ job }) => {
        setTracked({ jobId: job.id, before: db.gameCount, last: job });
        setFile(null);
        setText('');
        if (fileInput.current) fileInput.current.value = '';
      },
    });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setMode('file');
    pickFile(e.dataTransfer.files[0]);
  };

  const running = isActiveJob(current);

  return (
    <div className="lib-import">
      {running && <JobProgress job={current} title="Importing games" />}
      {!running && current?.status === 'error' && !outcome && (
        <JobProgress job={current} title="The last import failed" />
      )}
      {outcome && <ImportSummary outcome={outcome} onDismiss={() => setOutcome(null)} />}
      {!running && !outcome && !tracked && current?.status !== 'error' && db.lastImport?.status === 'done' && (
        <p className="lib-hint lib-lastimport">
          <i data-icon={licon.Checkmark} aria-hidden /> Last import {timeAgo(db.lastImport.finishedAt)}:{' '}
          {importSummaryText(db.lastImport.progress?.counts ?? {})}.
        </p>
      )}

      <form onSubmit={submit} aria-label="Import PGN">
        <div className="lib-seg" role="tablist" aria-label="Import from">
          <button type="button" role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'active' : undefined} data-icon={licon.UploadCloud} onClick={() => setMode('file')}>
            Upload file
          </button>
          <button type="button" role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? 'active' : undefined} data-icon={licon.Clipboard} onClick={() => setMode('paste')}>
            Paste PGN
          </button>
        </div>

        {mode === 'file' ? (
          <label
            htmlFor={`${id}-file`}
            className={dragging ? 'lib-drop lib-drop--over' : 'lib-drop'}
            onDragOver={e => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <i data-icon={licon.UploadCloud} aria-hidden />
            {file ? (
              <span>
                <span>
                  <strong>{file.name}</strong> <span className="muted">({(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB)</span>
                </span>
                <span className="lib-hint">Ready: press Import, or drop another file to replace it.</span>
              </span>
            ) : (
              <span>
                <span>
                  Drop a <strong>.pgn</strong> file here or <span className="lib-link">choose one</span>
                </span>
                <span className="lib-hint">Up to {mb(MAX_PGN_BYTES)}. Every game in the file is imported.</span>
              </span>
            )}
            <input
              ref={fileInput}
              id={`${id}-file`}
              type="file"
              accept=".pgn,application/x-chess-pgn,application/vnd.chess-pgn,text/plain"
              className="visually-hidden"
              onChange={e => pickFile(e.target.files?.[0])}
            />
          </label>
        ) : (
          <div className="form-group lib-paste">
            <label htmlFor={`${id}-pgn`}>PGN</label>
            <textarea
              id={`${id}-pgn`}
              rows={8}
              value={text}
              spellCheck={false}
              placeholder={'[Event "Club championship"]\n[White "…"]\n[Black "…"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 …'}
              onChange={e => setText(e.target.value)}
              aria-describedby={`${id}-pgn-help`}
            />
            <span className="lib-hint" id={`${id}-pgn-help`}>
              Up to {mb(MAX_PASTE_BYTES)}; upload bigger collections as a file.
            </span>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        {importPgn.isError && <ErrorBox error={importPgn.error} title="Import was refused" />}
        <div className="lib-actions lib-actions--end">
          <Button type="submit" icon={licon.UploadCloud} disabled={importPgn.isPending || running}>
            {importPgn.isPending ? 'Uploading…' : running ? 'Import running…' : 'Import'}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** The final summary of an import. */
export function ImportSummary({ outcome, onDismiss }: { outcome: ImportOutcome; onDismiss: () => void }) {
  const ok = outcome.status === 'done';
  const extra = importCountItems(outcome.counts).filter(i => i.n > 0);
  return (
    <div className={ok ? 'lib-summary lib-summary--ok' : 'lib-summary lib-summary--bad'} role="status">
      <i data-icon={ok ? licon.Checkmark : licon.CautionTriangle} aria-hidden />
      <div className="lib-summary__body">
        <strong>
          {ok ? `Import finished: ${plural(outcome.added, 'game')} added` : outcome.status === 'cancelled' ? 'Import cancelled' : 'Import failed'}
        </strong>
        {outcome.error && <div>{outcome.error}</div>}
        <ul className="lib-counts">
          {!ok && outcome.counts.imported !== undefined && (
            <li>
              <strong>{fullNumber(outcome.counts.imported)}</strong> imported before it stopped
            </li>
          )}
          {extra.map(i => (
            <li key={i.key}>
              <strong>{fullNumber(i.n)}</strong> {i.label}
            </li>
          ))}
          <li>
            <strong>{fullNumber(outcome.totalNow)}</strong> games in the database now
          </li>
        </ul>
      </div>
      <Button variant="empty" size="sm" onClick={onDismiss} aria-label="Dismiss">
        OK
      </Button>
    </div>
  );
}
