/**
 * Column chart: height = games, fill = score bin (diverging), with a per-column hover tooltip.
 * Used for the overview's 90-day activity strip and the activity tab's by-hour / by-weekday charts.
 */
import { scaleBand, scaleLinear } from 'd3-scale';
import { useRef, useState, type ReactNode } from 'react';
import { fmtCompact } from '../../format.ts';
import { useElementWidth } from '../../hooks.ts';
import { ChartTooltip, columnPath, scoreBin, scoreColor, type TooltipState } from './common.tsx';

/** One column. */
export interface ColumnDatum {
  key: string;
  /** Axis label (shown when `showLabel` allows it). */
  label: string;
  games: number;
  score: number | null;
  /** Tooltip content. */
  tip: ReactNode;
}

/** Props of `ColumnChart`. */
export interface ColumnChartProps {
  data: readonly ColumnDatum[];
  height?: number;
  /** Which x labels to print (default: every label that fits). */
  showLabel?: (index: number, count: number, width: number) => boolean;
  /** Accessible summary. */
  title: string;
  /** Draw y-axis gridlines and ticks (off for sparkline-style strips). */
  axis?: boolean;
  className?: string;
}

/** A responsive column chart. */
export function ColumnChart({ data, height = 180, showLabel, title, axis = true, className }: ColumnChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const m = { top: 8, right: 4, bottom: 20, left: axis ? 34 : 4 };
  const innerW = Math.max(10, width - m.left - m.right);
  const max = Math.max(1, ...data.map(d => d.games));
  const x = scaleBand<number>()
    .domain(data.map((_, i) => i))
    .range([m.left, m.left + innerW])
    .paddingInner(data.length > 40 ? 0.12 : 0.22)
    .paddingOuter(0.05);
  const y = scaleLinear().domain([0, max]).nice(4).range([height - m.bottom, m.top]);
  const bw = Math.min(24, x.bandwidth());
  const offset = (x.bandwidth() - bw) / 2;
  const ticks = axis ? y.ticks(4).filter(t => Number.isInteger(t)) : [];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(innerW / 34))));
  const show = showLabel ?? ((i: number) => i % labelEvery === 0);

  const onEnter = (i: number) => {
    const d = data[i]!;
    setHover(i);
    setTip({ x: (x(i) ?? 0) + x.bandwidth() / 2, y: Math.min(y(d.games), height - m.bottom - 4) - 6, content: d.tip });
  };
  const onLeave = () => {
    setHover(null);
    setTip(null);
  };

  return (
    <div ref={ref} className={['chart', className].filter(Boolean).join(' ')}>
      <svg width={width} height={height} role="img" aria-label={title} onPointerLeave={onLeave}>
        {ticks.map(t => (
          <g key={t}>
            <line className="chart-grid" x1={m.left} x2={m.left + innerW} y1={y(t)} y2={y(t)} />
            <text className="chart-axis-text" x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
              {fmtCompact(t)}
            </text>
          </g>
        ))}
        <line className="chart-baseline" x1={m.left} x2={m.left + innerW} y1={y(0)} y2={y(0)} />
        {data.map((d, i) => {
          const x0 = (x(i) ?? 0) + offset;
          return (
            <path
              key={d.key}
              d={columnPath(x0, bw, y(d.games), y(0), 3)}
              style={{ fill: scoreColor(scoreBin(d.score)) }}
              className={hover === i ? 'chart-col hover' : 'chart-col'}
            />
          );
        })}
        {data.map((d, i) =>
          show(i, data.length, innerW) ? (
            <text key={d.key} className="chart-axis-text" x={(x(i) ?? 0) + x.bandwidth() / 2} y={height - 5} textAnchor="middle">
              {d.label}
            </text>
          ) : null,
        )}
        {/* Hit targets: the full height of each band, wider than the mark. */}
        {data.map((d, i) => (
          <rect
            key={d.key}
            className="chart-hit"
            x={(x(i) ?? 0) - (x.step() - x.bandwidth()) / 2}
            y={m.top}
            width={Math.max(1, x.step())}
            height={height - m.top - m.bottom}
            onPointerEnter={() => onEnter(i)}
            onClick={() => onEnter(i)}
          />
        ))}
      </svg>
      <ChartTooltip tip={tip} width={width} />
    </div>
  );
}
