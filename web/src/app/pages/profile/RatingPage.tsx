import { useState } from 'react';
import type { RatingAverage, TimeClass } from '@outpost/shared/api';
import { TIME_CLASSES } from '@outpost/shared/chess';
import { resolveDateRange, type Period, type ProfileFilters } from '@outpost/shared/filters';
import { useRatingStats, useUrlFilters } from '../../api/hooks.ts';
import { Box, Card, EmptyState, ErrorBox, licon, Spinner, TIME_CLASS_LABELS } from '../../components/index.ts';
import { ScoreText, Segmented, SelectField } from './components/bits.tsx';
import { Swatch } from './components/charts/common.tsx';
import { RatingChart } from './components/charts/RatingChart.tsx';
import { toChartSeries } from './components/charts/ratingSeries.ts';
import { fmtInt, fmtRating } from './format.ts';
import { useProfile } from './hooks.ts';

const RANGES = ['all', '30d', '3m', '6m', '12m'] as const;
type Range = (typeof RANGES)[number];
/** Lines shown at first (the most-played ones); the legend switches the others on. */
const DEFAULT_LINES = 3;
const RANGE_LABELS: Readonly<Record<Range, string>> = { all: 'All', '30d': '30 days', '3m': '3 months', '6m': '6 months', '12m': '1 year' };

/**
 * Rating tab (PLAN §5, §6 `GET /api/profiles/:slug/rating`): rating history per account and time
 * class (narrowing the filter's `src` / `tc`), over the filters' date range, with averages over
 * the last N games.
 */
export default function RatingPage() {
  const { slug, header, timeZone } = useProfile();
  const [filters, setFilters] = useUrlFilters();
  // Lines the viewer switched on or off; the rest follow the default (the most-played few).
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const rating = useRatingStats(slug, filters);

  const src = filters.src?.length === 1 ? String(filters.src[0]) : 'all';
  const tc = filters.tc?.length === 1 ? filters.tc[0]! : 'all';
  const range: Range | 'custom' = filters.period && (RANGES as readonly string[]).includes(filters.period) ? (filters.period as Range) : filters.from || filters.to ? 'custom' : 'all';
  const set = (patch: Partial<ProfileFilters>) => setFilters({ ...filters, ...patch });

  const playedClasses = new Set(header.sources.flatMap(s => s.ratings.map(r => r.timeClass)));
  const tcOptions = TIME_CLASSES.filter(t => t !== 'unknown' && (playedClasses.size === 0 || playedClasses.has(t) || t === tc));

  const controls = (
    <div className="rating-controls">
      {header.sources.length > 1 && (
        <SelectField
          label="Account"
          value={src}
          options={[{ value: 'all', label: 'All accounts' }, ...header.sources.map(s => ({ value: String(s.id), label: s.displayName }))]}
          onChange={v => set({ src: v === 'all' ? undefined : [Number(v)] })}
        />
      )}
      <SelectField
        label="Time control"
        value={tc}
        options={[{ value: 'all', label: 'All time controls' }, ...tcOptions.map(t => ({ value: t, label: TIME_CLASS_LABELS[t] }))]}
        onChange={v => set({ tc: v === 'all' ? undefined : [v as TimeClass] })}
      />
      <span className="field">
        <span className="field__label">Range</span>
        <Segmented
          label="Range"
          size="sm"
          value={range === 'custom' ? ('custom' as const) : range}
          options={[
            ...RANGES.map(r => ({ value: r, label: RANGE_LABELS[r] })),
            ...(range === 'custom' ? [{ value: 'custom' as const, label: `${filters.from ?? '…'} – ${filters.to ?? '…'}` }] : []),
          ]}
          onChange={v => {
            if (v !== 'custom') set({ period: v === 'all' ? undefined : (v as Period), from: undefined, to: undefined });
          }}
        />
      </span>
    </div>
  );

  let body;
  if (rating.isPending) body = <Spinner center label="Loading ratings" />;
  else if (rating.isError) body = <ErrorBox error={rating.error} onRetry={() => void rating.refetch()} title="Could not load the rating history" />;
  else {
    const series = toChartSeries(rating.data.series, header.sources);
    const defaultOn = new Set(
      [...series]
        .sort((a, b) => b.points.length - a.points.length)
        .slice(0, DEFAULT_LINES)
        .map(s => s.key),
    );
    const isOn = (key: string) => toggled.get(key) ?? defaultOn.has(key);
    const shown = series.filter(s => isOn(s.key));
    const { from, to } = resolveDateRange(filters);
    const allT = series.flatMap(s => s.points.map(p => p[0]));
    const xDomain: [number, number] | undefined =
      from !== null || to !== null ? [from ?? Math.min(...allT), to ?? Date.now()] : undefined;
    body =
      series.length === 0 ? (
        <EmptyState icon={licon.LineGraph} title="No rated games in this selection" />
      ) : (
        <>
          <ul className="series-legend series-legend--toggles" aria-label="Lines">
            {series.map(s => {
              const off = !isOn(s.key);
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    className={['chip', !off && 'active'].filter(Boolean).join(' ')}
                    aria-pressed={!off}
                    onClick={() => setToggled(t => new Map(t).set(s.key, off))}
                  >
                    <Swatch color={s.color} dash={s.dash} />
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className={rating.isPlaceholderData ? 'is-stale' : undefined}>
            <RatingChart series={shown} height={320} xDomain={xDomain} timeZone={timeZone} title="Rating history" />
          </div>
        </>
      );
  }

  return (
    <div className="rating-page">
      <Box title="Rating history" level={2} actions={controls} className="rating-box">
        {body}
      </Box>
      {rating.data && <AveragesCard averages={rating.data.averages} narrowed={src !== 'all' || header.sources.length === 1} tcNarrowed={tc !== 'all'} />}
    </div>
  );
}

function AveragesCard({ averages, narrowed, tcNarrowed }: { averages: readonly RatingAverage[]; narrowed: boolean; tcNarrowed: boolean }) {
  // A "last N" window with fewer than N games repeats the "all games" line.
  const rows = averages.filter(a => a.games > 0 && (a.n === null || a.games >= a.n));
  return (
    <Card title="Averages" pad={false} className="rating-averages">
      {!(narrowed && tcNarrowed) && rows.length > 0 && (
        <p className="card-sub card-sub--pad">Ratings from different accounts and time controls don’t compare: pick one of each for meaningful averages.</p>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No games in this selection" />
      ) : (
        <div className="table-wrap">
          <table className="slist">
            <thead>
              <tr>
                <th>Over</th>
                <th className="num">Games</th>
                <th className="num">Avg. rating</th>
                <th className="num">Avg. opponent</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.n ?? 'all'}>
                  <td>{a.n === null ? 'All games' : `Last ${fmtInt(a.n)} games`}</td>
                  <td className="num">{fmtInt(a.games)}</td>
                  <td className="num">{fmtRating(a.avgRating)}</td>
                  <td className="num">{fmtRating(a.avgOppRating)}</td>
                  <td className="num">
                    <ScoreText score={a.score} />
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
