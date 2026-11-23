/**
 * The Studio bar above the board: board tabs (each holds one game or a whole My Files file;
 * switching tabs swaps lila's game with `changePgn`-style reloads, PLAN §8.4) and the actions —
 * save to My Files, the file menu and the settings.
 */
import { STUDIO_LAYOUTS } from '@outpost/shared/api';
import { licon } from '../../lichess/licon.ts';
import { paths } from '../../app/paths.ts';
import type { StudioCtrl } from '../ctrl.ts';
import type { StudioTab } from '../tabs.ts';
import { askSaveAs, importDialog, renameTabDialog, settingsDialog } from './dialogs.ts';
import { button, dataIcon, h, LAYOUT_LABELS, type VNode } from './util.ts';


const tabIcon = (tab: StudioTab): string =>
  tab.source.kind === 'file'
    ? tab.source.fileKind === 'repertoire'
      ? licon.Book
      : licon.StudyBoard
    : tab.source.kind === 'game'
      ? licon.Swords
      : licon.Microscope;

function renderTab(ctrl: StudioCtrl, tab: StudioTab): VNode {
  const active = tab.id === ctrl.activeTab?.id;
  const dirty = ctrl.isTabDirty(tab);
  const title = tab.games.length > 1 ? `${tab.title} (${tab.current + 1}/${tab.games.length})` : tab.title;
  return h(
    'div.studio-tab',
    {
      key: tab.id,
      class: { active, dirty },
      attrs: { role: 'presentation' },
      hook: active ? { insert: v => scrollIntoView(v.elm), update: (_, v) => scrollIntoView(v.elm) } : undefined,
    },
    [
      h(
        'button.studio-tab__title',
        {
          attrs: {
            type: 'button',
            role: 'tab',
            'aria-selected': active ? 'true' : 'false',
            title: dirty ? `${tab.title} (unsaved changes)` : tab.title,
            ...dataIcon(tabIcon(tab)),
          },
          on: {
            click: () => ctrl.switchTo(tab.id),
            auxclick: (e: MouseEvent) => {
              if (e.button === 1) void ctrl.closeTab(tab.id);
            },
            dblclick: () => void renameTabDialog(ctrl, tab),
          },
        },
        [h('span', title), dirty ? h('i.studio-tab__dirty', { attrs: { 'aria-hidden': 'true' } }) : null],
      ),
      button('.studio-tab__close', {
        icon: licon.X,
        title: `Close ${tab.title}`,
        onClick: () => void ctrl.closeTab(tab.id),
      }),
    ],
  );
}

function scrollIntoView(elm: Node | undefined): void {
  if (elm instanceof HTMLElement) requestAnimationFrame(() => elm.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

/** One entry of the file menu. */
function menuItem(icon: string, label: string, onClick: () => void, opts: { disabled?: boolean; hint?: string; active?: boolean } = {}): VNode {
  return h(
    'button.studio-menu__item',
    {
      class: { active: !!opts.active },
      attrs: { type: 'button', role: 'menuitem', ...dataIcon(icon), ...(opts.disabled ? { disabled: true } : {}) },
      on: { click: onClick },
    },
    [h('span', label), opts.hint ? h('kbd', opts.hint) : null],
  );
}

function renderMenu(ctrl: StudioCtrl): VNode {
  const tab = ctrl.activeTab;
  const close = (fn: () => void) => () => {
    ctrl.menu = null;
    ctrl.redraw();
    fn();
  };
  const saveAs = close(() => void ctrl.saveAs(() => askSaveAs(ctrl)));
  return h('div.studio-menu', { attrs: { role: 'menu' } }, [
    menuItem(licon.PlusButton, 'New board', close(() => ctrl.newTab())),
    menuItem(licon.InkQuill, 'Open PGN or FEN…', close(() => void importDialog(ctrl))),
    h('hr'),
    menuItem(licon.UploadCloud, 'Save to My Files', close(() => void ctrl.save(() => askSaveAs(ctrl))), {
      hint: 'Ctrl+S',
      disabled: !tab || ctrl.isSaving(tab),
    }),
    menuItem(licon.UploadCloud, 'Save as…', saveAs, { disabled: !tab }),
    menuItem(licon.Pencil, 'Rename tab…', close(() => tab && void renameTabDialog(ctrl, tab)), { disabled: !tab }),
    menuItem(licon.Download, 'Download PGN', close(() => ctrl.downloadPgn()), { disabled: !tab }),
    menuItem(licon.Clipboard, 'Copy PGN', close(() => void ctrl.copyPgn()), { disabled: !tab }),
    h('hr'),
    h('div.studio-menu__title', 'Layout'),
    ...STUDIO_LAYOUTS.map(l =>
      menuItem(licon.ScreenDesktop, LAYOUT_LABELS[l], close(() => void ctrl.setPref('studioLayout', l)), {
        active: ctrl.prefs.studioLayout === l,
      }),
    ),
    h('hr'),
    menuItem(licon.Gear, 'Board and theme…', close(() => void settingsDialog(ctrl))),
    h('a.studio-menu__item', { attrs: { href: paths.home, role: 'menuitem', ...dataIcon(licon.Back) } }, [
      h('span', 'Back to Outpost'),
    ]),
  ]);
}

export function renderBar(ctrl: StudioCtrl): VNode {
  const tab = ctrl.activeTab;
  const saving = !!tab && ctrl.isSaving(tab);
  const canSave = !!tab && !saving && (tab.source.kind !== 'file' || ctrl.isTabDirty(tab));
  return h('div#studio-bar.studio-bar', [
    h('div.studio-tabs', { attrs: { role: 'tablist', 'aria-label': 'Boards' } }, [
      ...ctrl.tabs.tabs.map(t => renderTab(ctrl, t)),
      button('.studio-tab-new', { icon: licon.PlusButton, title: 'New board', onClick: () => ctrl.newTab() }),
    ]),
    h('div.studio-actions', [
      button('.studio-action.studio-action--save', {
        icon: licon.UploadCloud,
        title: saving
          ? 'Saving…'
          : tab?.source.kind === 'file'
            ? `Save “${tab.source.name}” (Ctrl+S)`
            : 'Save to My Files (Ctrl+S)',
        disabled: !canSave,
        attrs: saving ? { 'aria-busy': 'true' } : undefined,
        onClick: () => void ctrl.save(() => askSaveAs(ctrl)),
      }),
      h('div.studio-menu-wrap', { class: { shown: ctrl.menu === 'file' } }, [
        button('.studio-action', {
          icon: licon.Hamburger,
          title: 'File and layout',
          attrs: { 'aria-haspopup': 'menu', 'aria-expanded': ctrl.menu === 'file' ? 'true' : 'false' },
          onClick: e => {
            e.stopPropagation();
            ctrl.menu = ctrl.menu === 'file' ? null : 'file';
            ctrl.redraw();
          },
        }),
        ctrl.menu === 'file' ? renderMenu(ctrl) : null,
      ]),
      button('.studio-action', { icon: licon.Gear, title: 'Board and theme', onClick: () => void settingsDialog(ctrl) }),
    ]),
  ]);
}
