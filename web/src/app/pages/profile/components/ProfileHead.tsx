/**
 * The profile header (PLAN §5 "Update button, queue, cooldown"): name, titles and flags, the
 * accounts with their ratings and sync state, bookmark star, Update button (queue position,
 * running progress, cooldown countdown), the Studio link, and the tab bar underneath.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ProfileHeader, ProfileQueueInfo, SourceSummary, SourceSyncStatus } from '@outpost/shared/api';
import { TITLES, type Title } from '@outpost/shared/chess';
import type { ProfileFilters } from '@outpost/shared/filters';
import { ApiError } from '../../../api/client.ts';
import { queryKeys, useProfileStatus } from '../../../api/hooks.ts';
import { errorMessage, FlagEmoji, licon, Spinner, Tabs, TIME_CLASS_LABELS, TimeClassIcon, type TabItem } from '../../../components/index.ts';
import {
  fmtCountdown,
  fmtInt,
  fmtPct,
  fmtRating,
  fmtRelative,
  scoreOfWdl,
  SYNC_STATE_LABELS,
} from '../format.ts';
import { useNow, useRequestUpdate, useToggleBookmark } from '../hooks.ts';
import { studioExplorerLink } from '../links.ts';
import { SiteIcon, TitleBadge, WdlCounts } from './bits.tsx';

/** Highest-ranked title among the sources (GM before IM before …). */
export function bestTitle(sources: readonly Pick<SourceSummary, 'title'>[]): Title | null {
  let best: Title | null = null;
  for (const s of sources) if (s.title && (best === null || TITLES.indexOf(s.title) < TITLES.indexOf(best))) best = s.title;
  return best;
}

/** Distinct countries of the sources, in order. */
const countriesOf = (sources: readonly SourceSummary[]): string[] => [...new Set(sources.map(s => s.country).filter((c): c is string => !!c))];

// ---------------------------------------------------------------------------
// Sync state (status polling)
// ---------------------------------------------------------------------------

interface SyncView {
  queue: ProfileQueueInfo;
  syncOf: (s: SourceSummary) => SourceSyncStatus;
  lastUpdated: number | null;
  /** Call after a successful POST …/update so the end of the sync refreshes the stats. */
  started: () => void;
}

/**
 * Polls `GET …/status` while a sync is queued or running; when it finishes, refreshes the
 * header and every statistic of the profile.
 */
function useSyncView(slug: string, header: ProfileHeader): SyncView {
  const qc = useQueryClient();
  const [poll, setPoll] = useState(false);
  const status = useProfileStatus(slug, poll || header.queue.busy);
  const queue = status.data?.queue ?? header.queue;
  const busyRef = useRef(queue.busy);

  useEffect(() => {
    if (busyRef.current && !queue.busy) {
      setPoll(false);
      void qc.invalidateQueries({ queryKey: queryKeys.profile(slug) });
    }
    busyRef.current = queue.busy;
  }, [queue.busy, qc, slug]);

  const byId = new Map(status.data?.sources.map(s => [s.sourceId, s.sync]) ?? []);
  return {
    queue,
    syncOf: s => byId.get(s.id) ?? s.sync,
    lastUpdated: status.data?.lastUpdated ?? header.lastUpdated,
    started: () => {
      busyRef.current = true;
      setPoll(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Update button
// ---------------------------------------------------------------------------

/** Text for a running sync, from the running sources' progress. */
function progressText(sources: readonly SourceSummary[], syncOf: (s: SourceSummary) => SourceSyncStatus): string {
  for (const s of sources) {
    const sync = syncOf(s);
    if (sync.state !== 'running') continue;
    const p = sync.progress;
    if (!p) return `${s.displayName}…`;
    if (p.message) return `${s.displayName}: ${p.message}`;
    return `${s.displayName}: ${fmtInt(p.done)}${p.total ? ` / ${fmtInt(p.total)}` : ''}`;
  }
  return 'Starting…';
}

/** The retry time of a `cooldown` error (`details.retryAt`), if any. */
const cooldownRetryAt = (e: unknown): number | null => {
  if (!(e instanceof ApiError) || e.code !== 'cooldown') return null;
  const d = e.details as { retryAt?: unknown } | undefined;
  return typeof d?.retryAt === 'number' ? d.retryAt : Date.now() + 60_000;
};

function UpdateControl({ slug, header, sync }: { slug: string; header: ProfileHeader; sync: SyncView }) {
  const update = useRequestUpdate(slug);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const { queue } = sync;
  const cooldownUntil = Math.max(queue.cooldownUntil ?? 0, retryAt ?? 0);
  const now = useNow(1000, !queue.busy && cooldownUntil > Date.now());
  const coolingDown = !queue.busy && cooldownUntil > now;

  if (queue.busy) {
    const running = header.sources.some(s => sync.syncOf(s).state === 'running');
    const text =
      !running && queue.queuePosition !== null && queue.queuePosition > 0
        ? `In queue · #${queue.queuePosition}`
        : `Updating · ${progressText(header.sources, sync.syncOf)}`;
    return (
      <div className="update-state" role="status" aria-live="polite">
        <Spinner size={16} label="Updating" />
        <span>{text}</span>
      </div>
    );
  }

  const otherError = update.isError && cooldownRetryAt(update.error) === null ? update.error : null;
  return (
    <div className="update-control">
      <button
        type="button"
        className="button button-thin"
        data-icon={licon.Reload}
        disabled={update.isPending || coolingDown}
        title={coolingDown ? 'Recently updated: updates are rate-limited' : 'Fetch new games from every account'}
        onClick={() =>
          update.mutate(undefined, {
            onSuccess: r => {
              setRetryAt(null);
              if (r.queue.busy || r.jobs.length > 0) sync.started();
            },
            onError: e => setRetryAt(cooldownRetryAt(e)),
          })
        }
      >
        {coolingDown ? `Update in ${fmtCountdown(cooldownUntil - now)}` : update.isPending ? 'Queueing…' : 'Update'}
      </button>
      {otherError !== null && (
        <span className="update-control__error" role="alert" title={errorMessage(otherError)}>
          {errorMessage(otherError)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function syncLabel(sync: SourceSyncStatus, now: number): string {
  switch (sync.state) {
    case 'idle':
      return `synced ${fmtRelative(sync.lastSyncedAt, now)}`;
    case 'queued':
      return sync.queuePosition ? `queued · #${sync.queuePosition}` : 'queued';
    case 'running':
      return sync.progress ? `updating · ${fmtInt(sync.progress.done)}${sync.progress.total ? `/${fmtInt(sync.progress.total)}` : ''}` : 'updating';
    default:
      return SYNC_STATE_LABELS[sync.state].toLowerCase();
  }
}

function SourceItem({ source, sync, now }: { source: SourceSummary; sync: SourceSyncStatus; now: number }) {
  const ratings = [...source.ratings].sort((a, b) => b.games - a.games).slice(0, 4);
  const name = source.url ? (
    <a href={source.url} target="_blank" rel="noopener noreferrer" title={`Open on ${source.kind === 'chesscom' ? 'Chess.com' : 'Lichess'}`}>
      {source.displayName}
    </a>
  ) : (
    <span>{source.displayName}</span>
  );
  return (
    <li className={['psource', source.hidden && 'psource--hidden'].filter(Boolean).join(' ')}>
      <span className="psource__id">
        <SiteIcon kind={source.kind} />
        <FlagEmoji code={source.country} />
        <TitleBadge title={source.title} />
        {name}
        {source.hidden && (
          <span className="psource__tag" title="Hidden from other viewers" data-icon={licon.Eye}>
            hidden
          </span>
        )}
      </span>
      {(ratings.length > 0 || source.fide) && (
        <span className="psource__ratings">
          {ratings.map(r => (
            <span key={r.timeClass} className="psource__rating" title={`${TIME_CLASS_LABELS[r.timeClass]} · ${fmtInt(r.games)} games${r.provisional ? ' · provisional' : ''}`}>
              <TimeClassIcon tc={r.timeClass} />
              {fmtRating(r.rating, r.provisional)}
            </span>
          ))}
          {source.fide?.standard ? (
            <span className="psource__rating" title="FIDE standard rating">
              <span className="psource__fide">FIDE</span>
              {source.fide.standard}
            </span>
          ) : null}
        </span>
      )}
      <span className={`psource__sync psource__sync--${sync.state}`} title={sync.lastError ?? undefined}>
        {sync.state === 'error' && <i data-icon={licon.CautionTriangle} aria-hidden />}
        {syncLabel(sync, now)} · {fmtInt(source.gameCount)} games
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** Props of `ProfileHead`. */
export interface ProfileHeadProps {
  header: ProfileHeader;
  signedIn: boolean;
  filters: ProfileFilters;
  tabs: TabItem[];
}

/** The header box with the tab bar. */
export function ProfileHead({ header, signedIn, filters, tabs }: ProfileHeadProps) {
  const slug = header.slug;
  const sync = useSyncView(slug, header);
  const bookmark = useToggleBookmark(slug);
  const now = useNow(60_000);
  const title = bestTitle(header.sources);
  const flags = countriesOf(header.sources);
  const score = scoreOfWdl(header.totals);

  return (
    <section className="box profile-head">
      <div className="profile-head__top">
        <div className="profile-head__id">
          <h1 className="profile-head__name">
            <TitleBadge title={title} />
            <span>{header.displayName}</span>
            {flags.map(c => (
              <FlagEmoji key={c} code={c} />
            ))}
          </h1>
          {signedIn && (
            <button
              type="button"
              className={['bookmark-toggle', header.bookmarked && 'active'].filter(Boolean).join(' ')}
              data-icon={header.bookmarked ? licon.Star : licon.StarOutline}
              aria-pressed={header.bookmarked}
              aria-label={header.bookmarked ? 'Remove bookmark' : 'Bookmark this profile'}
              title={header.bookmarked ? 'Remove bookmark' : 'Bookmark this profile'}
              disabled={bookmark.isPending}
              onClick={() => bookmark.mutate(!header.bookmarked)}
            />
          )}
          {header.visibility === 'private' && (
            <span className="profile-head__private" data-icon={licon.Padlock} title="Only the owner (and admins) can see this profile">
              Private
            </span>
          )}
        </div>
        <div className="profile-head__actions">
          {header.canEdit && <UpdateControl slug={slug} header={header} sync={sync} />}
          {!header.canEdit && sync.queue.busy && (
            <div className="update-state" role="status">
              <Spinner size={16} label="Updating" />
              <span>Updating…</span>
            </div>
          )}
          <a
            className="button button-secondary button-thin"
            href={studioExplorerLink(slug, filters.color ?? 'white', filters, false)}
            data-icon={licon.Microscope}
            title="Open this player's explorer in the Studio"
          >
            Analyse in Studio
          </a>
        </div>
      </div>

      <div className="profile-head__summary">
        <span>
          <strong>{fmtInt(header.totals.games)}</strong> games
        </span>
        {header.totals.games > 0 && (
          <>
            <WdlCounts w={header.totals.w} d={header.totals.d} l={header.totals.l} />
            <span>
              <strong>{fmtPct(score)}</strong> score
            </span>
          </>
        )}
        <span className="muted">Updated {fmtRelative(sync.lastUpdated, now)}</span>
        {bookmark.isError && <span className="form-error">{errorMessage(bookmark.error)}</span>}
      </div>

      {header.sources.length > 0 ? (
        <ul className="profile-sources">
          {header.sources.map(s => (
            <SourceItem key={s.id} source={s} sync={sync.syncOf(s)} now={now} />
          ))}
        </ul>
      ) : (
        <p className="profile-head__empty muted">No accounts are linked to this profile yet.</p>
      )}

      <Tabs items={tabs} label="Profile sections" className="profile-tabs" />
    </section>
  );
}
