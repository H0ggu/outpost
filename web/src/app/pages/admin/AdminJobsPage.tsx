/**
 * `/admin/jobs` (PLAN §6 GET /api/admin/jobs, POST …/retry and …/cancel; §7 queue and lanes):
 * every job with status / kind / lane filters (kept in the URL), per-status counts, progress,
 * queue positions and errors, retry and cancel, paging, and auto-refresh (every few seconds while
 * something is queued or running).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AdminJobsQuery, JobInfo, JobKind, JobLane, JobStatus } from '@outpost/shared/api';
import { Box, Button, EmptyState, ErrorBox, licon, Spinner, Table, useDocumentTitle, type Column } from '../../components/index.ts';
import { useAdminJobs, useJobAction } from '../account-hooks.ts';
import { formatCount, formatDuration, relativeTime, useTimeFormat } from '../components/account/format.ts';
import { describeError, Flash, Toggle } from '../components/account/forms.tsx';
import {
  JOB_KIND_LABELS,
  JOB_LANE_LABELS,
  JOB_STATUS_LABELS,
  JobStatusBadge,
  ProgressBar,
  progressText,
} from '../components/account/JobProgress.tsx';
import './admin.css';

const STATUSES = Object.keys(JOB_STATUS_LABELS) as JobStatus[];
const KINDS = Object.keys(JOB_KIND_LABELS) as JobKind[];
const LANES = Object.keys(JOB_LANE_LABELS) as JobLane[];
/** Jobs per page. */
const JOBS_PAGE_SIZE = 50;

const pick = <T extends string>(values: readonly T[], v: string | null): T | undefined =>
  v !== null && (values as readonly string[]).includes(v) ? (v as T) : undefined;

/** The jobs query from the URL (`?status=&kind=&lane=&page=`). */
function useJobsQuery(): [AdminJobsQuery, (patch: Partial<Record<'status' | 'kind' | 'lane' | 'page', string | undefined>>) => void] {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const status = pick(STATUSES, params.get('status'));
  const kind = pick(KINDS, params.get('kind'));
  const lane = pick(LANES, params.get('lane'));
  const query: AdminJobsQuery = {
    page,
    pageSize: JOBS_PAGE_SIZE,
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(lane ? { lane } : {}),
  };
  const update = (patch: Partial<Record<'status' | 'kind' | 'lane' | 'page', string | undefined>>) =>
    setParams(
      prev => {
        const out = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '' || (k === 'page' && v === '1')) out.delete(k);
          else out.set(k, v);
        }
        if (!('page' in patch)) out.delete('page');
        return out;
      },
      { replace: true },
    );
  return [query, update];
}

export default function AdminJobsPage() {
  useDocumentTitle('Jobs · Admin');
  const [query, setQuery] = useJobsQuery();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const jobs = useAdminJobs(query, autoRefresh);
  const action = useJobAction();
  const fmt = useTimeFormat();
  const [message, setMessage] = useState<{ kind: 'success' | 'failure'; text: string } | null>(null);

  const data = jobs.data;
  const counts = data?.counts;
  const total = counts ? STATUSES.reduce((n, s) => n + counts[s], 0) : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const run = (job: JobInfo, kind: 'retry' | 'cancel') => {
    setMessage(null);
    action.mutate(
      { id: job.id, action: kind },
      {
        onSuccess: next =>
          setMessage({
            kind: 'success',
            text:
              kind === 'cancel'
                ? `Job #${job.id} cancelled.`
                : next.id === job.id
                  ? `Job #${job.id} queued again.`
                  : `Job #${job.id} queued again as #${next.id}.`,
          }),
        onError: e => setMessage({ kind: 'failure', text: `Job #${job.id}: ${describeError(e)}` }),
      },
    );
  };

  const columns: Column<JobInfo>[] = [
    {
      key: 'id',
      header: '#',
      align: 'num',
      hideBelow: 560,
      render: j => <span className="muted">{j.id}</span>,
    },
    {
      key: 'job',
      header: 'Job',
      render: j => {
        const text = progressText(j);
        return (
          <div className="adm-job">
            <div className="adm-job__label">{j.label || JOB_KIND_LABELS[j.kind]}</div>
            <div className="adm-job__meta">
              {JOB_KIND_LABELS[j.kind]} · {JOB_LANE_LABELS[j.lane]} lane
              {j.priority !== 0 && <> · priority {j.priority}</>}
            </div>
            {(j.status === 'running' || j.status === 'queued' || (j.progress && j.status !== 'error')) && (
              <div className="adm-job__progress">
                <ProgressBar job={j} label={`Job ${j.id} progress`} />
                {text && <span className="adm-job__text">{text}</span>}
              </div>
            )}
            {j.error && (
              <div className="adm-job__error" title={j.error}>
                {j.error}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: j => (
        <div className="adm-job__side">
          <JobStatusBadge job={j} />
          {j.status === 'queued' || j.status === 'running' ? (
            <Button variant="empty" size="sm" icon={licon.X} disabled={action.isPending} onClick={() => run(j, 'cancel')} aria-label={`Cancel job ${j.id}`}>
              Cancel
            </Button>
          ) : j.status === 'done' ? (
            <Button variant="empty" size="sm" icon={licon.Reload} disabled={action.isPending} onClick={() => run(j, 'retry')} aria-label={`Run job ${j.id} again`}>
              Run again
            </Button>
          ) : (
            <Button variant="secondary" size="sm" icon={licon.Reload} disabled={action.isPending} onClick={() => run(j, 'retry')} aria-label={`Retry job ${j.id}`}>
              Retry
            </Button>
          )}
        </div>
      ),
    },
    {
      key: 'time',
      header: 'When',
      hideBelow: 760,
      render: j => <JobTimes job={j} fmt={fmt} />,
    },
  ];

  return (
    <Box
      title="Jobs"
      level={2}
      pad={false}
      actions={
        <>
          <Toggle label="Auto-refresh" checked={autoRefresh} onChange={setAutoRefresh} />
          <Button variant="secondary" size="sm" icon={licon.Reload} disabled={jobs.isFetching} onClick={() => void jobs.refetch()} aria-label="Refresh now" title="Refresh now" />
        </>
      }
    >
      <div className="adm-pad adm-jobs-filters">
        <nav className="adm-chips" aria-label="Filter by status">
          <button type="button" className={!query.status ? 'adm-chip active' : 'adm-chip'} aria-pressed={!query.status} onClick={() => setQuery({ status: undefined })}>
            All <span className="adm-chip__count">{formatCount(total)}</span>
          </button>
          {STATUSES.map(s => (
            <button
              key={s}
              type="button"
              className={[`adm-chip adm-chip--${s}`, query.status === s && 'active'].filter(Boolean).join(' ')}
              aria-pressed={query.status === s}
              onClick={() => setQuery({ status: query.status === s ? undefined : s })}
            >
              {JOB_STATUS_LABELS[s]} <span className="adm-chip__count">{counts ? formatCount(counts[s]) : '–'}</span>
            </button>
          ))}
        </nav>
        <div className="adm-selects">
          <label>
            <span>Kind</span>
            <select className="form-control" value={query.kind ?? ''} onChange={e => setQuery({ kind: e.target.value || undefined })}>
              <option value="">All kinds</option>
              {KINDS.map(k => (
                <option key={k} value={k}>
                  {JOB_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Lane</span>
            <select className="form-control" value={query.lane ?? ''} onChange={e => setQuery({ lane: e.target.value || undefined })}>
              <option value="">All lanes</option>
              {LANES.map(l => (
                <option key={l} value={l}>
                  {JOB_LANE_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {message && <Flash kind={message.kind}>{message.text}</Flash>}
      </div>

      {jobs.isPending ? (
        <Spinner center />
      ) : jobs.isError && !data ? (
        <div className="adm-pad">
          <ErrorBox error={jobs.error} onRetry={() => void jobs.refetch()} />
        </div>
      ) : data ? (
        <>
          {jobs.isError && (
            <div className="adm-pad">
              <Flash kind="warning">Refresh failed: {describeError(jobs.error)}. Showing the last list.</Flash>
            </div>
          )}
          <Table
            className="adm-jobs"
            columns={columns}
            rows={data.jobs}
            rowKey={j => j.id}
            empty={
              <EmptyState icon={licon.List} title={query.status || query.kind || query.lane ? 'No jobs match these filters' : 'No jobs yet'}>
                {(query.status || query.kind || query.lane) && (
                  <Button variant="secondary" size="sm" onClick={() => setQuery({ status: undefined, kind: undefined, lane: undefined })}>
                    Clear filters
                  </Button>
                )}
              </EmptyState>
            }
          />
          {data.total > data.pageSize && (
            <div className="adm-pager">
              <Button variant="secondary" size="sm" icon={licon.LessThan} disabled={data.page <= 1} onClick={() => setQuery({ page: String(data.page - 1) })}>
                Previous
              </Button>
              <span className="muted">
                {formatCount((data.page - 1) * data.pageSize + 1)}–{formatCount(Math.min(data.total, data.page * data.pageSize))} of{' '}
                {formatCount(data.total)}
              </span>
              <Button variant="secondary" size="sm" disabled={data.page >= pages} onClick={() => setQuery({ page: String(data.page + 1) })}>
                Next <i data-icon={licon.GreaterThan} aria-hidden />
              </Button>
            </div>
          )}
        </>
      ) : null}
    </Box>
  );
}

function JobTimes({ job, fmt }: { job: JobInfo; fmt: ReturnType<typeof useTimeFormat> }) {
  const now = Date.now();
  if (job.status === 'queued') return <span title={fmt.dateTime(job.createdAt)}>Queued {relativeTime(job.createdAt, now)}</span>;
  if (job.status === 'running' && job.startedAt !== null)
    return <span title={fmt.dateTime(job.startedAt)}>Running for {formatDuration((now - job.startedAt) / 1000)}</span>;
  if (job.finishedAt !== null) {
    const took = job.startedAt !== null ? formatDuration((job.finishedAt - job.startedAt) / 1000) : null;
    return (
      <span title={fmt.dateTime(job.finishedAt)}>
        {relativeTime(job.finishedAt, now)}
        {took && <span className="muted"> · took {took}</span>}
      </span>
    );
  }
  return <span title={fmt.dateTime(job.createdAt)}>{relativeTime(job.createdAt, now)}</span>;
}
