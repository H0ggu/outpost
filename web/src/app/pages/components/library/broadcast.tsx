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
import { isUnauthorized, SignInPrompt } from './QueryView.tsx';
import { formatDateTime } from './format.ts';

/** True when the server could not reach Lichess or has no token for it (503 upstream_unavailable). */
export const isUpstreamUnavailable = (e: unknown): boolean => e instanceof ApiError && e.code === 'upstream_unavailable';

/** Error panel of the broadcast pages: explains the Lichess token when that is the cause. */
export function BroadcastError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const session = useSession();
  const isAdmin = session.data?.user?.role === 'admin';
  if (isUnauthorized(error)) return <SignInPrompt what="live broadcasts" />;
  if (!isUpstreamUnavailable(error)) return <ErrorBox error={error} onRetry={onRetry} title="Could not load the broadcast" />;
  return (
    <div className="lib-note lib-note--warn" role="alert">
      <i data-icon={licon.RadioTower} aria-hidden />
      <div>
        <strong>Live broadcasts aren't available on this server right now</strong>
        <p className="muted">{(error as ApiError).message}</p>
        <p>
          Outpost reads Lichess broadcasts with the server's own Lichess API token (Lichess asks apps to authenticate
          broadcast requests), and either none is set or Lichess can't be reached.{' '}
          {isAdmin ? (
            <>
              Add a personal token (any scope; <code>study:read</code> recommended) in{' '}
              <Link to={paths.admin.settings}>Admin → Settings</Link>.
            </>
          ) : (
            'Ask the admin of this Outpost to add one.'
          )}
        </p>
        {onRetry && (
          <button type="button" className="button button-secondary button-thin" data-icon={licon.Reload} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** "12–20 Nov 2026" from a tour's dates (start, optional end). */
export function formatTourDates(dates: readonly EpochMs[]): string | null {
  const [start, end] = dates;
  if (start === undefined) return null;
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
