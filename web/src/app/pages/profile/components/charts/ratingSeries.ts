/**
 * Contract rating series → chart lines: colour by time class (fixed per entity), dash by
 * account, label "account · time class".
 */
import type { RatingSeries, SourceSummary } from '@outpost/shared/api';
import { TIME_CLASS_LABELS } from '../../../../components/index.ts';
import { seriesColor, SOURCE_DASHES, TIME_CLASS_SERIES } from './common.tsx';
import type { ChartSeries } from './RatingChart.tsx';

/** Stable key of a series. */
export const seriesKey = (s: Pick<RatingSeries, 'sourceId' | 'timeClass'>): string => `${s.sourceId}:${s.timeClass}`;

/** Maps contract series to chart lines, ordered by time class then account. */
export function toChartSeries(series: readonly RatingSeries[], sources: readonly Pick<SourceSummary, 'id' | 'displayName' | 'kind'>[]): ChartSeries[] {
  const multi = new Set(series.map(s => s.sourceId)).size > 1;
  return [...series]
    .sort((a, b) => TIME_CLASS_SERIES[a.timeClass] - TIME_CLASS_SERIES[b.timeClass] || a.sourceId - b.sourceId)
    .map(s => {
      const idx = sources.findIndex(x => x.id === s.sourceId);
      const src = sources[idx];
      const tc = TIME_CLASS_LABELS[s.timeClass];
      return {
        key: seriesKey(s),
        label: multi && src ? `${src.displayName} · ${tc}` : tc,
        color: seriesColor(TIME_CLASS_SERIES[s.timeClass]),
        dash: SOURCE_DASHES[Math.max(0, idx) % SOURCE_DASHES.length],
        points: s.points,
      };
    });
}

/**
 * Games behind a series: the header's game count for that account and time class, else (no
 * current rating there) its number of points. Points alone can't rank lines: the server sends
 * one point per day and downsamples long histories to a fixed cap, so busy lines tie.
 */
export function seriesGames(s: Pick<RatingSeries, 'sourceId' | 'timeClass' | 'points'>, sources: readonly Pick<SourceSummary, 'id' | 'ratings'>[]): number {
  const games = sources.find(x => x.id === s.sourceId)?.ratings.find(r => r.timeClass === s.timeClass)?.games;
  return games ?? s.points.length;
}

/** The `n` most-played series (by `seriesGames`, then points), in their given order. */
export function mostPlayed<T extends Pick<RatingSeries, 'sourceId' | 'timeClass' | 'points'>>(
  series: readonly T[],
  sources: readonly Pick<SourceSummary, 'id' | 'ratings'>[],
  n: number,
): T[] {
  const keep = new Set(
    [...series]
      .sort((a, b) => seriesGames(b, sources) - seriesGames(a, sources) || b.points.length - a.points.length)
      .slice(0, n),
  );
  return series.filter(s => keep.has(s));
}
