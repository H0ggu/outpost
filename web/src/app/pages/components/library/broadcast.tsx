/**
 * Broadcast pieces shared by the list and the round page: the "no Lichess token" notice, round
 * status and tournament dates. The live board is in MiniGame.tsx (it pulls in chessground).
 */
import { Link } from 'react-router';
import type { BroadcastRoundRef, EpochMs } from '@outpost/shared/api';
import { ApiError } from '../../../api/client.ts';
import { useSession } from '../../../api/hooks.ts';
import { ErrorBox, licon } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { isNoTokenError } from '../../library-hooks.ts';
import { DATE_LOCALE, formatDateTime } from './format.ts';
import { isUnauthorized, SignInPrompt } from './QueryView.tsx';

/** True when the server could not reach Lichess or has no token for it (503 upstream_unavailable). */
export const isUpstreamUnavailable = (e: unknown): boolean => e instanceof ApiError && e.code === 'upstream_unavailable';

/** When Lichess will take requests again (`details.retryAt` of a rate-limit 503), if known. */
const retryAtOf = (e: unknown): number | null => {
  const d = e instanceof ApiError ? (e.details as { retryAt?: unknown } | null | undefined) : null;
  return typeof d?.retryAt === 'number' ? d.retryAt : null;
};

/**
 * Error panel of the broadcast pages: explains the Lichess token when that is the cause (known
 * from the session before any request, see `precheck`), once and without a retry that can't help.
 */
export function BroadcastError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const session = useSession();
  const isAdmin = session.data?.user?.role === 'admin';
  if (isUnauthorized(error)) return <SignInPrompt what="live broadcasts" />;
  if (!isUpstreamUnavailable(error)) return <ErrorBox error={error} onRetry={onRetry} title="Could not load the broadcast" />;
  const retryButton = onRetry && (
    <button type="button" className="button button-secondary button-thin" data-icon={licon.Reload} onClick={onRetry}>
      Try again
    </button>
  );
  if (!isNoTokenError(error)) {
    const retryAt = retryAtOf(error);
    return (
      <div className="lib-note lib-note--warn" role="alert">
        <i data-icon={licon.RadioTower} aria-hidden />
        <div>
          <strong>Lichess can't be reached right now</strong>
          <p className="muted">{(error as ApiError).message}</p>
          <p>
            Broadcasts come straight from Lichess, which didn't answer in time or asked us to slow down.
            {retryAt && retryAt > Date.now() ? ` Try again after ${formatDateTime(retryAt)}.` : ' Try again in a minute.'}
          </p>
          {retryButton}
        </div>
      </div>
    );
  }
  return (
    <div className="lib-note lib-note--warn" role="alert">
      <i data-icon={licon.RadioTower} aria-hidden />
      <div>
        <strong>Live broadcasts aren't available on this server</strong>
        <p>
          Outpost reads Lichess broadcasts with the server's own Lichess API token (Lichess asks apps to authenticate
          broadcast requests), and none is set.{' '}
          {isAdmin ? (
            <>
              Add a personal token (any scope; <code>study:read</code> recommended) in{' '}
              <Link to={paths.admin.settings}>Admin → Settings</Link>, or set <code>LICHESS_TOKEN</code>.
            </>
          ) : (
            'Ask the admin of this Outpost to add one.'
          )}
        </p>
      </div>
    </div>
  );
}

/** "12–20 Nov 2026" from a tour's dates (start, optional end). */
export function formatTourDates(dates: readonly EpochMs[]): string | null {
  const [start, end] = dates;
  if (start === undefined) return null;
  const fmt = new Intl.DateTimeFormat(DATE_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
  if (end === undefined || end === start) return fmt.format(start);
  try {
    return fmt.formatRange(start, end);
  } catch {
    return `${fmt.format(start)} – ${fmt.format(end)}`;
  }
}

/** A round's state for display. */
export function roundStatus(r: BroadcastRoundRef, now: number = Date.now()): { kind: 'live' | 'finished' | 'upcoming' | 'idle'; label: string } {
  if (r.ongoing) return { kind: 'live', label: 'Live' };
  if (r.finished) return { kind: 'finished', label: 'Finished' };
  if (r.startsAt && r.startsAt > now) return { kind: 'upcoming', label: `Starts ${formatDateTime(r.startsAt)}` };
  return { kind: 'idle', label: 'Not started' };
}

/** Status pill of a round. */
export function RoundStatusPill({ round }: { round: BroadcastRoundRef }) {
  const s = roundStatus(round);
  return (
    <span className={`lib-pill${s.kind === 'live' ? ' lib-pill--live' : s.kind === 'finished' ? '' : ' lib-pill--warn'}`}>
      {s.kind === 'live' && <span className="lib-live-dot" aria-hidden />}
      {s.label}
    </span>
  );
}
