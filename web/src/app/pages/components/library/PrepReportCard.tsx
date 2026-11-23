/**
 * One opponent's report card in a prep set (PLAN §5 "Tournament preparation", §6
 * GET /api/prep/:id/report): ratings, White and Black repertoire (main and weakest lines, each with
 * a jump into the Studio's player explorer at that line), recent games and when they play.
 * Laid out for screens and for paper (PrepPage.css, @media print).
 */
import { Link } from 'react-router';
import type { Color, GameRow, PrepLine, PrepOpponentReport, PrepSide, SourceKind } from '@outpost/shared/api';
import { encodeFiltersSegment, type ProfileFilters } from '@outpost/shared/filters';
import { TIME_CLASS_LABELS, TimeClassIcon, WdlBar, licon } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { ActivityBars, busiestHours, peakIndex, WEEKDAYS } from './ActivityBars.tsx';
import { formatDate, fullNumber, percent, plural, resultLabel, SOURCE_KIND_LABELS } from './format.ts';
import { SourceBadges } from './ProfileList.tsx';

/** Studio link: the opponent's player explorer for `color`, at the end of `line` (PGN movetext). */
export function lineExplorerHref(slug: string, color: Color, filters: ProfileFilters, san?: string): string {
  return paths.studio({
    explorer: `player:${slug}`,
    color,
    filters: encodeFiltersSegment(filters),
    ...(san ? { pgn: san } : {}),
  });
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? String(h) : ''));
const HOUR_NAMES = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`);
/** One letter per day (the bar's tooltip names it), so seven labels fit under a narrow chart. */
const DAY_LABELS = WEEKDAYS.map(d => d[0]!);

export function PrepReportCard({
  report,
  filters,
  utc,
  minGames,
}: {
  report: PrepOpponentReport;
  filters: ProfileFilters;
  utc: boolean;
  /** Fewest games of a weakest line, as requested (shown in the heading). */
  minGames?: number;
}) {
  const p = report.profile;
  const totalGames = report.asWhite.games + report.asBlack.games;
  return (
    <article className="box lib-prep-card" aria-labelledby={`prep-opp-${p.id}`}>
      <header className="lib-prep-card__head">
        <div className="lib-prep-card__who">
          <h2 id={`prep-opp-${p.id}`}>
            <Link to={paths.profile(p.slug)}>{p.displayName}</Link>
          </h2>
          <SourceBadges sources={p.sources} />
        </div>
        <nav className="lib-prep-card__links no-print" aria-label={`${p.displayName} explorer`}>
          <a className="button button-secondary button-thin" href={lineExplorerHref(p.slug, 'white', filters)} data-icon={licon.Book}>
            Explorer as White
          </a>
          <a className="button button-secondary button-thin" href={lineExplorerHref(p.slug, 'black', filters)} data-icon={licon.Book}>
            as Black
          </a>
        </nav>
      </header>

      <Ratings ratings={report.ratings} />

      {totalGames === 0 ? (
        <p className="muted lib-prep-card__nogames">
          No games match these filters{p.lastUpdated ? '' : ' (this profile has not synced yet)'}.
        </p>
      ) : (
        <>
          {report.sampledGames != null && (
            <p className="muted lib-prep-card__sampled">
              Lines and activity come from the latest {fullNumber(report.sampledGames)} of {fullNumber(totalGames)} games; the
              game counts and results include them all.
            </p>
          )}
          <div className="lib-prep-sides">
            <SideReport side="white" data={report.asWhite} slug={p.slug} filters={filters} minGames={minGames} />
            <SideReport side="black" data={report.asBlack} slug={p.slug} filters={filters} minGames={minGames} />
          </div>
          <div className="lib-prep-bottom">
            <RecentGames games={report.recentGames} utc={utc} />
            <Activity activity={report.activity} />
          </div>
        </>
      )}
    </article>
  );
}

function Ratings({ ratings }: { ratings: PrepOpponentReport['ratings'] }) {
  const rows = ratings.filter(r => r.ratings.length > 0);
  if (rows.length === 0) return null;
  const seen: Partial<Record<SourceKind, number>> = {};
  return (
    <dl className="lib-prep-ratings">
      {rows.map(r => {
        seen[r.kind] = (seen[r.kind] ?? 0) + 1;
        const n = rows.filter(x => x.kind === r.kind).length;
        return (
          <div key={r.sourceId} className="lib-prep-ratings__row">
            <dt>
              {SOURCE_KIND_LABELS[r.kind]}
              {n > 1 ? ` ${seen[r.kind]}` : ''}
            </dt>
            {[...r.ratings]
              .sort((a, b) => b.games - a.games)
              .map(cr => (
                <dd key={cr.timeClass} title={`${TIME_CLASS_LABELS[cr.timeClass]}: ${cr.rating}${cr.provisional ? '?' : ''} (${plural(cr.games, 'game')})`}>
                  <TimeClassIcon tc={cr.timeClass} />
                  <strong>
                    {cr.rating}
                    {cr.provisional ? '?' : ''}
                  </strong>
                </dd>
              ))}
          </div>
        );
      })}
    </dl>
  );
}

function SideReport({
  side,
  data,
  slug,
  filters,
  minGames,
}: {
  side: Color;
  data: PrepSide;
  slug: string;
  filters: ProfileFilters;
  minGames: number | undefined;
}) {
  const total = data.wdl.w + data.wdl.d + data.wdl.l;
  const score = total ? (data.wdl.w + data.wdl.d / 2) / total : null;
  return (
    <section className={`lib-prep-side lib-prep-side--${side}`}>
      <h3>
        <i className={`lib-colordot lib-colordot--${side}`} aria-hidden />
        As {side === 'white' ? 'White' : 'Black'}
        <span className="lib-prep-side__count">
          {plural(data.games, 'game')} · {percent(score)}
        </span>
      </h3>
      {total > 0 && <WdlBar w={data.wdl.w} d={data.wdl.d} l={data.wdl.l} side={side} />}
      <h4>Main lines</h4>
      <LineTable lines={data.topLines} side={side} slug={slug} filters={filters} empty="No repeated lines yet." />
      <h4>
        Weakest lines
        {minGames !== undefined && <span className="muted lib-prep-side__min"> (min {plural(minGames, 'game')})</span>}
      </h4>
      <LineTable lines={data.worstLines} side={side} slug={slug} filters={filters} empty="No weak spot stands out." />
    </section>
  );
}

function LineTable({
  lines,
  side,
  slug,
  filters,
  empty,
}: {
  lines: readonly PrepLine[];
  side: Color;
  slug: string;
  filters: ProfileFilters;
  empty: string;
}) {
  if (lines.length === 0) return <p className="muted lib-prep-empty">{empty}</p>;
  return (
    <table className="lib-prep-lines">
      <thead>
        <tr>
          <th>Line</th>
          <th className="num">Games</th>
          <th className="lib-prep-lines__bar">Result</th>
          <th className="num">Score</th>
        </tr>
      </thead>
      <tbody>
        {lines.map(l => (
          <tr key={l.line}>
            <td className="lib-prep-lines__line">
              <a href={lineExplorerHref(slug, side, filters, l.san)} title="Open in the explorer at this line">
                <span className="san">{l.san}</span>
              </a>
              {(l.eco || l.name) && (
                <span className="lib-prep-lines__name">
                  {l.eco && <span className="lib-eco">{l.eco}</span>} {l.name}
                </span>
              )}
            </td>
            <td className="num lib-prep-lines__games" data-unit={l.games === 1 ? 'game' : 'games'}>
              {fullNumber(l.games)}
            </td>
            <td className="lib-prep-lines__bar">
              <WdlBar w={l.w} d={l.d} l={l.l} side={side} />
            </td>
            <td className="num lib-prep-lines__score">
              <strong>{percent(l.score)}</strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OUTCOME_LABEL = { w: 'Won', d: 'Drew', l: 'Lost' } as const;

function RecentGames({ games, utc }: { games: readonly GameRow[]; utc: boolean }) {
  return (
    <section className="lib-prep-recent">
      <h4>Recent games</h4>
      {games.length === 0 ? (
        <p className="muted lib-prep-empty">None.</p>
      ) : (
        <ul>
          {games.map(g => (
            <li key={g.id}>
              <span className={`lib-outcome lib-outcome--${g.outcome}`} title={`${OUTCOME_LABEL[g.outcome]} (${resultLabel(g.result)})`}>
                {g.outcome.toUpperCase()}
              </span>
              <i className={`lib-colordot lib-colordot--${g.color}`} title={g.color} aria-label={`as ${g.color}`} />
              <span className="lib-prep-recent__opp">
                {g.opponent.title && <span className="title-badge">{g.opponent.title}</span>}
                {g.opponent.name}
                {g.opponent.rating !== null && <span className="muted"> {g.opponent.rating}</span>}
              </span>
              <span className="lib-prep-recent__opening" title={g.openingName ?? undefined}>
                {g.eco && <span className="lib-eco">{g.eco}</span>} {g.openingName ?? ''}
              </span>
              <TimeClassIcon tc={g.timeClass} />
              <a className="lib-prep-recent__date" href={paths.studio({ game: g.id, color: g.color })} title="Open in the Studio">
                {formatDate(g.endedAt, utc)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Activity({ activity }: { activity: PrepOpponentReport['activity'] }) {
  const hours = busiestHours(activity.byHour);
  const day = peakIndex(activity.byWeekday);
  return (
    <section className="lib-prep-activity">
      <h4>When they play</h4>
      {hours ? (
        <p className="lib-prep-activity__summary">
          Mostly <strong>{hours}</strong>
          {day >= 0 && (
            <>
              , busiest on <strong>{WEEKDAYS[day]}</strong>
            </>
          )}{' '}
          <span className="muted">({activity.tz})</span>
        </p>
      ) : (
        <p className="muted lib-prep-empty">No games to chart.</p>
      )}
      {hours && (
        <div className="lib-prep-activity__charts">
          <ActivityBars cells={activity.byHour} labels={HOUR_LABELS} names={HOUR_NAMES} title="By hour" />
          <ActivityBars cells={activity.byWeekday} labels={DAY_LABELS} names={WEEKDAYS} title="By weekday" className="lib-bars--week" />
        </div>
      )}
    </section>
  );
}
