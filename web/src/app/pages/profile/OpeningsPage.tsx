import { useNavigate } from 'react-router';
import type { OpeningRow, OpeningsParams } from '@outpost/shared/api';
import type { Color } from '@outpost/shared/chess';
import { isEmptyFilters } from '@outpost/shared/filters';
import { useOpenings, useUrlFilters } from '../../api/hooks.ts';
import { Box, EmptyState, ErrorBox, licon, Spinner, WdlBar } from '../../components/index.ts';
import { ColorDot, ScoreText, Segmented, SelectField } from './components/bits.tsx';
import { fmtInt, fmtLine, fmtMoves, scoreOfWdl } from './format.ts';
import { oneOf, useProfile, useQueryParam, useSetQueryParams } from './hooks.ts';
import { explorerTabAt } from './links.ts';

const ORDERS = ['most', 'best', 'worst'] as const;
const MIN_GAMES = ['', '1', '5', '10', '20', '50', '100', '200', '500'] as const;
const MOVES = ['', '1', '2', '3', '4', '5'] as const;
type Order = (typeof ORDERS)[number];
type MinGames = (typeof MIN_GAMES)[number];
type Moves = (typeof MOVES)[number];

/**
 * Openings tab (PLAN §5, §6 `GET /api/profiles/:slug/openings`): opening lines per colour with
 * most played / best / worst order, minimum games and a move range (1–5 full moves). The side
 * follows the filters' colour. A row opens the Explorer tab at that line.
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
    ...(maxMoves ? { maxMoves: Number(maxMoves) } : {}),
  };
  const openings = useOpenings(slug, filters, params);

  const open = (r: OpeningRow) => navigate(explorerTabAt(slug, filters, r.color, r.line.split(',')));
  const movesOptions = (none: string) => MOVES.map(m => ({ value: m, label: m === '' ? none : `${m} move${m === '1' ? '' : 's'}` }));

  const controls = (
    <div className="openings-controls">
      <Segmented
        label="Side"
        size="sm"
        value={side}
        options={[
          { value: 'both', label: 'Both' },
          { value: 'white', label: 'White' },
          { value: 'black', label: 'Black' },
        ]}
        onChange={v => setFilters({ ...filters, color: v === 'both' ? undefined : v })}
      />
      <Segmented
        label="Order"
        size="sm"
        value={order}
        options={[
          { value: 'most', label: 'Most played' },
          { value: 'best', label: 'Best' },
          { value: 'worst', label: 'Worst' },
        ]}
        onChange={v => setOrder(v)}
      />
      <SelectField
        label="Min. games"
        value={minGames}
        options={MIN_GAMES.map(m => ({ value: m, label: m === '' ? 'Any' : `${m}+` }))}
        onChange={v => setMinGames(v)}
      />
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
          <OpeningsTable key={c} color={c} rows={openings.data[c]} onOpen={open} filtered={!isEmptyFilters(filters)} />
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
  onOpen,
  filtered,
}: {
  color: Color;
  rows: readonly OpeningRow[];
  onOpen: (r: OpeningRow) => void;
  filtered: boolean;
}) {
  return (
    <section className="openings-table" aria-label={color === 'white' ? 'As White' : 'As Black'}>
      <h3 className="openings-table__title">
        <ColorDot color={color} /> As {color === 'white' ? 'White' : 'Black'}
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
                <th className="op-wdl">Win / draw / loss</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={`${r.eco}-${r.line}`}
                  className="clickable"
                  tabIndex={0}
                  title={`Open ${r.name} in the explorer`}
                  onClick={() => onOpen(r)}
                  onKeyDown={e => e.key === 'Enter' && onOpen(r)}
                >
                  <td className="op-name">
                    <span className="eco">{r.eco}</span> {r.name}
                    <span className="op-name__line san">{fmtLine(r.line)}</span>
                  </td>
                  <td className="num">{fmtInt(r.games)}</td>
                  <td className="num op-moves">{fmtMoves(r.avgPly)}</td>
                  <td className="op-wdl">
                    <WdlBar w={r.w} d={r.d} l={r.l} />
                  </td>
                  <td className="num">
                    <ScoreText score={scoreOfWdl(r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
