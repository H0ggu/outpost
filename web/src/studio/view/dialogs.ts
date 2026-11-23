/**
 * Studio dialogs, built on lila's own dialog (`lib/view` snabDialog/prompt, bits.dialog CSS) with
 * lila's form markup (`form3`), so they look like lichess's: save as, open PGN/FEN, rename tab,
 * rename/move a file, new folder, and the look settings (theme, board, pieces, sounds, layout).
 */
import {
  BOARD_THEMES,
  PIECE_SETS,
  SOUND_SETS,
  STUDIO_LAYOUTS,
  type Color,
  type FileKind,
  type SoundSet,
  type StudioFileMeta,
  type ThemeName,
} from '@outpost/shared/api';
import { BOARD_FILES, boardThumbnailUrl, pieceUrl, playSound } from '../../lichess/assets.ts';
import { licon } from '../../lichess/licon.ts';
import { prompt, snabDialog, type Dialog } from 'lila/lib/view';
import type { SaveAsInput, StudioCtrl } from '../ctrl.ts';
import { allFolderPaths, normalizeFolder, uniqueFileName } from '../fileTree.ts';
import type { StudioTab } from '../tabs.ts';
import { dataIcon, h, LAYOUT_LABELS, type VNode } from './util.ts';

const MAX_NAME = 120;

/** A usable file name: trimmed, 1–120 characters, no slashes or control characters. */
export const validFileName = (s: string): boolean => {
  const t = s.trim();
  return t.length > 0 && t.length <= MAX_NAME && !/[/\\\u0000-\u001f\u007f]/.test(t);
};

const folderLabel = (path: string): string => (path === '' ? 'My Files (top level)' : path.split('/').join(' / '));

const NEW_FOLDER = '\u0000new';

function folderField(
  ctrl: StudioCtrl,
  state: { folder: string; newFolder: string },
  redraw: () => void,
): VNode[] {
  const folders = [...new Set([...allFolderPaths(ctrl.folderTree()), state.folder].filter(f => f !== NEW_FOLDER))];
  return [
    h('div.form-group', [
      h('label.form-label', { attrs: { for: 'studio-folder' } }, 'Folder'),
      h(
        'select#studio-folder.form-control',
        {
          on: {
            change: (e: Event) => {
              state.folder = (e.target as HTMLSelectElement).value;
              redraw();
            },
          },
        },
        [
          ...folders.map(f => h('option', { attrs: { value: f }, props: { selected: f === state.folder } }, folderLabel(f))),
          h('option', { attrs: { value: NEW_FOLDER }, props: { selected: state.folder === NEW_FOLDER } }, 'New folder…'),
        ],
      ),
    ]),
    state.folder === NEW_FOLDER
      ? h('div.form-group', [
          h('label.form-label', { attrs: { for: 'studio-new-folder' } }, 'New folder (use / for subfolders)'),
          h('input#studio-new-folder.form-control', {
            attrs: { type: 'text', maxlength: 200, placeholder: 'Openings/White' },
            props: { value: state.newFolder },
            on: { input: (e: Event) => (state.newFolder = (e.target as HTMLInputElement).value) },
          }),
        ])
      : null,
  ].filter((v): v is VNode => v !== null);
}

const chosenFolder = (state: { folder: string; newFolder: string }): string | null =>
  state.folder === NEW_FOLDER ? normalizeFolder(state.newFolder) : state.folder;

/** Asks for the name, folder and kind of a new file. Resolves null on cancel. */
export function askSaveAs(ctrl: StudioCtrl): Promise<SaveAsInput | null> {
  const tab = ctrl.activeTab;
  const folder = tab?.source.kind === 'file' ? tab.source.folder : ctrl.files.selectedFolder;
  const baseName = tab?.source.kind === 'file' ? `${tab.source.name} (copy)` : (tab?.title ?? 'Untitled');
  const state = {
    name: uniqueFileName(baseName.slice(0, MAX_NAME), folder, ctrl.files.list),
    folder,
    newFolder: '',
    kind: (tab?.source.kind === 'file' ? tab.source.fileKind : 'study') as FileKind,
    color: (tab?.source.kind === 'file' && tab.source.color ? tab.source.color : (ctrl.analyse?.bottomColor() ?? 'white')) as Color,
    error: '',
  };
  return new Promise(resolve => {
    let result: SaveAsInput | null = null;
    const submit = (dlg: Dialog, redraw: () => void) => {
      const folderPath = chosenFolder(state);
      if (!validFileName(state.name)) state.error = 'Give the file a name (no slashes).';
      else if (folderPath === null || (state.folder === NEW_FOLDER && !folderPath)) state.error = 'That folder name is not valid.';
      else {
        result = { name: state.name.trim(), folder: folderPath, kind: state.kind, color: state.kind === 'repertoire' ? state.color : null };
        dlg.close('ok');
        return;
      }
      redraw();
    };
    void snabDialog({
      class: 'studio-dialog',
      modal: true,
      show: true,
      closeButton: true,
      focus: '#studio-file-name',
      onClose: () => resolve(result),
      render: (redraw, dlg) => [
        h('h2', 'Save to My Files'),
        h(
          'form.form3',
          {
            on: {
              submit: (e: Event) => {
                e.preventDefault();
                submit(dlg, redraw);
              },
            },
          },
          [
            h('div.form-group', [
              h('label.form-label', { attrs: { for: 'studio-file-name' } }, 'Name'),
              h('input#studio-file-name.form-control', {
                attrs: { type: 'text', maxlength: MAX_NAME, required: true, autocomplete: 'off' },
                props: { value: state.name },
                on: { input: (e: Event) => (state.name = (e.target as HTMLInputElement).value) },
              }),
            ]),
            ...folderField(ctrl, state, redraw),
            h('div.form-group.studio-kind', [
              h('span.form-label', 'Kind'),
              h('div.studio-choices', [
                ...(['study', 'repertoire'] as const).map(kind =>
                  h('label', [
                    h('input', {
                      attrs: { type: 'radio', name: 'studio-kind', value: kind },
                      props: { checked: state.kind === kind },
                      on: {
                        change: () => {
                          state.kind = kind;
                          redraw();
                        },
                      },
                    }),
                    kind === 'study' ? ' Study' : ' Repertoire',
                  ]),
                ),
              ]),
            ]),
            state.kind === 'repertoire'
              ? h('div.form-group.studio-kind', [
                  h('span.form-label', 'Repertoire for'),
                  h('div.studio-choices', [
                    ...(['white', 'black'] as const).map(color =>
                      h('label', [
                        h('input', {
                          attrs: { type: 'radio', name: 'studio-color', value: color },
                          props: { checked: state.color === color },
                          on: {
                            change: () => {
                              state.color = color;
                              redraw();
                            },
                          },
                        }),
                        color === 'white' ? ' White' : ' Black',
                      ]),
                    ),
                  ]),
                ])
              : null,
            state.error ? h('p.error', state.error) : null,
            h('div.form-actions', [
              h('button.button.button-empty.cancel', { attrs: { type: 'button' }, on: { click: () => dlg.close('cancel') } }, i18n.site.cancel),
              h('button.button.text', { attrs: { type: 'submit', ...dataIcon(licon.UploadCloud) } }, 'Save'),
            ]),
          ],
        ),
      ],
    });
  });
}

/** Opens PGN (one or several games) or a FEN, pasted or from a `.pgn` file, in a new tab. */
export async function importDialog(ctrl: StudioCtrl): Promise<void> {
  const state = { text: '', name: '', error: '' };
  await snabDialog({
    class: 'studio-dialog',
    modal: true,
    show: true,
    closeButton: true,
    focus: 'textarea',
    render: (redraw, dlg) => {
      const open = () => {
        const error = ctrl.importText(state.text, state.name || undefined);
        if (error) {
          state.error = error;
          redraw();
        } else dlg.close('ok');
      };
      return [
        h('h2', 'Open PGN or FEN'),
        h(
          'form.form3',
          {
            on: {
              submit: (e: Event) => {
                e.preventDefault();
                open();
              },
            },
          },
          [
            h('div.form-group', [
              h('label.form-label', { attrs: { for: 'studio-import' } }, 'Paste a PGN (one or more games) or a FEN'),
              h('textarea#studio-import.form-control.copyable', {
                attrs: { rows: 8, spellcheck: 'false', placeholder: '1. e4 e5 2. Nf3 …   or   rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' },
                props: { value: state.text },
                on: { input: (e: Event) => (state.text = (e.target as HTMLTextAreaElement).value) },
              }),
            ]),
            h('div.form-group', [
              h('label.form-label', { attrs: { for: 'studio-import-file' } }, 'Or choose a .pgn file'),
              h('input#studio-import-file.form-control', {
                attrs: { type: 'file', accept: '.pgn,application/x-chess-pgn,text/plain' },
                on: {
                  change: async (e: Event) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;
                    if (file.size > 10 * 1024 * 1024) {
                      state.error = 'That file is over 10 MB: import it as a database instead.';
                      redraw();
                      return;
                    }
                    state.text = await file.text();
                    state.name = file.name.replace(/\.pgn$/i, '');
                    state.error = '';
                    redraw();
                  },
                },
              }),
            ]),
            state.error ? h('p.error', state.error) : null,
            h('div.form-actions', [
              h('button.button.button-empty.cancel', { attrs: { type: 'button' }, on: { click: () => dlg.close('cancel') } }, i18n.site.cancel),
              h('button.button', { attrs: { type: 'submit' } }, 'Open'),
            ]),
          ],
        ),
      ];
    },
  });
}

/** Renames a tab; a tab showing a file renames the file. */
export async function renameTabDialog(ctrl: StudioCtrl, tab: StudioTab): Promise<void> {
  const current = tab.source.kind === 'file' ? tab.source.name : tab.title;
  const name = await prompt(tab.source.kind === 'file' ? 'Rename the file' : 'Rename the tab', current, validFileName);
  if (name === null || name.trim() === current) return;
  await ctrl.renameTab(tab, name.trim());
}

/** Renames or moves a file. */
export async function moveFileDialog(ctrl: StudioCtrl, file: StudioFileMeta): Promise<void> {
  const state = { name: file.name, folder: file.folder, newFolder: '', error: '' };
  await snabDialog({
    class: 'studio-dialog',
    modal: true,
    show: true,
    closeButton: true,
    focus: 'input',
    render: (redraw, dlg) => {
      const submit = () => {
        const folder = chosenFolder(state);
        if (!validFileName(state.name)) state.error = 'Give the file a name (no slashes).';
        else if (folder === null || (state.folder === NEW_FOLDER && !folder)) state.error = 'That folder name is not valid.';
        else {
          dlg.close('ok');
          const change: { name?: string; folder?: string } = {};
          if (state.name.trim() !== file.name) change.name = state.name.trim();
          if (folder !== file.folder) change.folder = folder;
          if (change.name !== undefined || change.folder !== undefined) void ctrl.updateFileMeta(file, change);
          return;
        }
        redraw();
      };
      return [
        h('h2', 'Rename or move'),
        h(
          'form.form3',
          {
            on: {
              submit: (e: Event) => {
                e.preventDefault();
                submit();
              },
            },
          },
          [
            h('div.form-group', [
              h('label.form-label', { attrs: { for: 'studio-rename' } }, 'Name'),
              h('input#studio-rename.form-control', {
                attrs: { type: 'text', maxlength: MAX_NAME, required: true, autocomplete: 'off' },
                props: { value: state.name },
                on: { input: (e: Event) => (state.name = (e.target as HTMLInputElement).value) },
              }),
            ]),
            ...folderField(ctrl, state, redraw),
            state.error ? h('p.error', state.error) : null,
            h('div.form-actions', [
              h('button.button.button-empty.cancel', { attrs: { type: 'button' }, on: { click: () => dlg.close('cancel') } }, i18n.site.cancel),
              h('button.button', { attrs: { type: 'submit' } }, 'Save'),
            ]),
          ],
        ),
      ];
    },
  });
}

/** Creates a folder under `parent` (it is kept on the server once a file is saved in it). */
export async function addFolderDialog(ctrl: StudioCtrl, parent: string): Promise<void> {
  const name = await prompt(parent ? `New folder in ${folderLabel(parent)}` : 'New folder', '', s => !!normalizeFolder(s));
  if (name === null) return;
  ctrl.addFolder(parent, name);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const THEMES: ReadonlyArray<readonly [ThemeName, string, string]> = [
  ['black', 'True black', 'For OLED screens'],
  ['dark', 'Dark', 'lichess dark'],
  ['light', 'Light', 'lichess light'],
];

const SOUND_LABELS: Readonly<Record<SoundSet, string>> = { sfx: 'SFX', piano: 'Piano', nes: 'NES', silent: 'Silent' };

const PIECE_LABEL = (set: string): string => set.charAt(0).toUpperCase() + set.slice(1).replace(/-(\w)/g, (_, c: string) => ` ${c.toUpperCase()}`);

/** Theme, board, piece set, sound set and layout: saved to the account when signed in. */
export async function settingsDialog(ctrl: StudioCtrl): Promise<void> {
  await snabDialog({
    class: 'studio-dialog.studio-settings',
    modal: true,
    show: true,
    closeButton: true,
    render: redraw => {
      const set = <K extends 'theme' | 'boardTheme' | 'pieceSet' | 'soundSet' | 'studioLayout'>(key: K, value: (typeof ctrl.prefs)[K]) => {
        void ctrl.setPref(key, value).then(redraw);
        redraw();
      };
      const p = ctrl.prefs;
      return [
        h('h2', 'Board and theme'),
        h('p.studio-settings__where', ctrl.signedIn ? 'Saved to your account (also used by the rest of Outpost).' : 'Saved in this browser. Sign in to keep them on every device.'),
        h('section', [
          h('h3', 'Theme'),
          h(
            'div.studio-picker.studio-picker--themes',
            THEMES.map(([value, label, hint]) =>
              h(
                `button.studio-theme.studio-theme--${value}`,
                { class: { active: p.theme === value }, attrs: { type: 'button', 'aria-pressed': String(p.theme === value) }, on: { click: () => set('theme', value) } },
                [h('strong', label), h('span', hint)],
              ),
            ),
          ),
        ]),
        h('section', [
          h('h3', 'Board'),
          h(
            'div.studio-picker.studio-picker--boards',
            BOARD_THEMES.map(b =>
              h(
                'button.studio-swatch',
                {
                  class: { active: p.boardTheme === b },
                  attrs: { type: 'button', title: BOARD_FILES[b].label, 'aria-label': `${BOARD_FILES[b].label} board`, 'aria-pressed': String(p.boardTheme === b) },
                  on: { click: () => set('boardTheme', b) },
                },
                [h('img', { attrs: { src: boardThumbnailUrl(b), alt: '', loading: 'lazy' } })],
              ),
            ),
          ),
        ]),
        h('section', [
          h('h3', 'Pieces'),
          h(
            'div.studio-picker.studio-picker--pieces',
            PIECE_SETS.map(s =>
              h(
                'button.studio-swatch',
                {
                  class: { active: p.pieceSet === s },
                  attrs: { type: 'button', title: PIECE_LABEL(s), 'aria-label': `${PIECE_LABEL(s)} pieces`, 'aria-pressed': String(p.pieceSet === s) },
                  on: { click: () => set('pieceSet', s) },
                },
                [h('img', { attrs: { src: pieceUrl(s, 'white', 'knight'), alt: '', loading: 'lazy' } })],
              ),
            ),
          ),
        ]),
        h('section', [
          h('h3', 'Sounds'),
          h(
            'div.studio-picker.studio-picker--sounds',
            SOUND_SETS.map(s =>
              h(
                'button.button.button-empty.text',
                {
                  class: { active: p.soundSet === s },
                  attrs: { type: 'button', 'aria-pressed': String(p.soundSet === s), ...dataIcon(s === 'silent' ? licon.Mute : licon.Voice) },
                  on: {
                    click: () => {
                      set('soundSet', s);
                      playSound(s, 'Move');
                    },
                  },
                },
                SOUND_LABELS[s],
              ),
            ),
          ),
        ]),
        h('section', [
          h('h3', 'Layout'),
          h(
            'div.studio-picker.studio-picker--sounds',
            STUDIO_LAYOUTS.map(l =>
              h(
                'button.button.button-empty',
                {
                  class: { active: p.studioLayout === l },
                  attrs: { type: 'button', 'aria-pressed': String(p.studioLayout === l) },
                  on: { click: () => set('studioLayout', l) },
                },
                LAYOUT_LABELS[l],
              ),
            ),
          ),
        ]),
      ];
    },
  });
}
