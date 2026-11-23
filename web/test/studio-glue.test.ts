/**
 * Studio build glue (src/studio/build/lilaGlue.ts, used by vite.config.ts): lila's bare-import
 * resolution, translation XML → window.i18n, gen/_wrap.scss and CSS asset rewriting. The last block
 * walks the real vendored tree (read as raw text through Vite's import.meta.glob) from the Studio's
 * entry points, so a lila import that no longer resolves, or an i18n key the generated catalogs
 * lack, fails here rather than in the browser.
 */
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import {
  colorWrapScss,
  i18nModuleCode,
  INLINE_IMAGES,
  lilaCandidateFiles,
  lilaCssAssetPath,
  lilaImportTarget,
  parseTranslationXml,
  rewriteLilaCssUrls,
} from '../src/studio/build/lilaGlue.ts';

describe('lilaImportTarget', () => {
  it('maps lila packages to their src folders', () => {
    expect(lilaImportTarget('lib', 'analyse/src/ctrl.ts')).toBe('lib/src/index');
    expect(lilaImportTarget('lib/ceval', 'analyse/src/ctrl.ts')).toBe('lib/src/ceval');
    expect(lilaImportTarget('lib/view/dialog', 'analyse/src/view/main.ts')).toBe('lib/src/view/dialog');
    expect(lilaImportTarget('keyboard-move', 'analyse/src/ctrl.ts')).toBe('keyboardMove/src/exports');
    expect(lilaImportTarget('editor/chess960', 'analyse/src/x.ts')).toBe('editor/src/chess960');
  });

  it('resolves @/ against the importing package', () => {
    expect(lilaImportTarget('@/ctrl', 'analyse/src/view/main.ts')).toBe('analyse/src/ctrl');
    expect(lilaImportTarget('@/device', 'lib/src/view/dialog.ts')).toBe('lib/src/device');
    expect(lilaImportTarget('@/exports', 'keyboardMove/src/keyboardMove.ts')).toBe('keyboardMove/src/exports');
  });

  it('leaves npm packages and relative paths to Vite', () => {
    expect(lilaImportTarget('snabbdom', 'analyse/src/ctrl.ts')).toBeNull();
    expect(lilaImportTarget('chessops/fen', 'analyse/src/ctrl.ts')).toBeNull();
    expect(lilaImportTarget('@lichess-org/chessground/api', 'analyse/src/ctrl.ts')).toBeNull();
    expect(lilaImportTarget('./ctrl', 'analyse/src/view/main.ts')).toBeNull();
    expect(lilaImportTarget('@/x', 'tsconfig.base.json')).toBeNull();
  });

  it('tries lila file candidates in order', () => {
    expect(lilaCandidateFiles('lib/src/ceval')).toEqual([
      'lib/src/ceval.ts',
      'lib/src/ceval.tsx',
      'lib/src/ceval/index.ts',
      'lib/src/ceval.js',
    ]);
    expect(lilaCandidateFiles('lib/src/x.ts')).toEqual(['lib/src/x.ts']);
  });
});

describe('translations', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<resources>
  <!-- a comment <string name="hidden">no</string> -->
  <string name="flipBoard">Flip board</string>
  <string name="nbGames" comment="x">%s games</string>
  <string name="quoted">It&apos;s \\"fine\\" &amp; &lt;ok&gt;</string>
  <plurals name="nbMoves">
    <item quantity="one">%s move</item>
    <item quantity="other">%s moves</item>
  </plurals>
  <string name="ordered">%1$s vs %2$s</string>
</resources>`;

  it('parses strings, plurals and entities, sorted by key', () => {
    const dict = parseTranslationXml(xml);
    expect([...dict.keys()]).toEqual(['flipBoard', 'nbGames', 'nbMoves', 'ordered', 'quoted']);
    expect(dict.get('quoted')).toBe('It\'s "fine" & <ok>');
    expect(dict.get('nbMoves')).toEqual({ one: '%s move', other: '%s moves' });
    expect(dict.has('hidden')).toBe(false);
    expect(parseTranslationXml('').size).toBe(0);
  });

  it('generates window.i18n with lila’s formatting helpers', () => {
    const code = i18nModuleCode([{ name: 'site', dict: parseTranslationXml(xml) }]);
    expect(code).toContain('export {};');
    const win: { i18n?: Record<string, any> } = {};
    new Function('window', code.replace('export {};', ''))(win);
    const t = win.i18n!;
    expect(t.site.flipBoard).toBe('Flip board');
    expect(t.site.nbGames(12)).toBe('12 games');
    expect(t.site.nbMoves(1)).toBe('1 move');
    expect(t.site.nbMoves(3)).toBe('3 moves');
    expect(t.site.ordered('A', 'B')).toBe('A vs B');
    expect(t.site.nbGames.asArray('<b>')).toEqual(['', '<b>', ' games']);
    expect(t.quantity(1)).toBe('one');
    expect(t.quantity(2)).toBe('other');
  });

  it('rejects catalog names that are not identifiers', () => {
    expect(() => i18nModuleCode([{ name: 'a.b', dict: new Map() }])).toThrow();
  });
});

describe('SCSS glue', () => {
  it('wraps every --c-* theme variable as $c-*', () => {
    const scss = colorWrapScss([
      ':root {\n  --c-bg: #000;\n  --c-font: #bbb;\n  // --c-commented: x;\n}',
      'html.light {\n  --c-bg: #fff;\n  --c-primary-dim: color-mix(in oklab, var(--c-dimmer) 15%, var(--c-primary));\n}',
    ]);
    expect(scss.trim().split('\n')).toEqual(['$c-bg: var(--c-bg);', '$c-font: var(--c-font);', '$c-primary-dim: var(--c-primary-dim);']);
  });

  it('points lila asset URLs at Outpost’s /lichess tree', () => {
    expect(lilaCssAssetPath('../font/lichess-chess.woff2')).toBe('/lichess/font/lichess-chess.woff2');
    expect(lilaCssAssetPath('../images/board/brown.png')).toBe('/lichess/board/brown.png');
    expect(lilaCssAssetPath('../piece/mono/N.svg')).toBe('/lichess/piece/cburnett/bN.svg');
    expect(lilaCssAssetPath('../piece/merida/wK.svg')).toBe('/lichess/piece/merida/wK.svg');
    expect(lilaCssAssetPath('/assets/images/whatever.png')).toBeNull();
  });

  it('rewrites shipped URLs, inlines UI images and neutralises the rest', () => {
    const css = [
      "@font-face { font-family: 'Noto Sans'; src: url('../font/noto-sans-latin.woff2') format('woff2'); }",
      "@font-face { font-family: storm; src: url('../font/storm.woff2'); }",
      "body[data-board='brown'] .is2d cg-board::before { background-image: url(../images/board/brown.png); }",
      "body[data-board='wood'] .is2d cg-board::before { background-image: url(../images/board/wood.jpg); }",
      '.disclosure { mask-image: url(/assets/images/buttons/plus-button-mask.webp); }',
      '.x { background: url("data:image/png;base64,AAAA"); }',
    ].join('\n');
    const shipped = new Set(['/lichess/font/noto-sans-latin.woff2', '/lichess/board/brown.png']);
    const { css: out, dropped } = rewriteLilaCssUrls(css, p => shipped.has(p));
    expect(out).toContain('url("/lichess/font/noto-sans-latin.woff2")');
    expect(out).not.toContain('storm');
    expect(out).toContain('url("/lichess/board/brown.png")');
    expect(out).toContain('background-image: none');
    expect(out).toContain(`url(${INLINE_IMAGES['/assets/images/buttons/plus-button-mask.webp']})`);
    expect(out).toContain('url("data:image/png;base64,AAAA")');
    expect(dropped).toEqual(['../font/storm.woff2', '../images/board/wood.jpg']);
  });
});

// ---------------------------------------------------------------------------
// The real vendored tree
// ---------------------------------------------------------------------------

const VENDOR_PREFIX = '../vendor/lila/';
const sources = import.meta.glob<string>('../vendor/lila/{analyse,lib,keyboardMove,site,editor}/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const files = new Map(Object.entries(sources).map(([k, v]) => [k.slice(VENDOR_PREFIX.length), v]));
const catalogs = import.meta.glob<string>('../vendor/lila/translation/source/*.xml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Mirrors vite.config.ts I18N_EAGER + I18N_LAZY. */
const STUDIO_I18N = ['site', 'preferences', 'study', 'broadcast', 'timeago', 'variant', 'team', 'keyboardMove', 'localAnalysis', 'storm', 'nvui'];

const IMPORT_RE = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm;
const DYNAMIC_RE = /import\(\s*'([^']+)'\s*\)/g;

function resolveRelative(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Runtime import graph of the vendored lila code reachable from the Studio's lila entry points. */
function walk(entries: string[]): { reached: Set<string>; npm: Set<string>; unresolved: string[] } {
  const reached = new Set<string>();
  const npm = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const text = files.get(file);
    if (text === undefined) {
      unresolved.push(file);
      continue;
    }
    const specs: string[] = [];
    for (const m of text.matchAll(IMPORT_RE)) {
      const typeOnly = !!m[2] || /^\s*import\s+type\s/.test(m[0]);
      if (!typeOnly) specs.push(m[3]!);
    }
    for (const m of text.matchAll(DYNAMIC_RE)) specs.push(m[1]!);
    for (const spec of specs) {
      const target = spec.startsWith('.') ? resolveRelative(file, spec) : lilaImportTarget(spec, file);
      if (target === null) {
        if (!spec.startsWith('data:')) npm.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
        continue;
      }
      const hit = lilaCandidateFiles(target).find(c => files.has(c));
      if (hit) queue.push(hit);
      else unresolved.push(`${spec} (from ${file})`);
    }
  }
  return { reached, npm, unresolved };
}

describe('vendored lila tree', () => {
  // What Studio imports as lila/<package>/<module> (src/studio), plus what site.ts maps loadEsm to.
  const entries = [
    'analyse/src/start.ts',
    'analyse/src/view/util.ts',
    'analyse/src/pgnImport.ts',
    'lib/src/view/index.ts',
    'site/src/asset.ts',
    'site/src/mousetrap.ts',
    'site/src/reload.ts',
    'site/src/sound.ts',
    'keyboardMove/src/keyboardMove.ts',
  ];
  const { reached, npm, unresolved } = walk(entries);

  it('resolves every runtime import to a vendored file or an installed package', () => {
    expect(unresolved).toEqual([]);
    expect(reached.size).toBeGreaterThan(100);
    const deps = new Set(Object.keys(pkg.dependencies));
    expect([...npm].filter(p => !deps.has(p)).sort()).toEqual([]);
  });

  it('has every i18n string the reached code uses in the generated catalogs', () => {
    const dicts = new Map(
      Object.entries(catalogs)
        .map(([path, xml]) => [path.split('/').pop()!.replace('.xml', ''), parseTranslationXml(xml)] as const)
        .filter(([name]) => STUDIO_I18N.includes(name)),
    );
    expect([...dicts.keys()].sort()).toEqual([...STUDIO_I18N].sort());
    const missing = new Set<string>();
    for (const file of reached) {
      if (file.includes('/study/')) continue; // study UI is never shown (no study data)
      for (const m of (files.get(file) ?? '').matchAll(/\bi18n\.(\w+)\.(\w+)\b/g)) {
        const [, cat, key] = m;
        if (!dicts.get(cat!)?.has(key!)) missing.add(`i18n.${cat}.${key} (${file})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('carries the Outpost patches (scripts/lila-patches)', () => {
    expect(files.get('analyse/src/ctrl.ts')).toContain('this.opts.outpost.changeFen(fen)');
    expect(files.get('analyse/src/keyboard.ts')).toContain('keyboardHelpHtml()');
    expect(files.get('analyse/src/explorer/explorerXhr.ts')).toContain("opts.db === 'player' && opts.playerEndpoint");
    expect(files.get('analyse/src/pgnImport.ts')).toContain('export const glyphOfNag');
    expect(files.get('analyse/src/view/actionMenu.ts')).toContain('!ctrl.opts.outpost');
    expect(files.get('lib/src/ceval/engines/engines.ts')).not.toContain('ThreadedEngine(');
  });
});
