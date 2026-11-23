import { Link } from 'react-router';
import type { BehaviourRow, OpponentRow } from '@outpost/shared/api';
import { OUTCOMES, type Outcome } from '@outpost/shared/chess';
import { isEmptyFilters } from '@outpost/shared/filters';
import { useBehaviour, useOpponents, useUrlFilters } from '../../api/hooks.ts';
import { Box, Card, EmptyState, ErrorBox, licon, Spinner, WdlBar } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import { OpponentName, Pager, ScoreText, Segmented, SiteIcon } from './components/bits.tsx';
import { fmtDate, fmtInt, fmtPct100, fmtRating, OUTCOME_PLURAL, scoreOfWdl, TERMINATION_LABELS } from './format.ts';
import { oneOf, usePageParam, useProfile, useQueryParam } from './hooks.ts';

const VIEWS = ['most', 'titled'] as const;
type View = (typeof VIEWS)[number];
const PAGE_SIZE = 20;

/**
 * Opponents tab (PLAN §5, §6 `/opponents` and `/behaviour`): most played and titled opponents,
 * paged, with a link to the games against each; then how the player's wins, draws and losses
 * end (termination, share, average length).
 */
export default function OpponentsPage() {
  const { slug, timeZone } = useProfile();
  const [filters] = useUrlFilters();
  const [view, setView] = useQueryParam<View>('view', oneOf(VIEWS, 'most'), 'most');
  const [page, setPage] = usePageParam();
  const opponents = useOpponents(slug, filters, { view, page, pageSize: PAGE_SIZE });
  const behaviour = useBehaviour(slug, filters);
  const filtered = !isEmptyFilters(filters);

  let table;
  if (opponents.isPending) table = <Spinner center label="Loading opponents" />;
  else if (opponents.isError) table = <ErrorBox error={opponents.error} onRetry={() => void opponents.refetch()} title="Could not load the opponents" />;
  else if (opponents.data.rows.length === 0)
    table = (
      <EmptyState icon={licon.Group} title={view === 'titled' ? 'No titled opponents' : filtered ? 'No opponents match these filters' : 'No opponents yet'} />
    );
  else
    table = (
      <div className={opponents.isPlaceholderData ? 'is-stale' : undefined}>
        <OpponentsTable slug={slug} rows={opponents.data.rows} timeZone={timeZone} filters={filters} />
        <Pager page={opponents.data.page} pageSize={opponents.data.pageSize} total={opponents.data.total} onPage={setPage} />
      </div>
    );

  return (
    <div className="opponents-page">
      <Box
        title="Opponents"
        level={2}
        pad={false}
        actions={
          <Segmented
            label="Opponents"
            size="sm"
            value={view}
            options={[
              { value: 'most', label: 'Most played' },
              { value: 'titled', label: 'Titled', icon: licon.Crown },
            ]}
            onChange={v => setView(v, { resetPage: true })}
          />
        }
      >
        {table}
      </Box>

      <section className="behaviour" aria-labelledby="behaviour-title">
        <h2 id="behaviour-title" className="section-title">
          How games end
        </h2>
        {behaviour.isPending ? (
          <Spinner center label="Loading behaviour" />
        ) : behaviour.isError ? (
          <ErrorBox error={behaviour.error} onRetry={() => void behaviour.refetch()} title="Could not load the behaviour tables" />
        ) : (
          <div className="behaviour__grid">
            {OUTCOMES.map(o => (
              <BehaviourCard key={o} outcome={o} rows={behaviour.data[o]} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function OpponentsTable({
  slug,
  rows,
  timeZone,
  filters,
}: {
  slug: string;
  rows: readonly OpponentRow[];
  timeZone: string;
  filters: ReturnType<typeof useUrlFilters>[0];
}) {
  return (
    <div className="table-wrap">
      <table className="slist opponents-table">
        <thead>
          <tr>
            <th>Opponent</th>
            <th className="num">Games</th>
            <th className="num opp-rating">Rating</th>
            <th className="opp-wdl">Win / draw / loss</th>
            <th className="num">Score</th>
            <th className="opp-last">Last played</th>
            <th>
              <span className="visually-hidden">Games</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={`${r.kind}:${r.key}`}>
              <td className="opp-name">
                <SiteIcon kind={r.kind} />
                <OpponentName opponent={{ name: r.name, title: r.title, country: r.country, rating: null }} profileSlug={r.profileSlug} showRating={false} />
              </td>
              <td className="num">{fmtInt(r.games)}</td>
              <td className="num opp-rating">{fmtRating(r.lastRating)}</td>
              <td className="opp-wdl">
                <WdlBar w={r.w} d={r.d} l={r.l} />
              </td>
              <td className="num">
                <ScoreText score={scoreOfWdl(r)} />
              </td>
              <td className="opp-last">{fmtDate(r.lastPlayed, timeZone)}</td>
              <td className="align-right">
                <Link
                  to={paths.profile(slug, 'games', { ...filters, oppName: r.name })}
                  className="button button-empty button-thin"
                  data-icon={licon.List}
                  title={`Games against ${r.name}`}
                  aria-label={`Games against ${r.name}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BehaviourCard({ outcome, rows }: { outcome: Outcome; rows: readonly BehaviourRow[] }) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  const list = [...rows].filter(r => r.count > 0).sort((a, b) => b.count - a.count);
  return (
    <Card title={OUTCOME_PLURAL[outcome]} pad={false} className={`behaviour-card behaviour-card--${outcome}`} actions={<span className="muted">{fmtInt(total)} games</span>}>
      {list.length === 0 ? (
        <EmptyState title={`No ${OUTCOME_PLURAL[outcome].toLowerCase()}`} />
      ) : (
        <table className="slist behaviour-table">
          <thead>
            <tr>
              <th>Ending</th>
              <th className="num">Games</th>
              <th className="behaviour-table__share">Share</th>
              <th className="num" title="Average length in full moves">
                Moves
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map(r => (
              <tr key={r.termination}>
                <td>{TERMINATION_LABELS[r.termination]}</td>
                <td className="num">{fmtInt(r.count)}</td>
                <td className="behaviour-table__share">
                  <span className="share-bar" title={fmtPct100(r.pct)}>
                    <span className={`share-bar__fill share-bar__fill--${outcome}`} style={{ width: `${Math.max(0, Math.min(100, r.pct))}%` }} />
                    <span className="share-bar__text">{fmtPct100(r.pct)}</span>
                  </span>
                </td>
                <td className="num">{fmtInt(r.avgMoves)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
