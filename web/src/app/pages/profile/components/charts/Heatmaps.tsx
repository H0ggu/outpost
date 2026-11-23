/**
 * Activity heatmaps: a year calendar (one cell per day, weeks as columns, Monday on top) and the
 * weekday × hour grid. Cells are coloured by games (sequential) or by score (diverging); hovering
 * or tapping a cell shows its numbers.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ActivityCell, ActivityDay } from '@outpost/shared/api';
import { fmtHour, fmtIsoDay, WEEKDAYS, WEEKDAYS_SHORT } from '../../format.ts';
import { useElementWidth } from '../../hooks.ts';
import { ActivityTip, ChartTooltip, clamp, scoreBin, scoreColor, seqBin, seqColor, type TooltipState } from './common.tsx';

/** What the cell colour shows. */
export type HeatMode = 'games' | 'score';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Today's date (`YYYY-MM-DD`) in an IANA zone. */
export function isoToday(timeZone: string, now: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
const isoOfDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** Monday = 0 … Sunday = 6. */
const weekdayOf = (n: number): number => (new Date(n * DAY_MS).getUTCDay() + 6) % 7;

const cellFill = (mode: HeatMode, c: ActivityCell, max: number): string =>
  c.games === 0 ? seqColor(0) : mode === 'games' ? seqColor(seqBin(c.games, max)) : scoreColor(scoreBin(c.score));

/** Props of `CalendarHeatmap`. */
export interface CalendarHeatmapProps {
  days: readonly ActivityDay[];
  /** Last day shown (`YYYY-MM-DD`); default today in `timeZone`. */
  end?: string;
  timeZone: string;
  mode: HeatMode;
  /** Number of weeks (default 53 ≈ one year). */
  weeks?: number;
}

/** The last year as a calendar of days. Scrolls inside its box on narrow screens. */
export function CalendarHeatmap({ days, end, timeZone, mode, weeks = 53 }: CalendarHeatmapProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(scrollRef);
  const [tip, setTip] = useState<TooltipState | null>(null);

  const endN = dayNumber(end ?? isoToday(timeZone));
  const startN = endN - (weeks - 1) * 7 - weekdayOf(endN);
  const cols = Math.ceil((endN - startN + 1) / 7);
  const left = 30;
  const top = 16;
  const size = clamp(Math.floor((width - left - 2) / cols), 10, 16);
  const gap = size >= 13 ? 3 : 2;
  const svgW = left + cols * size;
  const svgH = top + 7 * size;

  const byDate = new Map(days.map(d => [d.date, d]));
  let max = 0;
  for (let n = startN; n <= endN; n++) max = Math.max(max, byDate.get(isoOfDayNumber(n))?.games ?? 0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [svgW]);

  // Month labels: at each column whose Monday starts a new month (kept 3 columns apart).
  const months: Array<{ col: number; label: string }> = [];
  for (let col = 0; col < cols; col++) {
    const monday = isoOfDayNumber(startN + col * 7);
    const prev = col === 0 ? null : isoOfDayNumber(startN + (col - 1) * 7);
    if (prev && monday.slice(5, 7) === prev.slice(5, 7)) continue;
    // The first, partial month only gets a label when it has room before the next one.
    if (!prev && Number(monday.slice(8, 10)) > 14) continue;
    const last = months[months.length - 1];
    if (last && col - last.col < 3) continue;
    if (col > cols - 2) continue;
    months.push({ col, label: MONTHS[Number(monday.slice(5, 7)) - 1]! });
  }

  const cells = [];
  for (let n = startN; n <= endN; n++) {
    const iso = isoOfDayNumber(n);
    const col = Math.floor((n - startN) / 7);
    const row = weekdayOf(n);
    const d = byDate.get(iso) ?? { date: iso, games: 0, score: null };
    const cx = left + col * size;
    const cy = top + row * size;
    cells.push(
      <rect
        key={iso}
        className="heat-cell"
        x={cx}
        y={cy}
        width={size - gap}
        height={size - gap}
        rx={2}
        style={{ fill: cellFill(mode, d, max) }}
        onPointerEnter={() =>
          setTip({ x: cx + size / 2 - (scrollRef.current?.scrollLeft ?? 0), y: cy - 4, content: <ActivityTip title={fmtIsoDay(iso)} games={d.games} score={d.score} /> })
        }
        onClick={() =>
          setTip({ x: cx + size / 2 - (scrollRef.current?.scrollLeft ?? 0), y: cy - 4, content: <ActivityTip title={fmtIsoDay(iso)} games={d.games} score={d.score} /> })
        }
      />,
    );
  }

  return (
    <div className="chart heat-calendar">
      <div ref={scrollRef} className="chart-scroll" onScroll={() => setTip(null)}>
        <svg width={svgW} height={svgH} role="img" aria-label="Games per day over the last year" onPointerLeave={() => setTip(null)}>
          {months.map(m => (
            <text key={`${m.col}-${m.label}`} className="chart-axis-text" x={left + m.col * size} y={10}>
              {m.label}
            </text>
          ))}
          {[0, 2, 4].map(r => (
            <text key={r} className="chart-axis-text" x={0} y={top + r * size + (size - gap) / 2} dy="0.32em">
              {WEEKDAYS_SHORT[r]}
            </text>
          ))}
          {cells}
        </svg>
      </div>
      <ChartTooltip tip={tip} width={width} />
    </div>
  );
}

/** Props of `HourGrid`. */
export interface HourGridProps {
  /** `grid[weekday][hour]`, Monday first. */
  grid: readonly (readonly ActivityCell[])[];
  mode: HeatMode;
}

/** Weekday × hour grid. */
export function HourGrid({ grid, mode }: HourGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [tip, setTip] = useState<TooltipState | null>(null);
  const left = 34;
  const top = 16;
  const size = clamp(Math.floor((width - left) / 24), 10, 34);
  const gap = size >= 16 ? 3 : 2;
  const svgW = left + 24 * size;
  const svgH = top + 7 * size;
  const max = Math.max(0, ...grid.flat().map(c => c.games));
  const hourStep = size >= 22 ? 2 : 3;

  return (
    <div ref={ref} className="chart hour-grid">
      <svg width={svgW} height={svgH} role="img" aria-label="Games by weekday and hour" onPointerLeave={() => setTip(null)}>
        {Array.from({ length: 24 }, (_, h) =>
          h % hourStep === 0 ? (
            <text key={h} className="chart-axis-text" x={left + h * size + (size - gap) / 2} y={10} textAnchor="middle">
              {fmtHour(h)}
            </text>
          ) : null,
        )}
        {WEEKDAYS_SHORT.map((d, r) => (
          <text key={d} className="chart-axis-text" x={0} y={top + r * size + (size - gap) / 2} dy="0.32em">
            {d}
          </text>
        ))}
        {grid.map((row, r) =>
          row.map((c, h) => {
            const x = left + h * size;
            const y = top + r * size;
            const show = () =>
              setTip({
                x: x + size / 2,
                y: y - 4,
                content: <ActivityTip title={`${WEEKDAYS[r]} ${fmtHour(h)}:00–${fmtHour(h)}:59`} games={c.games} score={c.score} />,
              });
            return (
              <rect
                key={`${r}-${h}`}
                className="heat-cell"
                x={x}
                y={y}
                width={size - gap}
                height={size - gap}
                rx={2}
                style={{ fill: cellFill(mode, c, max) }}
                onPointerEnter={show}
                onClick={show}
              />
            );
          }),
        )}
      </svg>
      <ChartTooltip tip={tip} width={width} />
    </div>
  );
}
