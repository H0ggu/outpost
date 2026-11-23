/** Small snabbdom helpers for the Studio chrome (lila's markup conventions: `data-icon`, `.button`). */
import {
  attributesModule,
  classModule,
  eventListenersModule,
  h,
  init,
  propsModule,
  styleModule,
  type VNode,
  type VNodeChildren,
  type VNodeData,
} from 'snabbdom';

import type { StudioLayout } from '@outpost/shared/api';

export { h, type VNode };

/** Names of the layout presets (PLAN §8.4). */
export const LAYOUT_LABELS: Readonly<Record<StudioLayout, string>> = {
  default: 'Standard',
  explorer: 'Explorer open',
  games: 'Files first',
  focus: 'Board only',
};

/** The chrome's own patch (lila's board uses lila's patch; both are snabbdom 3.5.1). */
export const patch = init([classModule, attributesModule, propsModule, eventListenersModule, styleModule]);

/** `data-icon` attribute for a licon glyph. */
export const dataIcon = (icon: string): { 'data-icon': string } => ({ 'data-icon': icon });

/** A button. `sel` may add classes (`button.button.button-empty`). */
export function button(
  sel: string,
  opts: { icon?: string; title?: string; disabled?: boolean; onClick: (e: MouseEvent) => void; attrs?: Record<string, string | boolean> },
  children?: VNodeChildren,
): VNode {
  const data: VNodeData = {
    attrs: {
      type: 'button',
      ...(opts.icon ? dataIcon(opts.icon) : {}),
      ...(opts.title ? { title: opts.title, 'aria-label': opts.title } : {}),
      ...(opts.disabled ? { disabled: true } : {}),
      ...opts.attrs,
    },
    on: { click: opts.onClick },
  };
  return h(sel.startsWith('button') ? sel : `button${sel}`, data, children);
}

/** `12. e4` / `12... e5` / `Initial position`, like lila's `nodeFullName`. */
export function moveName(node: { ply: number; san?: string }): string {
  if (!node.san) return 'Initial position';
  const turn = Math.floor((node.ply + 1) / 2);
  return `${turn}${node.ply % 2 === 1 ? '.' : '...'} ${node.san}`;
}

/** Relative time for file lists ("3 days ago"), via lila's timeago catalog. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  const t = window.i18n.timeago;
  if (s < 60) return t.rightNow;
  if (s < 3600) return t.nbMinutesAgo(Math.floor(s / 60));
  if (s < 86400) return t.nbHoursAgo(Math.floor(s / 3600));
  if (s < 86400 * 30) return t.nbDaysAgo(Math.floor(s / 86400));
  if (s < 86400 * 365) return t.nbMonthsAgo(Math.floor(s / (86400 * 30)));
  return t.nbYearsAgo(Math.floor(s / (86400 * 365)));
}
