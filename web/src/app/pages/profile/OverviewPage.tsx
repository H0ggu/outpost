import { Link, useNavigate } from 'react-router';
import type { GameRow, OpeningRow, OverviewStats, ProfileHeader, TerminationRow } from '@outpost/shared/api';
import type { Color } from '@outpost/shared/chess';
import { useOverview } from '../../api/hooks.ts';
import { Card, EmptyState, ErrorBox, licon, Spinner, TIME_CLASS_LABELS, TimeClassIcon, WdlBar } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import { ColorDot, OpponentName, OutcomeMark, rowClick, ScoreText, SiteIcon } from './components/bits.tsx';
import { ColumnChart, type ColumnDatum } from './components/charts/ColumnChart.tsx';
import { ActivityTip, ScoreLegend, Swatch } from './components/charts/common.tsx';
import { RatingChart } from './components/charts/RatingChart.tsx';
import { mostPlayed, toChartSeries } from './components/charts/ratingSeries.ts';
import { fmtInt, fmtIsoDay, fmtLine, fmtMoves, fmtRating, fmtRelative, scoreOfWdl, TERMINATION_LABELS } from './format.ts';
import { useProfile } from './hooks.ts';
import { explorerTabAt, studioGameLink } from './links.ts';

/**
 * Overview tab (PLAN §5, §6 `GET /api/profiles/:slug/overview`): per-time-class table, colour
 * split, how games end, top openings per colour, latest games, the last 90 days of activity and
 * a year of rating.
 */
export default function OverviewPage() {
  const { slug, header, timeZone } = useProfile();
  const overview = useOverview(slug, {});

  if (overview.isPending) return <Spinner center label="Loading overview" />;
  if (overview.isError) return <ErrorBox error={overview.error} onRetry={() => void overview.refetch()} title="Could not load the overview" />;

  const o = overview.data;
  if (o.totals.games === 0) {
    return (
      <Card>
        <EmptyState icon={licon.Search} title="No games yet">
          <p>
            {header.queue.busy
              ? 'The first import is running: games appear here as they arrive.'
              : header.canEdit
                ? 'Press Update to import this player’s games.'
                : 'This profile has no imported games yet.'}
          </p>
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="overview-grid">
      <TimeClassCard slug={slug} o={o} header={header} />
      <RatingCard slug={slug} o={o} header={header} timeZone={timeZone} />
      <ColorCard slug={slug} o={o} />
      <ActivityCard slug={slug} o={o} />
      <OpeningsCard slug={slug} color="white" rows={o.topOpenings.white} />
      <OpeningsCard slug={slug} color="black" rows={o.topOpenings.black} />
      <TerminationCard rows={o.terminations} />
      <LatestGamesCard slug={slug} games={o.latestGames} header={header} />
    </div>
  );
}

function TimeClassCard({ slug, o, header }: { slug: string; o: OverviewStats; header: ProfileHeader }) {
  const navigate = useNavigate();
  const rows = o.timeClasses.filter(r => r.games > 0);
  return (
    <Card title="Time controls" pad={false} className="ov-tc">
      <div className="table-wrap">
        <table className="slist ov-table">
          <thead>
            <tr>
              <th>Time control</th>
              <th className="num">Games</th>
              <th className="num">Rating</th>
              <th className="ov-wdl">Win / draw / loss</th>
              <th className="num">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const games = paths.profile(slug, 'games', { tc: [r.timeClass] });
              return (
              <tr key={r.timeClass} className="clickable" onClick={rowClick(() => navigate(games))}>
                <td>
                  <Link to={games} className="row-action" title={`${TIME_CLASS_LABELS[r.timeClass]} games`}>
                    <TimeClassIcon tc={r.timeClass} withLabel />
                  </Link>
                </td>
                <td className="num">{fmtInt(r.games)}</td>
                <td className="num ov-ratings">
                  {r.ratings.length === 0 ? (
                    <span className="muted">–</span>
                  ) : (
                    r.ratings.map(x => {
                      const src = header.sources.find(s => s.id === x.sourceId);
                      return (
                        <span key={x.sourceId} className="ov-rating" title={src ? `${src.displayName} · ${TIME_CLASS_LABELS[r.timeClass]}` : undefined}>
                          {src && r.ratings.length > 1 && <SiteIcon kind={src.kind} />}
                          {fmtRating(x.rating)}
                        </span>
                      );
                    })
                  )}
                </td>
                <td className="ov-wdl">
                  <WdlBar w={r.w} d={r.d} l={r.l} />
                </td>
                <td className="num">
                  <ScoreText score={scoreOfWdl(r)} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RatingCard({ slug, o, header, timeZone }: { slug: string; o: OverviewStats; header: ProfileHeader; timeZone: string }) {
  // The three most-played lines keep the sparkline readable; the Rating tab has them all.
  const series = toChartSeries(
    mostPlayed(
      o.ratingSparkline.filter(s => s.points.length > 1),
      header.sources,
      3,
    ),
    header.sources,
  );
  const now = Date.now();
  return (
    <Card
      title="Rating · last year"
      className="ov-rating-card"
      actions={
        <Link to={paths.profile(slug, 'rating', { period: '12m' })} className="card-link">
          Rating history
        </Link>
      }
    >
      {series.length === 0 ? (
        <EmptyState icon={licon.LineGraph} title="No rating history in the last year" />
      ) : (
        <>
          <RatingChart series={series} height={180} timeZone={timeZone} title="Rating over the last year" compact xDomain={[now - 365 * 86_400_000, now]} />
          {series.length > 1 && (
            <ul className="series-legend">
              {series.map(s => (
                <li key={s.key}>
                  <Swatch color={s.color} dash={s.dash} />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function ColorCard({ slug, o }: { slug: string; o: OverviewStats }) {
  const navigate = useNavigate();
  const rows: Array<[Color, OverviewStats['byColor']['white']]> = [
    ['white', o.byColor.white],
    ['black', o.byColor.black],
  ];
  return (
    <Card title="By colour" className="ov-color">
      <ul className="ov-bars">
        {rows.map(([c, x]) => (
          <li key={c}>
            <button type="button" className="ov-bars__row" onClick={() => navigate(paths.profile(slug, 'games', { color: c }))}>
              <span className="ov-bars__label">
                <ColorDot color={c} /> {c === 'white' ? 'White' : 'Black'}
              </span>
              <span className="ov-bars__count">{fmtInt(x.games)}</span>
              <WdlBar w={x.w} d={x.d} l={x.l} />
              <ScoreText score={scoreOfWdl(x)} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ActivityCard({ slug, o }: { slug: string; o: OverviewStats }) {
  const data: ColumnDatum[] = o.activity.map(d => ({
    key: d.date,
    label: d.date.endsWith('-01') ? new Date(`${d.date}T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) : '',
    games: d.games,
    score: d.score,
    tip: <ActivityTip title={fmtIsoDay(d.date)} games={d.games} score={d.score} />,
  }));
  const total = o.activity.reduce((n, d) => n + d.games, 0);
  const active = o.activity.filter(d => d.games > 0).length;
  return (
    <Card
      title="Last 90 days"
      className="ov-activity"
      actions={
        <Link to={paths.profile(slug, 'activity')} className="card-link">
          Activity
        </Link>
      }
    >
      <p className="card-sub">
        {fmtInt(total)} games on {active} days
      </p>
      <ColumnChart data={data} height={120} axis={false} title="Games per day over the last 90 days" showLabel={i => data[i]!.label !== ''} />
      <ScoreLegend label="Day’s score" />
    </Card>
  );
}

function OpeningsCard({ slug, color, rows }: { slug: string; color: Color; rows: readonly OpeningRow[] }) {
  const navigate = useNavigate();
  const title = color === 'white' ? 'Openings as White' : 'Openings as Black';
  return (
    <Card
      title={title}
      pad={false}
      className="ov-openings"
      actions={
        <Link to={paths.profile(slug, 'openings', { color })} className="card-link">
          All openings
        </Link>
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon={licon.Book} title="No games with this colour" />
      ) : (
        <ul className="opening-list">
          {rows.map(r => (
            <li key={`${r.eco}-${r.line}`}>
              <button type="button" className="opening-list__row" onClick={() => navigate(explorerTabAt(slug, {}, color, r.line.split(',')))} title={`Explore ${r.name}`}>
                <span className="opening-list__name">
                  <span className="eco">{r.eco}</span> {r.name}
                  <span className="opening-list__line san">{fmtLine(r.line)}</span>
                </span>
                <span className="opening-list__games">
                  {fmtInt(r.games)}
                  <span className="muted"> · {fmtMoves(r.avgPly)} mv</span>
                </span>
                <WdlBar w={r.w} d={r.d} l={r.l} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TerminationCard({ rows }: { rows: readonly TerminationRow[] }) {
  const list = rows.filter(r => r.w + r.d + r.l > 0).sort((a, b) => b.w + b.d + b.l - (a.w + a.d + a.l));
  return (
    <Card title="How games end" pad={false} className="ov-term">
      {list.length === 0 ? (
        <EmptyState title="No finished games" />
      ) : (
        <div className="table-wrap">
          <table className="slist ov-table">
            <thead>
              <tr>
                <th>Ending</th>
                <th className="num">Won</th>
                <th className="num">Drawn</th>
                <th className="num">Lost</th>
                <th className="ov-wdl">
                  <span className="visually-hidden">Share</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.termination}>
                  <td>{TERMINATION_LABELS[r.termination]}</td>
                  <td className="num">{r.w ? fmtInt(r.w) : <span className="muted">–</span>}</td>
                  <td className="num">{r.d ? fmtInt(r.d) : <span className="muted">–</span>}</td>
                  <td className="num">{r.l ? fmtInt(r.l) : <span className="muted">–</span>}</td>
                  <td className="ov-wdl">
                    <WdlBar w={r.w} d={r.d} l={r.l} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LatestGamesCard({ slug, games, header }: { slug: string; games: readonly GameRow[]; header: ProfileHeader }) {
  const now = Date.now();
  return (
    <Card
      title="Latest games"
      pad={false}
      className="ov-latest"
      actions={
        <Link to={paths.profile(slug, 'games')} className="card-link">
          All games
        </Link>
      }
    >
      <ul className="latest-games">
        {games.map(g => {
          const src = header.sources.find(s => s.id === g.sourceId);
          return (
            <li key={g.id}>
              <a href={studioGameLink(g.id)} className="latest-games__row" title="Analyse in the Studio">
                <OutcomeMark outcome={g.outcome} />
                <ColorDot color={g.color} />
                <span className="latest-games__opp">
                  <OpponentName opponent={g.opponent} />
                </span>
                <TimeClassIcon tc={g.timeClass} />
                <span className="latest-games__when muted">{fmtRelative(g.endedAt, now)}</span>
                {src && <SiteIcon kind={src.kind} />}
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
