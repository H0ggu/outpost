/**
 * Job display bits shared by the header's job indicator, the admin jobs table and the reference
 * page: a status badge, a progress bar (determinate when the total is known) and a one-line
 * summary of the progress counters.
 */
import type { JobInfo, JobKind, JobLane, JobProgress as Progress, JobStatus } from '@outpost/shared/api';
import { licon, type LiconValue } from '../../../components/index.ts';
import { formatCount } from './format.ts';
import './account.css';

/** Display names of the job statuses. */
export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

/** Display names of the job kinds. */
export const JOB_KIND_LABELS: Readonly<Record<JobKind, string>> = {
  sync: 'Account sync',
  geo: 'Country lookup',
  pgnImport: 'PGN import',
  referenceImport: 'Reference import',
  broadcastMonth: 'Broadcast month',
  broadcastRound: 'Broadcast round',
  rebuild: 'Rebuild',
};

/** Display names of the worker lanes. */
export const JOB_LANE_LABELS: Readonly<Record<JobLane, string>> = {
  lichess: 'Lichess',
  chesscom: 'Chess.com',
  local: 'Local',
};

const STATUS_ICONS: Readonly<Record<JobStatus, LiconValue>> = {
  queued: licon.Clock,
  running: licon.Reload,
  done: licon.Checkmark,
  error: licon.CautionCircle,
  cancelled: licon.X,
};

/** Status pill; `queuePosition` adds "#3" to queued jobs. */
export function JobStatusBadge({ job }: { job: Pick<JobInfo, 'status' | 'queuePosition'> }) {
  const pos = job.status === 'queued' && job.queuePosition ? ` #${job.queuePosition}` : '';
  return (
    <span className={`acc-badge acc-badge--${job.status}`} title={job.status === 'queued' && pos ? `Position ${job.queuePosition} in its queue` : undefined}>
      <i data-icon={STATUS_ICONS[job.status]} aria-hidden />
      {JOB_STATUS_LABELS[job.status]}
      {pos}
    </span>
  );
}

/** Percentage (0–100) when the total is known, else null. */
export function progressPercent(p: Progress | null | undefined): number | null {
  if (!p || p.total === null || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** `imported 1,234 · duplicates 5`. */
export function progressCounts(p: Progress | null | undefined): string | null {
  if (!p?.counts) return null;
  const parts = Object.entries(p.counts)
    .filter(([k, v]) => v > 0 && !k.startsWith('skip:'))
    .map(([k, v]) => `${k} ${formatCount(v)}`);
  return parts.length ? parts.join(' · ') : null;
}

/** A thin progress bar; indeterminate while running without a known total. */
export function ProgressBar({ job, label }: { job: Pick<JobInfo, 'status' | 'progress'>; label?: string }) {
  const pct = progressPercent(job.progress);
  const running = job.status === 'running';
  const value = job.status === 'done' ? 100 : pct;
  return (
    <div
      className={['acc-progress', value === null && running && 'acc-progress--indeterminate', `acc-progress--${job.status}`]
        .filter(Boolean)
        .join(' ')}
      role="progressbar"
      aria-label={label ?? 'Progress'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
    >
      <span style={value === null ? undefined : { width: `${value}%` }} />
    </div>
  );
}

/** Progress text: message, `done / total`, counters. */
export function progressText(job: Pick<JobInfo, 'status' | 'progress'>): string | null {
  const p = job.progress;
  if (!p) return null;
  const parts: string[] = [];
  if (p.message) parts.push(p.message);
  if (p.total !== null && p.total > 0) parts.push(`${formatCount(p.done)} / ${formatCount(p.total)}`);
  else if (p.done > 0 && !p.counts) parts.push(formatCount(p.done));
  const counts = progressCounts(p);
  if (counts) parts.push(counts);
  return parts.length ? parts.join(' · ') : null;
}
