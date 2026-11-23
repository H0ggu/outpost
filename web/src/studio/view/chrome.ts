/**
 * Mounts the Outpost chrome around lila's board (PLAN §8.4): the site header (`#top`), the Studio bar
 * (board tabs and actions, above `main.analyse`) and the side panel inside lila's grid. Each is its
 * own snabbdom tree, redrawn together (at most once per frame) by `ctrl.redraw()`.
 *
 * Global keys: Ctrl/⌘+S saves the active tab; Escape closes the file menu. Leaving the page asks first
 * when a board has unsaved changes: the tabs survive a reload, but not closing the browser tab, and
 * the page can't tell the two apart.
 */
import type { StudioCtrl } from '../ctrl.ts';
import { renderBar } from './bar.ts';
import { askSaveAs } from './dialogs.ts';
import { renderHeader } from './header.ts';
import { renderSide } from './side.ts';
import { patch, type VNode } from './util.ts';

export interface ChromeElements {
  /** `header#top` (absent in the embed). */
  top: HTMLElement | null;
  /** Placeholder for the Studio bar, before `main.analyse` (absent in the embed). */
  bar: HTMLElement | null;
  /** lila's side column (`opts.$side`; absent in the embed). */
  side: HTMLElement | null;
}

export function mountChrome(ctrl: StudioCtrl, els: ChromeElements): void {
  let top: VNode | Element | null = els.top;
  let bar: VNode | Element | null = els.bar;
  let side: VNode | Element | null = els.side;
  let frame = 0;

  const render = (): void => {
    frame = 0;
    if (top) top = patch(top, renderHeader(ctrl));
    if (bar) bar = patch(bar, renderBar(ctrl));
    if (side) side = patch(side, renderSide(ctrl));
  };
  ctrl.redraw = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  render();

  if (!els.bar) return; // embed: no tabs, no saving

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault(); // never the browser's "save page"
      if (!document.querySelector('dialog:modal')) void ctrl.save(() => askSaveAs(ctrl));
    } else if (e.key === 'Escape' && ctrl.menu) {
      ctrl.menu = null;
      ctrl.redraw();
    }
  });
  document.addEventListener('click', e => {
    if (ctrl.menu && !(e.target instanceof Element && e.target.closest('.studio-menu'))) {
      ctrl.menu = null;
      ctrl.redraw();
    }
  });
  window.addEventListener('beforeunload', e => {
    if (ctrl.hasUnkeptWork()) e.preventDefault();
  });
}
