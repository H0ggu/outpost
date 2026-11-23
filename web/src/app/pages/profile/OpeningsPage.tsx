import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { OPENINGS_RANK_MIN_GAMES, type OpeningRow, type OpeningsParams } from '@outpost/shared/api';
import type { Color } from '@outpost/shared/chess';
import { filtersKey, isEmptyFilters } from '@outpost/shared/filters';
import { useOpenings, useUrlFilters } from '../../api/hooks.ts';
import { Box, EmptyState, ErrorBox, licon, Spinner, WdlBar } from '../../components/index.ts';
import { ColorDot, Pager, rowClick, ScoreText, Segmented, SelectField } from './components/bits.tsx';
import { fmtInt, fmtLine, fmtMoves, scoreOfWdl } from './format.ts';
import { oneOf, useProfile, useQueryParam, useSetQueryParams } from './hooks.ts';
import { explorerTabAt } from './links.ts';

const ORDERS = ['most', 'best', 'worst'] as const;
const MIN_GAMES = ['', '1', '5', '10', '20', '50', '100', '200', '500'] as const;
const MOVES = ['', '1', '2', '3', '4', '5'] as const;
type Order = (typeof ORDERS)[number];
type MinGames = (typeof MIN_GAMES)[number];
type Moves = (typeof MOVES)[number];

/** Lines per page of each colour's table (the endpoint returns every line; the pages are local). */
export const OPENINGS_PAGE_SIZE = 20;

/**
 * Openings tab (PLAN §5, §6 `GET /api/profiles/:slug/openings`): opening lines per colour with
 * most played / best / worst order, minimum games and a move range (1–5 full moves). The side
 * control is the filters' colour (the filters bar hides its own colour control on this tab), so
 * it carries over to the other tabs. A row opens the Explorer tab at that line. Each table shows
 * `OPENINGS_PAGE_SIZE` lines at a time, back on its first page whenever the controls change.
 */
export default function OpeningsPage() {
  const { slug } = useProfile();
  const navigate = useNavigate();
  const [filters, setFilters] = useUrlFilters();
  const [order, setOrder] = useQueryParam<Order>('order', oneOf(ORDERS, 'most'), 'most');
  const [minGames, setMinGames] = useQueryParam<MinGames>('minGames', oneOf(MIN_GAMES, ''), '');
  const [minMoves] = useQueryParam<Moves>('minMoves', oneOf(MOVES, ''), '');
  const [maxMoves] = useQueryParam<Moves>('maxMoves', oneOf(MOVES, ''), '');
  const setParams = useSetQueryParams();

  const side = filters.color ?? 'both';
  const params: OpeningsParams = {
    side,
    order,
    ...(minGames ? { minGames: Number(minGames) } : {}),
    ...(minMoves ? { minMoves: Number(minMoves) } : {}),
    // A hand-edited URL with min > max would be rejected by the server: drop the max instead.
    ...(maxMoves && !(minMoves && Number(minMoves) > Number(maxMoves)) ? { maxMoves: Number(maxMoves) } : {}),
  };
  const openings = useOpenings(slug, filters, params);

  // Under best / worst the server's own floor (the contract's OPENINGS_RANK_MIN_GAMES, decision 34)
  // applies, so lower minimums would be no-ops; a higher minGames raises it.
  const floor = order === 'most' ? 1 : OPENINGS_RANK_MIN_GAMES;
  const rankMin = order === 'most' ? null : Math.max(floor, minGames ? Number(minGames) : 0);
  const minGamesShown: MinGames = minGames && Number(minGames) <= floor ? '' : minGames;
  const minGamesOptions = MIN_GAMES.filter(m => m === '' || Number(m) > floor).map(m => ({
    value: m,
    label: m === '' ? (floor > 1 ? `${floor}+` : 'Any') : `${m}+`,
  }));

  const linkOf = (r: OpeningRow) => explorerTabAt(slug, filters, r.color, r.line.split(','));
  const movesOptions = (none: string) => MOVES.map(m => ({ value: m, label: m === '' ? none : `${m} move${m === '1' ? '' : 's'}` }));

  const controls = (
    <div className="openings-controls">
      <span className="field">
        <span className="field__label">Side</span>
        <Segmented
          label="Side"
          size="sm"
          value={side}
          options={[
            { value: 'both', label: 'Both' },
            { value: 'white', label: <><span className="color-dot color-dot--white" aria-hidden /> White</> },
            { value: 'black', label: <><span className="color-dot color-dot--black" aria-hidden /> Black</> },
          ]}
          onChange={v => setFilters({ ...filters, color: v === 'both' ? undefined : v })}
        />
      </span>
      <span className="field">
        <span className="field__label">Order</span>
        <Segmented
          label="Order"
          size="sm"
          value={order}
          options={[
            { value: 'most', label: 'Most played' },
            { value: 'best', label: 'Best', title: `Highest score among lines with ${OPENINGS_RANK_MIN_GAMES}+ games` },
            { value: 'worst', label: 'Worst', title: `Lowest score among lines with ${OPENINGS_RANK_MIN_GAMES}+ games` },
          ]}
          onChange={v => setOrder(v)}
        />
      </span>
      <SelectField label="Min. games" value={minGamesShown} options={minGamesOptions} onChange={v => setMinGames(v)} />
      <SelectField
        label="Min. moves"
        value={minMoves}
        options={movesOptions('Any')}
        onChange={v => setParams({ minMoves: v, ...(v && maxMoves && Number(maxMoves) < Number(v) ? { maxMoves: v } : {}) })}
      />
      <SelectField
        label="Max. moves"
        value={maxMoves}
        options={movesOptions('Any')}
        onChange={v => setParams({ maxMoves: v, ...(v && minMoves && Number(minMoves) > Number(v) ? { minMoves: v } : {}) })}
      />
    </div>
  );

  let body;
  if (openings.isPending) body = <Spinner center label="Loading openings" />;
  else if (openings.isError) body = <ErrorBox error={openings.error} onRetry={() => void openings.refetch()} title="Could not load the openings" />;
  else {
    const sides: Color[] = side === 'both' ? ['white', 'black'] : [side];
    body = (
      <div className={['openings-tables', sides.length === 2 && 'openings-tables--two', openings.isPlaceholderData && 'is-stale'].filter(Boolean).join(' ')}>
        {sides.map(c => (
          <OpeningsTable
            key={`${c} ${filtersKey(filters)} ${JSON.stringify(params)}`}
            color={c}
            rows={openings.data[c]}
            linkOf={linkOf}
            onOpen={r => navigate(linkOf(r))}
            filtered={!isEmptyFilters(filters)}
            rankMin={rankMin}
          />
        ))}
      </div>
    );
  }

  return (
    <Box title="Openings" level={2} actions={controls} className="openings-box">
      {body}
    </Box>
  );
}

function OpeningsTable({
  color,
  rows,
  linkOf,
  onOpen,
  filtered,
  rankMin,
}: {
  color: Color;
  rows: readonly OpeningRow[];
  linkOf: (r: OpeningRow) => string;
  onOpen: (r: OpeningRow) => void;
  filtered: boolean;
  /** Under best / worst: the fewest games a ranked line has. */
  rankMin: number | null;
}) {
  const [page, setPage] = useState(1);
  const shown = rows.slice((page - 1) * OPENINGS_PAGE_SIZE, page * OPENINGS_PAGE_SIZE);
  return (
    <section className="openings-table" aria-label={color === 'white' ? 'As White' : 'As Black'}>
      <h3 className="openings-table__title">
        <ColorDot color={color} /> As {color === 'white' ? 'White' : 'Black'}
        {rankMin !== null && <span className="openings-table__min"> (min {rankMin} games)</span>}
      </h3>
      {rows.length === 0 ? (
        <EmptyState icon={licon.Book} title={filtered ? 'No openings match these filters' : 'No games with this colour'} />
      ) : (
        <div className="table-wrap">
          <table className="slist">
            <thead>
              <tr>
                <th>Opening</th>
                <th className="num">Games</th>
                <th className="num op-moves" title="Average game length in full moves">
                  Avg. moves
                </th>
                <th className="op-wdl col-wdl">Win / draw / loss</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={`${r.eco}-${r.line}`} className="clickable" title={`Open ${r.name} in the explorer`} onClick={rowClick(() => onOpen(r))}>
                  <td className="op-name">
                    <Link to={linkOf(r)} className="row-action">
                      <span className="eco">{r.eco}</span> {r.name}
                    </Link>
                    <span className="op-name__line san">{fmtLine(r.line)}</span>
                    {/* Phones show the bar under the name instead of in its own column. */}
                    <WdlBar w={r.w} d={r.d} l={r.l} className="cell-bar" />
                  </td>
                  <td className="num">{fmtInt(r.games)}</td>
                  <td className="num op-moves">{fmtMoves(r.avgPly)}</td>
                  <td className="op-wdl col-wdl">
                    <WdlBar w={r.w} d={r.d} l={r.l} />
                  </td>
                  <td className="num">
                    <ScoreText score={scoreOfWdl(r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} pageSize={OPENINGS_PAGE_SIZE} total={rows.length} onPage={setPage} />
        </div>
      )}
    </section>
  );
}
