import type { ActivityCell } from '@outpost/shared/api';
import type { ProfileFilters } from '@outpost/shared/filters';
import { useActivity } from '../../api/hooks.ts';
import { Box, Card, EmptyState, ErrorBox, licon, Spinner } from '../../components/index.ts';
import { Segmented, StatTile } from './components/bits.tsx';
import { ColumnChart, type ColumnDatum } from './components/charts/ColumnChart.tsx';
import { ActivityTip, ScoreLegend, SeqLegend } from './components/charts/common.tsx';
import { CalendarHeatmap, HourGrid, type HeatMode } from './components/charts/Heatmaps.tsx';
import { fmtHour, fmtInt, fmtPct, WEEKDAYS, WEEKDAYS_SHORT } from './format.ts';
import { oneOf, useProfile, useQueryParam } from './hooks.ts';

const SPANS = ['12m', 'all'] as const;
type Span = (typeof SPANS)[number];
const MODES = ['games', 'score'] as const;

/** Score of a set of buckets, weighted by games. */
function combinedScore(cells: readonly ActivityCell[]): number | null {
  let games = 0;
  let points = 0;
  for (const c of cells) {
    if (c.games === 0 || c.score === null) continue;
    games += c.games;
    points += c.score * c.games;
  }
  return games === 0 ? null : points / games;
}

/**
 * Activity tab (PLAN §5, §6 `GET /api/profiles/:slug/activity?tz=`): a calendar of the last
 * year, games by hour and by weekday, and the weekday × hour grid. Buckets use the viewer's
 * time-zone preference (local or UTC), which can be switched here.
 */
export default function ActivityPage() {
  const { slug, timeZone, prefs, setTimeZonePref } = useProfile();
  const [span, setSpan] = useQueryParam<Span>('span', oneOf(SPANS, '12m'), '12m');
  const [mode, setMode] = useQueryParam<HeatMode>('colour', oneOf(MODES, 'games'), 'games');
  const filters: ProfileFilters = span === '12m' ? { period: '12m' } : {};
  const activity = useActivity(slug, filters, timeZone);

  const actions = (
    <div className="activity-controls">
      <Segmented
        label="Range"
        size="sm"
        value={span}
        options={[
          { value: '12m', label: 'Last 12 months' },
          { value: 'all', label: 'All time' },
        ]}
        onChange={v => setSpan(v, { replace: true })}
      />
      <Segmented
        label="Time zone"
        size="sm"
        value={prefs.timezone}
        options={[
          { value: 'local', label: 'My time', title: `Your browser's time zone` },
          { value: 'utc', label: 'UTC' },
        ]}
        onChange={v => setTimeZonePref(v)}
      />
    </div>
  );

  let body;
  if (activity.isPending) body = <Spinner center label="Loading activity" />;
  else if (activity.isError) body = <ErrorBox error={activity.error} onRetry={() => void activity.refetch()} title="Could not load the activity" />;
  else {
    const a = activity.data;
    const total = a.byHour.reduce((n, c) => n + c.games, 0);
    if (total === 0) {
      body = <EmptyState icon={licon.Clock} title={span === '12m' ? 'No games in the last 12 months' : 'No games yet'} />;
    } else {
      const activeDays = a.days.filter(d => d.games > 0).length;
      const busiestHour = a.byHour.reduce((best, c, h) => (c.games > (a.byHour[best]?.games ?? 0) ? h : best), 0);
      const busiestDay = a.byWeekday.reduce((best, c, d) => (c.games > (a.byWeekday[best]?.games ?? 0) ? d : best), 0);
      const hourData: ColumnDatum[] = a.byHour.map((c, h) => ({
        key: String(h),
        label: fmtHour(h),
        games: c.games,
        score: c.score,
        tip: <ActivityTip title={`${fmtHour(h)}:00–${fmtHour(h)}:59`} games={c.games} score={c.score} />,
      }));
      const dayData: ColumnDatum[] = a.byWeekday.map((c, d) => ({
        key: String(d),
        label: WEEKDAYS_SHORT[d]!,
        games: c.games,
        score: c.score,
        tip: <ActivityTip title={WEEKDAYS[d]} games={c.games} score={c.score} />,
      }));
      body = (
        <>
          <div className="activity-summary">
            <StatTile value={fmtInt(total)} label="Games" />
            <StatTile value={fmtInt(activeDays)} label="Days played" />
            <StatTile value={activeDays ? (total / activeDays).toFixed(1) : '–'} label="Games per day played" />
            <StatTile value={WEEKDAYS[busiestDay]} label="Busiest day" />
            <StatTile value={`${fmtHour(busiestHour)}:00`} label="Busiest hour" />
            <StatTile value={fmtPct(combinedScore(a.byHour))} label="Score" />
          </div>
          <p className="muted activity-tz">
            Times in {a.tz === 'UTC' ? 'UTC' : a.tz.replace(/_/g, ' ')}.
          </p>
          <div className="activity-grid">
            <Card
              title="Last year"
              className="activity-calendar"
              actions={
                <Segmented
                  label="Colour by"
                  size="sm"
                  value={mode}
                  options={[
                    { value: 'games', label: 'Games' },
                    { value: 'score', label: 'Score' },
                  ]}
                  onChange={v => setMode(v, { replace: true })}
                />
              }
            >
              <CalendarHeatmap days={a.days} timeZone={timeZone} mode={mode} />
              {mode === 'games' ? <SeqLegend label="Games per day" /> : <ScoreLegend />}
            </Card>
            <Card title="By hour">
              <ColumnChart data={hourData} height={190} title="Games by hour of day" showLabel={i => i % 3 === 0} />
              <ScoreLegend />
            </Card>
            <Card title="By weekday">
              <ColumnChart data={dayData} height={190} title="Games by weekday" showLabel={() => true} />
              <ScoreLegend />
            </Card>
            <Card title="Weekday × hour" className="activity-hourgrid">
              <HourGrid grid={a.grid} mode={mode} />
              {mode === 'games' ? <SeqLegend label="Games" /> : <ScoreLegend />}
            </Card>
          </div>
        </>
      );
    }
  }

  return (
    <Box title="Activity" level={2} actions={actions} className={['activity-box', activity.isPlaceholderData && 'is-stale'].filter(Boolean).join(' ')}>
      {body}
    </Box>
  );
}
