/**
 * The analysis board's keyboard help ("?"), which lichess renders on its server (`/analysis/help`).
 * Same markup and strings as lila's template (lib/css/component/_help.scss styles it), listing the
 * shortcuts bound in web/vendor/lila/analyse/src/keyboard.ts. Opened through the `outpost` hook
 * (scripts/lila-patches/001).
 */
type Row = readonly [keys: string, desc: string];

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const k = (key: string): string => `<kbd>${esc(key)}</kbd>`;
const or = '<or>/</or>';
const plus = (...keys: string[]): string => keys.map(k).join(' + ');

const header = (title: string): string => `<tr class="header"><th colspan="2"><p>${esc(title)}</p></th></tr>`;
const rows = (list: readonly Row[]): string =>
  list.map(([keys, desc]) => `<tr><td class="keys">${keys}</td><td class="desc">${esc(desc)}</td></tr>`).join('');

/** Lowercase first letter of an i18n label used mid-sentence is left to CSS (`.desc::first-letter`). */
export function keyboardHelpHtml(t: I18n = i18n): string {
  const s = t.site;
  const navigation: Row[] = [
    [`${k('←')} ${or} ${k('→')}`, s.keyMoveBackwardOrForward],
    [`${k('k')} ${or} ${k('j')}`, s.keyMoveBackwardOrForward],
    [`${k('↑')} ${or} ${k('↓')}`, s.keyGoToStartOrEnd],
    [`${k('0')} ${or} ${k('$')}`, s.keyGoToStartOrEnd],
    [`${k('home')} ${or} ${k('end')}`, s.keyGoToStartOrEnd],
    [`${plus('shift', '←')} ${or} ${plus('shift', '→')}`, s.keyEnterOrExitVariation],
    [`${plus('shift', '↑')} ${or} ${plus('shift', '↓')}`, s.keyGoToPreviousOrNextLine],
    [`${plus('shift', 'k')} ${or} ${plus('shift', 'j')}`, `${s.keyPreviousBranch} / ${s.keyNextBranch}`],
    [k('shift'), s.keyCycleSelectedVariation],
    [k('ctrl'), s.keyShowOrHideCurrentVariation],
    [plus('shift', 'c'), s.keyShowOrHideComments],
    [k('?'), s.showHelpDialog],
  ];
  const analysis: Row[] = [
    [k('f'), s.flipBoard],
    [plus('shift', 'i'), t.preferences.inlineNotation],
    [k('l'), s.toggleLocalEngine],
    [k('space'), s.playComputerMove],
    [k('x'), s.showThreat],
    [k('z'), s.toggleAllAnalysis],
    [k('a'), s.bestMoveArrow],
    [k('v'), s.toggleVariationArrows],
    [k('e'), s.openingEndgameExplorer],
    [plus('shift', 'space'), s.playFirstOpeningEndgameExplorerMove],
    [k('h'), s.menu],
  ];
  const brushes: Row[] = [
    [plus('right click'), 'green'],
    [plus('shift', 'right click'), 'red'],
    [plus('alt', 'right click'), 'blue'],
    [plus('shift', 'alt', 'right click'), 'yellow'],
  ];
  return [
    `<h2>${esc(s.keyboardShortcuts)}</h2>`,
    '<table><tbody>',
    header(s.moveListNavigation),
    rows(navigation),
    header(s.analysisOptions),
    rows(analysis),
    header(s.mouseTricks),
    `<tr><td class="mouse" colspan="2"><ul>`,
    `<li>${esc(s.youCanAlsoScrollOverTheBoardToMoveInTheGame)}</li>`,
    `<li>${esc(s.scrollOverComputerVariationsToPreviewThem)}</li>`,
    `<li>${esc(s.analysisShapesHowTo)}</li>`,
    '</ul></td></tr>',
    rows(brushes),
    '</tbody></table>',
  ].join('');
}
