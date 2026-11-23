/**
 * Small controls of the library pages: search field, lila pagination, two-step delete,
 * query-string tabs and a job progress panel.
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router';
import type { JobInfo } from '@outpost/shared/api';
import { Button, licon, type ButtonVariant, type LiconValue } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { fullNumber } from './format.ts';
import { isUnauthorized, useHere } from './QueryView.tsx';

/** Longest query the search endpoints accept (`/api/search`, database games `q`). */
export const MAX_QUERY_LENGTH = 100;

/** A search input with lila's magnifier; `onSubmit` fires on Enter. */
export function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder = 'Search',
  label,
  autoFocus,
  className,
  busy,
  maxLength = MAX_QUERY_LENGTH,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  className?: string;
  /** Shows a small spinner while results load. */
  busy?: boolean;
  /** Longest accepted input (the server answers 400 beyond it). */
  maxLength?: number;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit?.(value);
  };
  return (
    <form className={['lib-search', className].filter(Boolean).join(' ')} role="search" onSubmit={submit}>
      <i data-icon={licon.Search} aria-hidden />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={e => onChange(e.target.value)}
      />
      {busy && <span className="spinner lib-search__busy" aria-hidden />}
    </form>
  );
}

/** Page numbers around the current one: 1 … 4 5 [6] 7 8 … 20. */
export function pageWindow(page: number, pages: number): Array<number | 'gap'> {
  const out: Array<number | 'gap'> = [];
  const lo = Math.max(2, page - 2);
  const hi = Math.min(pages - 1, page + 2);
  out.push(1);
  if (lo > 2) out.push('gap');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < pages - 1) out.push('gap');
  if (pages > 1) out.push(pages);
  return out;
}

/** lila's `.pagination` (1-based pages). Renders nothing for a single page. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) return null;
  const cur = Math.min(Math.max(1, page), pages);
  return (
    <nav className="pagination lib-pagination" aria-label="Pages">
      <button type="button" data-icon={licon.LessThan} aria-label="Previous page" disabled={cur <= 1} onClick={() => onPage(cur - 1)} />
      {pageWindow(cur, pages).map((p, i) =>
        p === 'gap' ? (
          <span key={`gap${i}`} aria-hidden>
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={p === cur ? 'current' : undefined}
            aria-current={p === cur ? 'page' : undefined}
            onClick={() => onPage(p)}
          >
            {p}
          </button>
        ),
      )}
      <button type="button" data-icon={licon.GreaterThan} aria-label="Next page" disabled={cur >= pages} onClick={() => onPage(cur + 1)} />
    </nav>
  );
}

/**
 * A destructive button that asks once more: the first click arms it ("Delete?" + Cancel), the
 * second runs `onConfirm`. Disarms itself after a few seconds.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'Confirm',
  onConfirm,
  icon = licon.Trash,
  size = 'md',
  variant = 'secondary',
  disabled,
  label,
}: {
  children?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  icon?: LiconValue;
  size?: 'md' | 'sm';
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Accessible name (needed when `children` is empty). */
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed)
    return (
      <span className="lib-confirm">
        <Button
          variant="red"
          size={size}
          icon={icon}
          onClick={() => {
            setArmed(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="empty" size={size} onClick={() => setArmed(false)}>
          Cancel
        </Button>
      </span>
    );
  return (
    <Button variant={variant} size={size} icon={icon} disabled={disabled} aria-label={label} title={label} onClick={() => setArmed(true)}>
      {children}
    </Button>
  );
}

/** A tab driven by a query parameter. */
export interface ParamTab<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is not plain text (e.g. a long and a short form). */
  name?: string;
  icon?: LiconValue;
}

/** lila `.tabs-horiz` whose active tab is `?<param>=<value>` (the first tab is the default). */
export function ParamTabs<T extends string>({
  tabs,
  param = 'tab',
  label,
}: {
  tabs: ReadonlyArray<ParamTab<T>>;
  param?: string;
  label: string;
}) {
  const [params] = useSearchParams();
  const active = useParamTab(tabs, param);
  return (
    <nav className="tabs-horiz lib-tabs" aria-label={label}>
      {tabs.map((t, i) => {
        const next = new URLSearchParams(params);
        if (i === 0) next.delete(param);
        else next.set(param, t.value);
        next.delete('page');
        const qs = next.toString();
        return (
          <Link
            key={t.value}
            to={{ search: qs ? `?${qs}` : '' }}
            data-icon={t.icon}
            className={t.value === active ? 'active' : undefined}
            aria-current={t.value === active ? 'page' : undefined}
            aria-label={t.name}
            replace
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The active value of `ParamTabs` (unknown values fall back to the first tab). */
export function useParamTab<T extends string>(tabs: ReadonlyArray<ParamTab<T>>, param = 'tab'): T {
  const [params] = useSearchParams();
  const v = params.get(param);
  return (tabs.find(t => t.value === v) ?? tabs[0]!).value;
}

const STATUS_LABELS: Record<JobInfo['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

/** `duplicates` → "duplicates", `parseErrors` → "parse errors". */
const humanize = (k: string): string => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

/** Status, progress bar, message and counters of a job (imports, syncs). */
export function JobProgress({ job, title }: { job: JobInfo; title?: ReactNode }) {
  const id = useId();
  const p = job.progress;
  const active = job.status === 'queued' || job.status === 'running';
  const pct =
    job.status === 'done' ? 100 : p && p.total ? Math.min(100, Math.round((p.done * 100) / Math.max(1, p.total))) : null;
  const status =
    job.status === 'queued' && job.queuePosition ? `Queued · #${job.queuePosition} in line` : STATUS_LABELS[job.status];
  const counts = p?.counts ? Object.entries(p.counts) : [];
  return (
    <div className={`lib-job lib-job--${job.status}`} role="status" aria-live="polite">
      <div className="lib-job__head">
        <span className={`lib-job__status lib-job__status--${job.status}`}>{status}</span>
        <span className="lib-job__title" id={id}>
          {title ?? job.label}
        </span>
        {p && (p.done > 0 || p.total) ? (
          <span className="lib-job__count">
            {fullNumber(p.done)}
            {p.total ? ` / ${fullNumber(p.total)}` : ''}
          </span>
        ) : null}
      </div>
      {(active || job.status === 'done') && (
        <div
          className={['lib-progress', pct === null && 'lib-progress--indeterminate', `lib-progress--${job.status}`].filter(Boolean).join(' ')}
          role="progressbar"
          aria-labelledby={id}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
        >
          <span style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}
      {p?.message && <div className="lib-job__message">{p.message}</div>}
      {counts.length > 0 && (
        <ul className="lib-counts">
          {counts.map(([k, v]) => (
            <li key={k}>
              <strong>{fullNumber(v)}</strong> {humanize(k)}
            </li>
          ))}
        </ul>
      )}
      {job.error && <div className="form-error">{job.error}</div>}
    </div>
  );
}

/** How long an action toast stays up (ms). Read at call time, so tests can shorten it. */
export const TOAST = { ms: 8000 };

/**
 * A one-click action that failed (a bookmark star, a visibility toggle), said where everyone sees
 * it: a small toast at the bottom of the screen (tooltips never reach touch screens). A 401 means
 * the session ended, so it links to sign-in. Closes itself after a while, or with ×.
 */
export function ActionErrorToast({ error, what, onClose }: { error: unknown; what: string; onClose: () => void }) {
  const here = useHere();
  useEffect(() => {
    const t = setTimeout(onClose, TOAST.ms);
    return () => clearTimeout(t);
  }, [error, onClose]);
  const message = error instanceof Error && error.message ? error.message : 'something went wrong';
  return createPortal(
    <div className="lib-toast" role="alert">
      <i data-icon={licon.CautionTriangle} aria-hidden />
      <span className="lib-toast__text">
        {isUnauthorized(error) ? (
          <>
            Your session has ended. <Link to={paths.login(here)}>Sign in</Link> to {what}.
          </>
        ) : (
          `Could not ${what}: ${message}`
        )}
      </span>
      <button type="button" className="lib-icon-btn" data-icon={licon.X} aria-label="Dismiss" title="Dismiss" onClick={onClose} />
    </div>,
    document.body,
  );
}
