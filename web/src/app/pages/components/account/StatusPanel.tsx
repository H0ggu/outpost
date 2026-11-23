/**
 * Instance health for admins (`GET /api/admin/status`): versions, uptime, data directory and
 * database size, the Lichess token check, upstream reachability, and row counts. `StatusSummary`
 * is the compact version shown under the admin menu.
 */
import { Fragment } from 'react';
import type { AdminStatus, JobStatus, UpstreamStatus } from '@outpost/shared/api';
import { Box, Button, ErrorBox, licon, Spinner } from '../../../components/index.ts';
import { useAdminStatus, useRecheckAdminStatus } from '../../account-hooks.ts';
import { formatBytes, formatCount, formatDuration, relativeTime } from './format.ts';
import './account.css';

/** Display names of the probed upstreams. */
export const UPSTREAM_LABELS: Readonly<Record<UpstreamStatus['name'], string>> = {
  lichess: 'Lichess API',
  'lichess-explorer': 'Lichess opening explorer',
  chesscom: 'Chess.com API',
  'lichess-database': 'Lichess database (broadcasts)',
};

/**
 * Token state as one word and a tone: the server's `state` when it sends one (`unknown` = Lichess
 * could not be asked), else derived from `configured` / `valid`.
 */
export function tokenState(t: AdminStatus['lichessToken']): { text: string; tone: 'good' | 'bad' | 'warn' | 'dim' } {
  const state = t.state ?? (!t.configured ? 'missing' : t.valid === true ? 'valid' : t.valid === false ? 'invalid' : 'unknown');
  switch (state) {
    case 'missing':
      return { text: 'Not set', tone: 'warn' };
    case 'valid':
      return { text: 'Valid', tone: 'good' };
    case 'invalid':
      return { text: 'Invalid', tone: 'bad' };
    default:
      return { text: 'Could not check', tone: 'dim' };
  }
}

/** Job states in the order the Data card lists them. */
const JOB_STATES: ReadonlyArray<[JobStatus, string]> = [
  ['queued', 'Queued jobs'],
  ['running', 'Running jobs'],
  ['error', 'Failed jobs'],
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function StatusPanel() {
  const status = useAdminStatus();
  const recheck = useRecheckAdminStatus();
  const s = status.data;
  // When the server ran its probes (they are cached for about a minute), else when we got the answer.
  const checkedAt = s?.checkedAt ?? (status.dataUpdatedAt > 0 ? status.dataUpdatedAt : null);
  const busy = status.isFetching || recheck.isPending;
  return (
    <Box
      title="Status"
      level={2}
      id="status"
      actions={
        <>
          {s && checkedAt !== null && <span className="muted acc-small">Checked {relativeTime(checkedAt)}</span>}
          <Button variant="secondary" size="sm" icon={licon.Reload} disabled={busy} onClick={() => recheck.mutate()}>
            {busy ? 'Checking…' : 'Check again'}
          </Button>
        </>
      }
    >
      {recheck.isError && <ErrorBox error={recheck.error} title="Could not check again" />}
      {status.isPending ? (
        <Spinner center label="Checking the instance" />
      ) : status.isError && !s ? (
        <ErrorBox error={status.error} onRetry={() => void status.refetch()} title="Could not load the status" />
      ) : s ? (
        <StatusBody s={s} />
      ) : null}
    </Box>
  );
}

function StatusBody({ s }: { s: AdminStatus }) {
  const token = tokenState(s.lichessToken);
  const okCount = s.upstream.filter(u => u.ok).length;
  return (
    <div className="acc-status">
      <div className="acc-status__grid">
        <section className="acc-status__card" aria-labelledby="st-server">
          <h3 id="st-server">Server</h3>
          <dl className="acc-dl">
            <dt>Outpost</dt>
            <dd>{s.version}</dd>
            <dt>Node.js</dt>
            <dd>{s.nodeVersion}</dd>
            <dt>SQLite</dt>
            <dd>{s.sqliteVersion}</dd>
            <dt>Uptime</dt>
            <dd>{formatDuration(s.uptimeSec)}</dd>
            <dt>Data directory</dt>
            <dd className="acc-mono acc-break">{s.dataDir}</dd>
            <dt>Database size</dt>
            <dd>{formatBytes(s.dbSizeBytes)}</dd>
          </dl>
        </section>

        <section className="acc-status__card" aria-labelledby="st-token">
          <h3 id="st-token">Lichess token</h3>
          <p className={`acc-state acc-state--${token.tone}`}>
            <i
              data-icon={token.tone === 'good' ? licon.Checkmark : token.tone === 'bad' ? licon.CautionCircle : licon.InfoCircle}
              aria-hidden
            />
            {token.text}
            {s.lichessToken.fromEnv && <span className="acc-badge acc-badge--queued">env</span>}
          </p>
          {s.lichessToken.error && <p className="acc-help bad">{s.lichessToken.error}</p>}
          <dl className="acc-dl">
            {s.lichessToken.userId && (
              <>
                <dt>Account</dt>
                <dd>{s.lichessToken.userId}</dd>
              </>
            )}
            {s.lichessToken.configured && (
              <>
                <dt>Scopes</dt>
                <dd>{s.lichessToken.scopes.length ? s.lichessToken.scopes.join(', ') : 'none'}</dd>
              </>
            )}
          </dl>
          {!s.lichessToken.configured && (
            <p className="acc-help">
              The Lichess opening explorer, the player explorer and live broadcasts need a token. Add one in the settings above or
              with <code>LICHESS_TOKEN</code>.
            </p>
          )}
        </section>

        <section className="acc-status__card" aria-labelledby="st-counts">
          <h3 id="st-counts">Data</h3>
          <dl className="acc-dl acc-dl--num">
            <dt>Users</dt>
            <dd>{formatCount(s.counts.users)}</dd>
            <dt>Profiles</dt>
            <dd>{formatCount(s.counts.profiles)}</dd>
            <dt>Accounts</dt>
            <dd>{formatCount(s.counts.sources)}</dd>
            <dt>Games</dt>
            <dd>{formatCount(s.counts.games)}</dd>
            <dt>Reference games</dt>
            <dd>{formatCount(s.counts.referenceGames)}</dd>
            <dt>Positions</dt>
            <dd>{formatCount(s.counts.positions)}</dd>
            {s.jobs ? (
              JOB_STATES.map(([state, label]) => (
                <Fragment key={state}>
                  <dt>{label}</dt>
                  <dd className={state === 'error' && s.jobs![state] > 0 ? 'bad' : undefined}>{formatCount(s.jobs![state])}</dd>
                </Fragment>
              ))
            ) : (
              <>
                <dt>Queued jobs</dt>
                <dd>{formatCount(s.counts.queuedJobs)}</dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <h3 className="acc-status__sub">
        Upstream services{' '}
        <span className={okCount === s.upstream.length ? 'good' : 'bad'}>
          {okCount}/{s.upstream.length} reachable
        </span>
      </h3>
      <ul className="acc-upstreams">
        {s.upstream.map(u => (
          <li key={u.name} className={u.ok ? 'acc-upstream acc-upstream--ok' : 'acc-upstream acc-upstream--bad'}>
            <i data-icon={u.ok ? licon.Checkmark : licon.X} aria-label={u.ok ? 'Reachable' : 'Unreachable'} role="img" />
            <span className="acc-upstream__name">
              {UPSTREAM_LABELS[u.name] ?? u.name}
              <span className="acc-upstream__host">{hostOf(u.url)}</span>
            </span>
            <span className="acc-upstream__meta">
              {u.status !== null && <span>HTTP {u.status}</span>}
              {u.latencyMs !== null && <span>{u.latencyMs} ms</span>}
              {u.error && (
                <span className="bad" title={u.error}>
                  {u.error}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One-line health summary for the admin menu (no request of its own beyond the shared status query). */
export function StatusSummary() {
  const status = useAdminStatus();
  const s = status.data;
  if (!s) return status.isPending ? <span className="muted acc-small">Checking status…</span> : null;
  const token = tokenState(s.lichessToken);
  const okCount = s.upstream.filter(u => u.ok).length;
  return (
    <dl className="acc-summary">
      <dt>Version</dt>
      <dd>{s.version}</dd>
      <dt>Database</dt>
      <dd>{formatBytes(s.dbSizeBytes)}</dd>
      <dt>Lichess token</dt>
      <dd className={token.tone === 'good' ? 'good' : token.tone === 'bad' ? 'bad' : undefined}>{token.text}</dd>
      <dt>Upstream</dt>
      <dd className={okCount === s.upstream.length ? 'good' : 'bad'}>
        {okCount}/{s.upstream.length} up
      </dd>
    </dl>
  );
}
