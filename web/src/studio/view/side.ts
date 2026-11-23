/**
 * The Studio side panel, rendered into lila's `aside.analyse__side` (passed as `opts.$side`, so it
 * sits where lila puts its own side column: left of the board on wide screens, under the moves on
 * narrow ones). Three views:
 *   - My Files (PLAN §8.4): folders, open, rename/move, delete to the recycle bin, restore/purge,
 *     and "this position in My Files" (`/api/files/search`);
 *   - Annotate: glyphs and a comment on the current move, in lila's study panel markup;
 *   - Games: the games of a multi-game file.
 */
import type { StudioFileMeta } from '@outpost/shared/api';
import { licon } from '../../lichess/licon.ts';
import type { StudioCtrl } from '../ctrl.ts';
import type { FolderNode } from '../fileTree.ts';
import { gameTitle, GLYPH_GROUPS, pgnHeaders } from '../pgn.ts';
import { glyphOfNag } from 'lila/analyse/pgnImport';
import { addFolderDialog, moveFileDialog } from './dialogs.ts';
import { ago, button, dataIcon, h, moveName, type VNode } from './util.ts';

export type SidePanel = 'files' | 'annotate' | 'games';

const spinner = (): VNode => h('div.studio-spinner', { attrs: { role: 'status', 'aria-label': 'Loading' } });

function panelTabs(ctrl: StudioCtrl): VNode {
  const tab = ctrl.activeTab;
  const games = tab?.games.length ?? 1;
  const item = (key: SidePanel, label: string, icon: string, count?: number) =>
    h(
      'button.studio-side__tab',
      {
        class: { active: ctrl.sidePanel === key },
        attrs: { type: 'button', role: 'tab', 'aria-selected': ctrl.sidePanel === key ? 'true' : 'false', ...dataIcon(icon) },
        on: {
          click: () => {
            ctrl.sidePanel = key;
            if (key === 'files' && ctrl.files.status === 'signedOut' && ctrl.signedIn) void ctrl.refreshFiles();
            ctrl.redraw();
          },
        },
      },
      [label, count !== undefined ? h('em', String(count)) : null],
    );
  return h('nav.studio-side__tabs', { attrs: { role: 'tablist' } }, [
    item('files', 'My Files', licon.StudyBoard),
    item('annotate', 'Annotate', licon.Pencil),
    games > 1 || tab?.source.kind === 'file' ? item('games', 'Games', licon.List, games) : null,
  ]);
}

// ---------------------------------------------------------------------------
// My Files
// ---------------------------------------------------------------------------

function fileRow(ctrl: StudioCtrl, file: StudioFileMeta): VNode {
  const open = ctrl.tabs.tabs.some(t => t.source.kind === 'file' && t.source.fileId === file.id);
  const active = ctrl.activeTab?.source.kind === 'file' && ctrl.activeTab.source.fileId === file.id;
  return h('li.studio-file', { key: `f${file.id}`, class: { open, active } }, [
    h(
      'button.studio-file__open',
      {
        attrs: {
          type: 'button',
          title: `${file.name} — ${file.kind}${file.color ? ` (${file.color})` : ''}, saved ${ago(file.updatedAt)}`,
          ...dataIcon(file.kind === 'repertoire' ? licon.Book : licon.StudyBoard),
        },
        on: { click: () => void ctrl.openFile(file.id) },
      },
      [
        h('span.studio-file__name', file.name),
        file.kind === 'repertoire' && file.color ? h(`i.studio-color.${file.color}`, { attrs: { title: `Repertoire for ${file.color}` } }) : null,
      ],
    ),
    h('span.studio-file__actions', [
      button('.studio-icon-btn', { icon: licon.Pencil, title: `Rename or move ${file.name}`, onClick: () => void moveFileDialog(ctrl, file) }),
      button('.studio-icon-btn', { icon: licon.Trash, title: `Move ${file.name} to the recycle bin`, onClick: () => void ctrl.deleteFile(file) }),
    ]),
  ]);
}

function folderView(ctrl: StudioCtrl, node: FolderNode, depth: number): VNode {
  const expanded = node.path === '' || ctrl.files.expanded.has(node.path);
  const children = expanded
    ? h('ul', [...node.folders.map(f => folderView(ctrl, f, depth + 1)), ...node.files.map(f => fileRow(ctrl, f))])
    : null;
  if (node.path === '') return h('div.studio-tree', { attrs: { role: 'tree' } }, [children]);
  return h('li.studio-folder', { key: `d${node.path}`, class: { expanded, selected: ctrl.files.selectedFolder === node.path } }, [
    h(
      'button.studio-folder__toggle',
      {
        attrs: {
          type: 'button',
          'aria-expanded': expanded ? 'true' : 'false',
          ...dataIcon(expanded ? licon.DownTriangle : licon.PlayTriangle),
        },
        on: { click: () => ctrl.toggleFolder(node.path) },
      },
      [h('span.studio-folder__name', node.name), h('em', String(node.total))],
    ),
    h('span.studio-file__actions', [
      button('.studio-icon-btn', { icon: licon.PlusButton, title: `New folder in ${node.name}`, onClick: () => void addFolderDialog(ctrl, node.path) }),
    ]),
    children,
  ]);
}

function trashView(ctrl: StudioCtrl): VNode {
  const trash = ctrl.files.trash;
  return h('div.studio-trash', [
    h('div.studio-files__head', [
      button('.studio-link.text', { icon: licon.Back, onClick: () => ctrl.setFilesView('files') }, 'My Files'),
      h('strong', 'Recycle bin'),
    ]),
    trash === null
      ? spinner()
      : trash.length === 0
        ? h('p.studio-empty', 'The recycle bin is empty.')
        : h(
            'ul.studio-list',
            trash.map(f =>
              h('li.studio-file', { key: `t${f.id}` }, [
                h('span.studio-file__open', { attrs: dataIcon(licon.Trash) }, [
                  h('span.studio-file__name', f.folder ? `${f.folder}/${f.name}` : f.name),
                  f.deletedAt ? h('time', ago(f.deletedAt)) : null,
                ]),
                h('span.studio-file__actions.shown', [
                  button('.studio-icon-btn', { icon: licon.Reload, title: `Restore ${f.name}`, onClick: () => void ctrl.restoreFile(f) }),
                  button('.studio-icon-btn.bad', { icon: licon.X, title: `Delete ${f.name} for good`, onClick: () => void ctrl.purgeFile(f) }),
                ]),
              ]),
            ),
          ),
  ]);
}

function searchView(ctrl: StudioCtrl): VNode {
  const s = ctrl.files.search;
  const current = ctrl.analyse?.node.fen;
  const stale = !!s && !!current && s.fen !== current;
  return h('div.studio-search', [
    h('div.studio-files__head', [
      button('.studio-link.text', { icon: licon.Back, onClick: () => ctrl.setFilesView('files') }, 'My Files'),
      h('strong', 'This position in My Files'),
    ]),
    stale ? button('.button.button-empty.text.studio-search__again', { icon: licon.Search, onClick: () => void ctrl.searchPosition() }, 'Search the position on the board') : null,
    !s || s.status === 'loading'
      ? spinner()
      : s.status === 'error'
        ? h('p.studio-error', s.error ?? 'Search failed.')
        : !s.result?.hits.length
          ? h('p.studio-empty', 'No file reaches this position.')
          : h(
              'ul.studio-list',
              s.result.hits.map(hit =>
                h('li.studio-hit', { key: `s${hit.file.id}` }, [
                  h('div.studio-hit__file', { attrs: dataIcon(hit.file.kind === 'repertoire' ? licon.Book : licon.StudyBoard) }, hit.file.folder ? `${hit.file.folder}/${hit.file.name}` : hit.file.name),
                  h(
                    'div.studio-hit__matches',
                    hit.matches.slice(0, 8).map(m =>
                      button(
                        '.studio-hit__match',
                        {
                          title: 'Open the file at this position',
                          onClick: () => void ctrl.openFile(hit.file.id, { gameIndex: m.gameIndex, ply: m.ply }),
                        },
                        [
                          hit.matches.length > 1 || m.gameIndex > 0 ? `Game ${m.gameIndex + 1}, ` : '',
                          m.ply === 0 ? 'start' : `move ${Math.ceil(m.ply / 2)}`,
                          m.nextSan ? h('span.studio-hit__next', [' → ', h('san', m.nextSan)]) : null,
                        ],
                      ),
                    ),
                  ),
                ]),
              ),
            ),
  ]);
}

function filesView(ctrl: StudioCtrl): VNode {
  const f = ctrl.files;
  if (!ctrl.signedIn)
    return h('div.studio-files.studio-files--signed-out', [
      h('p', 'Sign in to keep your analysis, repertoires and imported games in My Files, on every device.'),
      h('a.button', { attrs: { href: ctrl.loginUrl() } }, i18n.site.signIn),
    ]);
  if (f.view === 'trash') return trashView(ctrl);
  if (f.view === 'search') return searchView(ctrl);
  const tools = h('div.studio-files__tools', [
    button('.studio-icon-btn', { icon: licon.PlusButton, title: 'New folder', onClick: () => void addFolderDialog(ctrl, f.selectedFolder) }),
    button('.studio-icon-btn', { icon: licon.Search, title: 'Find this position in My Files', onClick: () => ctrl.setFilesView('search') }),
    button('.studio-icon-btn', { icon: licon.Reload, title: 'Refresh', onClick: () => void ctrl.refreshFiles() }),
    button('.studio-icon-btn.studio-trash-btn', { icon: licon.Trash, title: 'Recycle bin', onClick: () => ctrl.setFilesView('trash') }, f.trashCount ? h('em', String(f.trashCount)) : null),
  ]);
  if (f.status === 'loading' || f.status === 'signedOut') return h('div.studio-files', [tools, spinner()]);
  if (f.status === 'error')
    return h('div.studio-files', [
      tools,
      h('p.studio-error', `My Files could not be loaded: ${f.error ?? 'unknown error'}`),
      button('.button.button-empty', { onClick: () => void ctrl.refreshFiles() }, 'Try again'),
    ]);
  const tree = ctrl.folderTree();
  return h('div.studio-files', [
    tools,
    tree.total === 0 && tree.folders.length === 0
      ? h('p.studio-empty', 'No files yet. Save a board to start your library.')
      : folderView(ctrl, tree, 0),
  ]);
}

// ---------------------------------------------------------------------------
// Annotate (lila's study glyph and comment panels)
// ---------------------------------------------------------------------------

function annotateView(ctrl: StudioCtrl): VNode {
  const node = ctrl.node;
  if (!node) return spinner();
  const isMove = !!node.san;
  const path = ctrl.analyse?.path ?? '';
  return h('div.studio-annotate', [
    h('div.studio-annotate__move', [
      h('strong', moveName(node)),
      !ctrl.signedIn && ctrl.activeTab?.source.kind !== 'file'
        ? h('span.studio-annotate__hint', 'Annotations are saved with the board.')
        : null,
    ]),
    h('div.study__comments', [
      h('form.form3', { on: { submit: (e: Event) => e.preventDefault() } }, [
        h('label.form-label', { attrs: { for: 'studio-comment' } }, isMove ? 'Comment on this move' : 'Comment on the position'),
        h('textarea#studio-comment.form-control', {
          key: 'comment',
          attrs: { rows: 5, spellcheck: 'true', placeholder: 'Plans, ideas, sources…' },
          hook: {
            insert: v => {
              const el = v.elm as HTMLTextAreaElement;
              el.value = ctrl.commentText();
              (v.data as { path?: string }).path = path;
              let timer: ReturnType<typeof setTimeout> | undefined;
              el.addEventListener('input', () => {
                clearTimeout(timer);
                const at = ctrl.analyse?.path;
                timer = setTimeout(() => {
                  if (ctrl.analyse?.path === at) ctrl.setComment(el.value);
                }, 250);
              });
              el.addEventListener('keydown', e => {
                if (e.key === 'Escape') el.blur();
              });
            },
            postpatch: (old, v) => {
              const el = v.elm as HTMLTextAreaElement;
              const prev = (old.data as { path?: string }).path;
              if (prev !== path || document.activeElement !== el) el.value = ctrl.commentText();
              (v.data as { path?: string }).path = path;
            },
          },
        }),
      ]),
    ]),
    isMove
      ? h(
          'div.study__glyphs',
          GLYPH_GROUPS.map(group =>
            h(
              `div.${group.name}`,
              group.ids.map(id => {
                const glyph = glyphOfNag(id);
                if (!glyph) return null;
                return h(
                  'button',
                  {
                    key: `g${id}`,
                    class: { active: ctrl.hasGlyph(id) },
                    attrs: { type: 'button', 'data-symbol': glyph.symbol, title: glyph.name },
                    on: { click: () => ctrl.toggleGlyph(id) },
                  },
                  glyph.name.charAt(0).toUpperCase() + glyph.name.slice(1),
                );
              }),
            ),
          ),
        )
      : h('p.studio-empty', 'Play or select a move to add glyphs (!, ?, ±, …) to it.'),
  ]);
}

// ---------------------------------------------------------------------------
// Games of a multi-game file
// ---------------------------------------------------------------------------

function gamesView(ctrl: StudioCtrl): VNode {
  const tab = ctrl.activeTab;
  if (!tab) return spinner();
  return h('div.studio-games', [
    h(
      'ol.studio-list',
      tab.games.map((pgn, i) => {
        const headers = pgnHeaders(pgn);
        const result = headers.find(([k]) => k === 'Result')?.[1];
        return h('li', { key: `g${i}`, class: { active: i === tab.current } }, [
          button(
            '.studio-game',
            { onClick: () => ctrl.selectGame(i), title: `Show game ${i + 1}` },
            [h('span', gameTitle(headers, `Game ${i + 1}`)), result && result !== '*' ? h('em', result) : null],
          ),
        ]);
      }),
    ),
    button('.button.button-empty.text.studio-games__add', { icon: licon.PlusButton, onClick: () => ctrl.addGame() }, 'Add a game'),
  ]);
}

export function renderSide(ctrl: StudioCtrl): VNode {
  const tab = ctrl.activeTab;
  if (ctrl.sidePanel === 'games' && (tab?.games.length ?? 1) < 2 && tab?.source.kind !== 'file') ctrl.sidePanel = 'files';
  return h('aside.analyse__side.studio-side', [
    panelTabs(ctrl),
    h(
      'div.studio-side__body',
      ctrl.sidePanel === 'annotate' ? annotateView(ctrl) : ctrl.sidePanel === 'games' ? gamesView(ctrl) : filesView(ctrl),
    ),
  ]);
}
