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
