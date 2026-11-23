/**
 * Shared chart pieces (React-rendered SVG with d3 scales, no chart library — PLAN §1):
 * colour bins, the hover tooltip, legends and the rounded column path.
 *
 * Colours come from CSS tokens in profile.css, each with dark and light steps:
 * - `--c-seq-0..5`: one-hue sequential ramp for magnitude (games, opponents); 0 = no data;
 * - `--c-div-0..6`: diverging score scale in lila's result hues, red (0%) → grey (50%) → green
 *   (100%), lighter towards wins (never blue, which is the count ramp's hue);
 * - `--c-series-1..8`: categorical series, assigned by entity (time class), never by rank.
 */
import type { ReactNode } from 'react';
import type { TimeClass } from '@outpost/shared/chess';
import { fmtPct } from '../../format.ts';

// ---------------------------------------------------------------------------
// Colour bins
// ---------------------------------------------------------------------------

/** Number of non-empty sequential steps. */
export const SEQ_STEPS = 5;

/**
 * Sequential bin 1–5 of `value` relative to `max` (0 for no data). The thresholds are
 * square-root spaced so a few very busy days don't wash out the rest.
 */
export function seqBin(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const r = Math.sqrt(value / max);
  return Math.min(SEQ_STEPS, Math.max(1, Math.ceil(r * SEQ_STEPS)));
}

/** Upper edges of the score bins (0–6); bin 3 is the neutral 45–55% band. */
const SCORE_EDGES = [0.2, 0.35, 0.45, 0.55, 0.65, 0.8] as const;

/** Diverging score bin 0–6, or null without games. */
export function scoreBin(score: number | null | undefined): number | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  for (let i = 0; i < SCORE_EDGES.length; i++) {
    const edge = SCORE_EDGES[i]!;
    if (i === 3 ? score <= edge : score < edge) return i;
  }
  return SCORE_EDGES.length;
}

/** CSS colour of a sequential bin. */
export const seqColor = (bin: number): string => `var(--c-seq-${bin})`;
/** CSS colour of a score bin (neutral grey surface when null). */
export const scoreColor = (bin: number | null): string => (bin === null ? 'var(--c-seq-0)' : `var(--c-div-${bin})`);

/** Series colour per time class (fixed by entity, so filtering never repaints a line). */
export const TIME_CLASS_SERIES: Readonly<Record<TimeClass, number>> = {
  bullet: 1,
  blitz: 2,
  rapid: 3,
  classical: 4,
  correspondence: 5,
  unknown: 7,
};
export const seriesColor = (slot: number): string => `var(--c-series-${slot})`;

/** Dash patterns telling sources apart when two accounts share a time class. */
export const SOURCE_DASHES = ['', '6 4', '2 3', '10 3 2 3'] as const;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A column from `y0` (baseline) up to `y` with 4px rounded top corners and a square base. */
export function columnPath(x: number, w: number, y: number, y0: number, radius = 4): string {
  const h = y0 - y;
  if (h <= 0 || w <= 0) return '';
  const r = Math.min(radius, w / 2, h);
  return `M${x},${y0}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y0}Z`;
}

/** Clamps a number into [min, max]. */
export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

// ---------------------------------------------------------------------------
// Tooltip and legends
// ---------------------------------------------------------------------------

/** Hover state of a chart: where to anchor the tooltip (px in the chart box) and what it says. */
export interface TooltipState {
  x: number;
  y: number;
  content: ReactNode;
  /** `above` (default) centres the tip above the point; `side` puts it beside a crosshair. */
  placement?: 'above' | 'side';
}

/** A tooltip anchored at (x, y) inside a `position: relative` chart box of width `width`. */
export function ChartTooltip({ tip, width }: { tip: TooltipState | null; width: number }) {
  if (!tip) return null;
  if (tip.placement === 'side') {
    const flip = tip.x > width / 2;
    return (
      <div
        className="chart-tip chart-tip--side"
        role="status"
        style={{ left: flip ? tip.x - 12 : tip.x + 12, top: tip.y, transform: flip ? 'translateX(-100%)' : 'none' }}
      >
        {tip.content}
      </div>
    );
  }
  const left = clamp(tip.x, 70, Math.max(70, width - 70));
  return (
    <div className="chart-tip" role="status" style={{ left, top: tip.y }}>
      {tip.content}
    </div>
  );
}

/** One line of a tooltip: optional swatch, label and value. */
export function TipRow({ swatch, label, value, dash }: { swatch?: string; label: ReactNode; value: ReactNode; dash?: string }) {
  return (
    <div className="chart-tip__row">
      {swatch && <Swatch color={swatch} dash={dash} />}
      <span className="chart-tip__label">{label}</span>
      <span className="chart-tip__value">{value}</span>
    </div>
  );
}

/** A line swatch (with dash) for series legends and tooltips. */
export function Swatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg className="swatch" width="18" height="10" viewBox="0 0 18 10" aria-hidden>
      <line x1="1" y1="5" x2="17" y2="5" style={{ stroke: color }} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dash || undefined} />
    </svg>
  );
}

/** "Less ▢▢▢▢▢ More" legend of the sequential ramp. */
export function SeqLegend({ low = 'Fewer', high = 'More', label }: { low?: string; high?: string; label?: string }) {
  return (
    <div className="chart-legend" role="group" aria-label={label ? `${label} colour scale` : 'Colour scale'}>
      {label && <span className="chart-legend__title">{label}</span>}
      <span>{low}</span>
      {Array.from({ length: SEQ_STEPS }, (_, i) => (
        <span key={i} className="chart-legend__cell" style={{ background: seqColor(i + 1) }} />
      ))}
      <span>{high}</span>
    </div>
  );
}

/** Legend of the diverging score bins: 0% … 50% … 100%. */
export function ScoreLegend({ label = 'Score' }: { label?: string }) {
  const titles = ['under 20%', '20–35%', '35–45%', '45–55%', '55–65%', '65–80%', 'over 80%'];
  return (
    <div className="chart-legend" role="group" aria-label={`${label} colour scale`}>
      <span className="chart-legend__title">{label}</span>
      <span>0%</span>
      {titles.map((t, i) => (
        <span key={t} className="chart-legend__cell" title={t} style={{ background: scoreColor(i) }} />
      ))}
      <span>100%</span>
    </div>
  );
}

/** A legend of a few named colours (e.g. played / not played). */
export function CategoryLegend({ label, items }: { label: string; items: ReadonlyArray<{ label: string; color: string }> }) {
  return (
    <div className="chart-legend" role="group" aria-label={label}>
      {items.map(i => (
        <span key={i.label} className="chart-legend__item">
          <span className="chart-legend__cell" style={{ background: i.color }} />
          <span>{i.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Tooltip lines shared by activity cells: games and score. */
export function ActivityTip({ title, games, score }: { title: ReactNode; games: number; score: number | null }) {
  return (
    <>
      <div className="chart-tip__title">{title}</div>
      <TipRow label="Games" value={games} />
      {games > 0 && <TipRow label="Score" value={fmtPct(score)} />}
    </>
  );
}
