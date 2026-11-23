/**
 * Header indicator for my queued and running jobs (`GET /api/jobs/mine`): hidden while nothing
 * runs; otherwise a spinning sync icon with a count bubble (lila's `data-count`) that opens a
 * list with progress. The kit's `useMyJobs` polls while the list is non-empty; new jobs are
 * picked up after any successful mutation (e.g. "Update" on a profile, an import) and on
 * navigation, so an idle browser sends no requests.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { queryKeys, useMyJobs } from '../../../api/hooks.ts';
import { licon } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { JOB_KIND_LABELS, JobStatusBadge, ProgressBar, progressText } from './JobProgress.tsx';
import './account.css';

export function JobsIndicator({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const location = useLocation();
  const jobs = useMyJobs(true);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // A mutation may have queued work (profile update, import, retry): look again.
  useEffect(
    () =>
      qc.getMutationCache().subscribe(event => {
        if (event.type === 'updated' && event.action.type === 'success') void qc.invalidateQueries({ queryKey: queryKeys.myJobs });
      }),
    [qc],
  );

  // Navigating is a cheap moment to check for jobs started elsewhere (another tab, the scheduler).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void qc.invalidateQueries({ queryKey: queryKeys.myJobs });
    setOpen(false);
  }, [location.pathname, qc]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const list = jobs.data?.jobs ?? [];
  if (list.length === 0) return null;
  const running = list.filter(j => j.status === 'running').length;
  const label = `${list.length} job${list.length === 1 ? '' : 's'} in progress${running ? ` (${running} running)` : ''}`;

  return (
    <div className="site-jobs" ref={ref}>
      <button
        type="button"
        className="site-jobs__toggle"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-count={list.length}
        onClick={() => setOpen(o => !o)}
      >
        <i data-icon={licon.Reload} className={running ? 'site-jobs__spin' : undefined} aria-hidden />
      </button>
      {open && (
        <div className="dropdown site-jobs__panel" role="region" aria-label="Jobs in progress">
          <div className="site-jobs__head">Jobs in progress</div>
          <ul className="site-jobs__list">
            {list.map(job => {
              const text = progressText(job);
              return (
                <li key={job.id} className="site-jobs__item">
                  <div className="site-jobs__row">
                    <span className="site-jobs__label" title={job.label}>
                      {job.label || JOB_KIND_LABELS[job.kind]}
                    </span>
                    <JobStatusBadge job={job} />
                  </div>
                  <ProgressBar job={job} label={`${job.label} progress`} />
                  {text && <div className="site-jobs__text">{text}</div>}
                </li>
              );
            })}
          </ul>
          {isAdmin && (
            <Link to={paths.admin.jobs} className="site-jobs__all" data-icon={licon.List}>
              All jobs
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
