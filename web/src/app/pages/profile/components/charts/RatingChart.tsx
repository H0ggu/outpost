/**
 * Rating history line chart (Rating tab, overview sparkline): one 2px line per source × time
 * class, d3 time and linear scales, a crosshair with every visible series' rating as of the
 * hovered date, and end dots with a surface ring.
 */
import { bisector, extent } from 'd3-array';
import { scaleLinear, scaleTime, scaleUtc } from 'd3-scale';
import { line } from 'd3-shape';
import { useId, useRef, useState, type PointerEvent } from 'react';
import { fmtDate, fmtRating } from '../../format.ts';
import { useElementWidth } from '../../hooks.ts';
import { ChartTooltip, clamp, TipRow, type TooltipState } from './common.tsx';

/** One line. */
export interface ChartSeries {
  key: string;
  label: string;
  /** CSS colour (a `--c-series-*` token). */
  color: string;
  /** SVG dash array ('' = solid). */
  dash?: string;
  /** `[epoch ms, rating]`, ascending time. */
  points: ReadonlyArray<readonly [number, number]>;
}

/** Props of `RatingChart`. */
export interface RatingChartProps {
  series: readonly ChartSeries[];
  height?: number;
  /** Fixed time range (from the filters); default: the data's extent. */
  xDomain?: readonly [number, number];
  /** 'UTC' formats ticks in UTC; anything else uses the browser's zone. */
  timeZone: string;
  title: string;
  compact?: boolean;
}

const byTime = bisector<readonly [number, number], number>(d => d[0]);

/** The rating as of `t` (the last point at or before it), or null before the first point. */
function ratingAt(points: ChartSeries['points'], t: number): readonly [number, number] | null {
  const i = byTime.right(points, t) - 1;
  return i >= 0 ? points[i]! : null;
}

/** A responsive rating chart. */
export function RatingChart({ series, height = 300, xDomain, timeZone, title, compact = false }: RatingChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const clipId = useId().replace(/:/g, '');
  const [hoverT, setHoverT] = useState<number | null>(null);

  const visible = series
    .map(s => ({ ...s, points: xDomain ? s.points.filter(p => p[0] >= xDomain[0] && p[0] <= xDomain[1]) : s.points }))
    .filter(s => s.points.length > 0);

  const allPoints = visible.flatMap(s => s.points);
  const m = { top: 12, right: 14, bottom: 24, left: 42 };
  const innerW = Math.max(10, width - m.left - m.right);

  if (allPoints.length === 0) {
    return (
      <div ref={ref} className="chart chart--empty" style={{ height }}>
        <span className="muted">No rated games in this range</span>
      </div>
    );
  }

  let [t0, t1] = xDomain ? [xDomain[0], xDomain[1]] : (extent(allPoints, p => p[0]) as [number, number]);
  if (t0 === t1) {
    t0 -= 86_400_000;
    t1 += 86_400_000;
  }
  const [r0, r1] = extent(allPoints, p => p[1]) as [number, number];
  const utc = timeZone === 'UTC';
  const x = (utc ? scaleUtc() : scaleTime()).domain([t0, t1]).range([m.left, m.left + innerW]);
  const y = scaleLinear()
    .domain([r0 - 15, r1 + 15])
    .nice(compact ? 3 : 5)
    .range([height - m.bottom, m.top]);
  const path = line<readonly [number, number]>()
    .x(d => x(d[0]))
    .y(d => y(d[1]));
  const xTicks = x.ticks(Math.max(2, Math.floor(innerW / (compact ? 110 : 90))));
  const xFmt = x.tickFormat();
  const yTicks = y.ticks(compact ? 3 : 5);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = clamp(e.clientX - rect.left, m.left, m.left + innerW);
    const t = x.invert(px).getTime();
    // Snap to the nearest real point of any visible series.
    let best: number | null = null;
    for (const s of visible) {
      const i = byTime.center(s.points, t);
      const p = s.points[i];
      if (p && (best === null || Math.abs(p[0] - t) < Math.abs(best - t))) best = p[0];
    }
    setHoverT(best);
  };

  let tip: TooltipState | null = null;
  const hoverDots: Array<{ key: string; cx: number; cy: number; color: string }> = [];
  if (hoverT !== null) {
    const rows = visible
      .map(s => ({ s, p: ratingAt(s.points, hoverT) }))
      .filter((r): r is { s: (typeof visible)[number]; p: readonly [number, number] } => r.p !== null);
    for (const { s, p } of rows) hoverDots.push({ key: s.key, cx: x(hoverT), cy: y(p[1]), color: s.color });
    tip = {
      x: x(hoverT),
      y: m.top,
      placement: 'side',
      content: (
        <>
          <div className="chart-tip__title">{fmtDate(hoverT, timeZone)}</div>
          {rows
            .sort((a, b) => b.p[1] - a.p[1])
            .map(({ s, p }) => (
              <TipRow key={s.key} swatch={s.color} dash={s.dash} label={s.label} value={fmtRating(p[1])} />
            ))}
        </>
      ),
    };
  }

  return (
    <div ref={ref} className="chart chart--rating">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={title}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHoverT(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={m.left} y={0} width={innerW} height={height} />
          </clipPath>
        </defs>
        {yTicks.map(t => (
          <g key={t}>
            <line className="chart-grid" x1={m.left} x2={m.left + innerW} y1={y(t)} y2={y(t)} />
            <text className="chart-axis-text" x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        <line className="chart-baseline" x1={m.left} x2={m.left + innerW} y1={height - m.bottom} y2={height - m.bottom} />
        {xTicks.map(t => (
          <text key={t.getTime()} className="chart-axis-text" x={x(t)} y={height - 6} textAnchor="middle">
            {xFmt(t)}
          </text>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {visible.map(s => (
            <path
              key={s.key}
              className="chart-line"
              d={path(s.points) ?? ''}
              style={{ stroke: s.color }}
              strokeDasharray={s.dash || undefined}
            />
          ))}
          {visible.map(s => {
            const last = s.points[s.points.length - 1]!;
            return <circle key={s.key} className="chart-dot" cx={x(last[0])} cy={y(last[1])} r={4} style={{ fill: s.color }} />;
          })}
        </g>
        {hoverT !== null && (
          <g className="chart-hover">
            <line className="chart-crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={m.top} y2={height - m.bottom} />
            {hoverDots.map(d => (
              <circle key={d.key} className="chart-dot" cx={d.cx} cy={d.cy} r={4.5} style={{ fill: d.color }} />
            ))}
          </g>
        )}
      </svg>
      <ChartTooltip tip={tip} width={width} />
    </div>
  );
}
