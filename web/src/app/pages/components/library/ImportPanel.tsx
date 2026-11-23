/**
 * PGN import into a database (PLAN §6 POST /api/databases/:id/import): upload a `.pgn` file
 * (multipart) or paste PGN text. The import is a job: the panel follows it through
 * `DatabaseInfo.importJob` (the database query polls while it is queued or running) and shows a
 * final summary — imported, duplicates, skipped — when it ends.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { DatabaseInfo, Id, JobInfo } from '@outpost/shared/api';
import { Button, ErrorBox, licon } from '../../../components/index.ts';
import { isActiveJob, libraryKeys, useImportPgn } from '../../library-hooks.ts';
import { JobProgress } from './controls.tsx';
import { fullNumber, plural } from './format.ts';

/** Upload limit (PLAN §10: PGN 50 MB). */
export const MAX_PGN_BYTES = 50 * 1024 * 1024;

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

/** Turns the last seen state of a finished job into the summary. */
export function importOutcome(tracked: Tracked, finished: JobInfo | null, db: DatabaseInfo): ImportOutcome {
  // No final state seen: the server dropped the job from `importJob`, which it does when it is done
  // (unless the last state we saw already was the end).
  const job = finished ?? tracked.last;
  const counts = { ...(job.progress?.counts ?? {}) };
  const status = isActiveJob(job) ? 'done' : job.status;
  const added = counts.imported ?? Math.max(0, db.gameCount - tracked.before);
  return { status, added: status === 'done' ? added : (counts.imported ?? 0), counts, error: job.error ?? null, totalNow: db.gameCount };
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
    } else finish(null); // the server only reports queued/running/failed imports: gone means done
  }, [current, db, tracked, qc]);

  const pickFile = (f: File | null | undefined) => {
    setOutcome(null);
    if (!f) return setFile(null);
    if (f.size > MAX_PGN_BYTES) {
      setFile(null);
      return setError(`That file is ${(f.size / 1048576).toFixed(0)} MB; the limit is 50 MB. Split it or import it in parts.`);
    }
    setError(null);
    setFile(f);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setOutcome(null);
    if (mode === 'file' && !file) return setError('Choose a .pgn file first.');
    if (mode === 'paste' && !text.trim()) return setError('Paste some PGN first.');
    if (mode === 'paste' && new Blob([text]).size > MAX_PGN_BYTES) return setError('That is more than 50 MB of text.');
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
                <span className="lib-hint">Up to 50 MB. Every game in the file is imported.</span>
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
            />
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

const COUNT_LABELS: Record<string, string> = {
  imported: 'imported',
  duplicates: 'duplicates skipped',
  skipped: 'skipped (variants, empty or unreadable)',
  errors: 'errors',
};

/** The final summary of an import. */
export function ImportSummary({ outcome, onDismiss }: { outcome: ImportOutcome; onDismiss: () => void }) {
  const ok = outcome.status === 'done';
  const extra = Object.entries(outcome.counts).filter(([k]) => k !== 'imported');
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
          {extra.map(([k, v]) => (
            <li key={k}>
              <strong>{fullNumber(v)}</strong> {COUNT_LABELS[k] ?? k}
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
