import { API_ROUTES } from '@outpost/shared/api';
import { filtersToQuery, isEmptyFilters, withQuery } from '@outpost/shared/filters';
import { useProfileGames, useUrlFilters } from '../../api/hooks.ts';
import { Box, EmptyState, ErrorBox, licon, Spinner, WdlBar } from '../../components/index.ts';
import { Pager, ScoreText, StatTile } from './components/bits.tsx';
import { GameTable } from './components/GameTable.tsx';
import { fmtInt, scoreOfWdl } from './format.ts';
import { usePageParam, useProfile } from './hooks.ts';

/** Most games one PGN export contains (PLAN §5 "PGN bulk export"). */
export const PGN_EXPORT_LIMIT = 10_000;
const PAGE_SIZE = 20;

/**
 * Games tab (PLAN §5, §6 `GET /api/profiles/:slug/games`): W/D/L summary, PGN export of the
 * filtered games, and a paged table whose rows expand into a pgn-viewer preview.
 */
export default function GamesPage() {
  const { slug, header, timeZone } = useProfile();
  const [filters, setFilters] = useUrlFilters();
  const [page, setPage] = usePageParam();
  const games = useProfileGames(slug, filters, page, PAGE_SIZE);
  const exportHref = withQuery(API_ROUTES.stats.gamesPgn(slug), filtersToQuery(filters));

  if (games.isPending) return <Spinner center label="Loading games" />;
  if (games.isError) return <ErrorBox error={games.error} onRetry={() => void games.refetch()} title="Could not load the games" />;

  const g = games.data;
  const total = g.summary.w + g.summary.d + g.summary.l;

  return (
    <Box pad={false} className={['games-box', games.isPlaceholderData && 'is-stale'].filter(Boolean).join(' ')}>
      <div className="games-summary">
        <div className="games-summary__tiles">
          <StatTile value={fmtInt(g.total)} label="Games" />
          <StatTile value={<span className={g.summary.w ? 'good' : undefined}>{fmtInt(g.summary.w)}</span>} label="Wins" />
          <StatTile value={fmtInt(g.summary.d)} label="Draws" />
          <StatTile value={<span className={g.summary.l ? 'bad' : undefined}>{fmtInt(g.summary.l)}</span>} label="Losses" />
          <StatTile value={<ScoreText score={scoreOfWdl(g.summary)} />} label="Score" />
        </div>
        {total > 0 && <WdlBar w={g.summary.w} d={g.summary.d} l={g.summary.l} className="games-summary__bar" />}
        <div className="games-summary__export">
          {g.total > 0 ? (
            <a
              className="button button-secondary button-thin"
              href={exportHref}
              download={`${slug}.pgn`}
              data-icon={licon.Download}
              title="This player's side is named after the account that played each game"
            >
              Download PGN
            </a>
          ) : (
            <button type="button" className="button button-secondary button-thin" data-icon={licon.Download} disabled>
              Download PGN
            </button>
          )}
          <span className="muted">
            {g.total > PGN_EXPORT_LIMIT
              ? `One file holds at most ${fmtInt(PGN_EXPORT_LIMIT)} of these ${fmtInt(g.total)} games: narrow the filters to get the rest.`
              : isEmptyFilters(filters)
                ? 'All games'
                : 'The filtered games'}
          </span>
        </div>
      </div>

      {g.games.length === 0 && g.total > 0 ? (
        <EmptyState icon={licon.Search} title="No games on this page">
          <button type="button" className="button button-secondary button-thin" onClick={() => setPage(1)}>
            Back to the first page
          </button>
        </EmptyState>
      ) : g.games.length === 0 ? (
        <EmptyState icon={licon.Search} title={isEmptyFilters(filters) ? 'No games yet' : 'No games match these filters'}>
          {!isEmptyFilters(filters) && (
            <button type="button" className="button button-secondary button-thin" onClick={() => setFilters({})}>
              Reset filters
            </button>
          )}
        </EmptyState>
      ) : (
        <>
          <GameTable slug={slug} games={g.games} sources={header.sources} timeZone={timeZone} />
          <Pager page={g.page} pageSize={g.pageSize} total={g.total} onPage={setPage} />
        </>
      )}
    </Box>
  );
}
