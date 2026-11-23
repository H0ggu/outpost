import { parseFen } from 'chessops/fen';
import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { withQuery } from '@outpost/shared/filters';
import { useSession } from '../api/hooks.ts';
import { Box, licon, Page, Spinner, type LiconValue } from '../components/index.ts';
import { paths } from '../paths.ts';
import { compactNumber } from './components/library/format.ts';
import { useReferenceInfo } from './library-hooks.ts';
import './components/library/library.css';
import './GlobalExplorerPage.css';

/** The explorer databases the global explorer can open. */
export const EXPLORER_DBS = ['masters', 'lichess', 'reference'] as const;
/** One of `EXPLORER_DBS`. */
export type ExplorerDb = (typeof EXPLORER_DBS)[number];

/** Leaves the SPA for the Studio (a separate page). Replaceable in tests. */
export const explorerNavigation = { replace: (href: string) => window.location.replace(href) };

/**
 * Studio link with an explorer open (`/studio?explorer=<db>&fen=`). `masters` and `lichess` are
 * lila's own explorer databases; `reference` is Outpost's local reference DB
 * (GET /api/explorer/reference), passed the same way.
 */
export function studioExplorerHref(db: ExplorerDb, fen?: string): string {
  return withQuery(paths.studio(), { explorer: db, fen: fen || undefined });
}

/** A FEN chessops can read (the board part alone is accepted too), or null. */
export function normalizeFen(input: string): string | null {
  const fen = input.trim().replace(/\s+/g, ' ');
  if (!fen) return null;
  return parseFen(fen).isOk ? fen : null;
}

const DBS: ReadonlyArray<{ db: ExplorerDb; title: string; icon: LiconValue; text: string; note?: string }> = [
  {
    db: 'masters',
    title: 'Masters',
    icon: licon.Crown,
    text: 'Over two million over-the-board games of players rated 2200+ FIDE, from Lichess.',
    note: 'If the admin points it at a local reference database, Masters reads that instead.',
  },
  {
    db: 'lichess',
    title: 'Lichess',
    icon: licon.Group,
    text: 'Every rated game played on Lichess, filtered by speed and rating in the explorer.',
    note: "Needs the server's Lichess API token.",
  },
  {
    db: 'reference',
    title: 'Reference',
    icon: licon.Book,
    text: 'The local over-the-board database: Lichess broadcasts and any PGN the admin imported.',
  },
];

/**
 * PLAN §9 `/explorer`: the global opening explorer lives in the Studio (lila's explorer), so this
 * page hands off to `/studio?explorer=…` — choose Masters, Lichess or the local reference DB,
 * optionally from a FEN. `/explorer?db=masters` (optionally `&fen=`) goes straight there.
 */
export default function GlobalExplorerPage() {
  const id = useId();
  const [params] = useSearchParams();
  const direct = params.get('db');
  const directDb = (EXPLORER_DBS as readonly string[]).includes(direct ?? '') ? (direct as ExplorerDb) : null;
  const [fenInput, setFenInput] = useState(params.get('fen') ?? '');
  const fen = normalizeFen(fenInput);
  const fenError = fenInput.trim() !== '' && fen === null;
  const session = useSession();
  const reference = useReferenceInfo(!!session.data?.user || !!session.data?.anonymousBrowsing);
  const refGames = reference.data?.totalGames;
  // The Lichess database is relayed with the server's token: without one it can't open.
  const noToken = session.data?.hasLichessToken === false;
  const isAdmin = session.data?.user?.role === 'admin';

  useEffect(() => {
    if (directDb) explorerNavigation.replace(studioExplorerHref(directDb, normalizeFen(params.get('fen') ?? '') ?? undefined));
  }, [directDb, params]);

  if (directDb)
    return (
      <Page title="Opening explorer">
        <Spinner center label="Opening the Studio" />
      </Page>
    );

  return (
    <Page title="Opening explorer">
      <Box title="Opening explorer">
        <p className="lib-lead">
          The explorer opens in the Studio, on Lichess's analysis board with the engine at hand. Pick a database:
        </p>
        <ul className="lib-explorer-dbs">
          {DBS.map(d => {
            const empty = d.db === 'reference' && refGames === 0;
            if (d.db === 'lichess' && noToken)
              return (
                <li key={d.db}>
                  <div className="lib-explorer-db lib-explorer-db--off" aria-disabled="true">
                    <i data-icon={d.icon} aria-hidden />
                    <span className="lib-explorer-db__text">
                      <strong>{d.title}</strong>
                      <span>{d.text}</span>
                      <span className="lib-explorer-db__count">
                        Not available on this server: it has no Lichess API token.{' '}
                        {isAdmin ? (
                          <>
                            Add one in <Link to={paths.admin.settings}>Admin → Settings</Link>.
                          </>
                        ) : (
                          'Ask the admin to add one.'
                        )}
                      </span>
                    </span>
                  </div>
                </li>
              );
            return (
              <li key={d.db}>
                <a className={empty ? 'lib-explorer-db lib-explorer-db--empty' : 'lib-explorer-db'} href={studioExplorerHref(d.db, fen ?? undefined)}>
                  <i data-icon={d.icon} aria-hidden />
                  <span className="lib-explorer-db__text">
                    <strong>{d.title}</strong>
                    <span>{d.text}</span>
                    {d.db === 'reference' && refGames !== undefined && (
                      <span className="lib-explorer-db__count">
                        {refGames === 0 ? 'Empty so far: an admin can import broadcasts or PGN.' : `${compactNumber(refGames)} games`}
                      </span>
                    )}
                    {d.note && <span className="lib-explorer-db__note">{d.note}</span>}
                  </span>
                  <i className="lib-explorer-db__go" data-icon={licon.GreaterThan} aria-hidden />
                </a>
              </li>
            );
          })}
        </ul>

        <div className="form-group lib-explorer-fen">
          <label htmlFor={`${id}-fen`}>Start from a position (optional FEN)</label>
          <input
            id={`${id}-fen`}
            type="text"
            value={fenInput}
            spellCheck={false}
            autoComplete="off"
            placeholder="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
            aria-invalid={fenError}
            onChange={e => setFenInput(e.target.value)}
          />
          {fenError ? (
            <span className="form-error">That isn't a valid FEN; the explorer will open at the start position.</span>
          ) : (
            <span className="lib-hint">Leave empty for the initial position.</span>
          )}
        </div>
        {reference.data && reference.data.attribution.length > 0 && (
          <p className="lib-hint lib-explorer-attr">{reference.data.attribution.join(' · ')}</p>
        )}
      </Box>
    </Page>
  );
}
