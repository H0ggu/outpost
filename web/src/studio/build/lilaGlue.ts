/**
 * Build glue for the vendored lila analysis board (PLAN §8.2), as pure functions.
 *
 * vite.config.ts does the file IO and wires these into Vite plugins; keeping the logic here (no Node
 * imports, no lila imports) lets the unit tests (web/test/studio-glue.test.ts) and every tsc program
 * load it. Ports of lila's own build tool (ui/.build/src at the pinned commit, AGPL-3.0-or-later):
 *   - `lilaImportTarget`: what lila's tsconfig `paths` and pnpm workspace links resolve
 *   - `parseTranslationXml` / `i18nModuleCode`: `.build/src/i18n.ts` (`parseXml`, `writeJavascript`)
 *   - `colorWrapScss`: `.build/src/sass.ts` (`buildColorWrap`)
 *   - `rewriteLilaCssUrls`: replaces lila's `/assets` layout with Outpost's `/lichess` assets
 */

/** lila workspace package name → folder under web/vendor/lila. */
export const LILA_PACKAGE_DIRS: Readonly<Record<string, string>> = {
  lib: 'lib',
  'keyboard-move': 'keyboardMove',
  editor: 'editor',
  analyse: 'analyse',
  site: 'site',
};

/** Package entry points (package.json `exports["."]`) for bare package imports. */
const PACKAGE_ENTRIES: Readonly<Record<string, string>> = {
  lib: 'lib/src/index',
  'keyboard-move': 'keyboardMove/src/exports',
  editor: 'editor/src/editor',
};

/**
 * Resolves one of lila's own bare imports, as seen from a vendored file.
 *
 * @param spec      the import specifier (`lib`, `lib/ceval`, `keyboard-move`, `@/ctrl`, …)
 * @param importer  the importing file, relative to web/vendor/lila with `/` separators
 *                  (`analyse/src/ctrl.ts`)
 * @returns the target without extension, relative to web/vendor/lila (`lib/src/ceval`), or null when
 *          the specifier is not lila's (npm packages, relative paths)
 */
export function lilaImportTarget(spec: string, importer: string): string | null {
  if (spec.startsWith('@/')) {
    // `@/*` → `${configDir}/src/*` (ui/tsconfig.base.json): the importing package's own src.
    const pkg = importer.split('/')[0];
    if (!pkg || !importer.includes('/src/')) return null;
    return `${pkg}/src/${spec.slice(2)}`;
  }
  const slash = spec.indexOf('/');
  const name = slash === -1 ? spec : spec.slice(0, slash);
  const dir = LILA_PACKAGE_DIRS[name];
  if (dir === undefined) return null;
  if (slash === -1) return PACKAGE_ENTRIES[name] ?? null;
  return `${dir}/src/${spec.slice(slash + 1)}`;
}

/** Candidate files for a resolved target, in lila's resolution order. */
export const lilaCandidateFiles = (target: string): string[] =>
  /\.[cm]?[jt]sx?$/.test(target)
    ? [target]
    : [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}.js`];

// ---------------------------------------------------------------------------
// Translations (translation/source/*.xml → window.i18n)
// ---------------------------------------------------------------------------

/** Plural forms of one key. */
export type I18nPluralForms = Partial<Record<'zero' | 'one' | 'two' | 'few' | 'many' | 'other', string>>;
/** One catalog: key → text or plural forms, sorted by key. */
export type I18nDict = Map<string, string | I18nPluralForms>;

const xmlAttrs = '((?:[^>"]|"[^"]*")*)';
const xmlStringRe = new RegExp(`<string\\s${xmlAttrs}>([^<]*)</string>`, 'g');
const xmlPluralsRe = new RegExp(`<plurals\\s${xmlAttrs}>([\\s\\S]*?)</plurals>`, 'g');
const xmlItemRe = new RegExp(`<item\\s${xmlAttrs}>([^<]*)</item>`, 'g');
const xmlEntities: Readonly<Record<string, string>> = { apos: "'", gt: '>', lt: '<', quot: '"' };
const formatStringRe = /%(?:\d\$)?s/;

function xmlAttr(attrs: string, name: string): string {
  const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
  if (value === undefined) throw new Error(`no ${name} in <${attrs}>`);
  return value;
}

function xmlText(text: string): string {
  return text
    .trim()
    .replace(/&(apos|gt|lt|quot);/g, (_, entity: string) => xmlEntities[entity] ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'");
}

/** Parses one lila translation XML file (flat `<string>` and `<plurals><item>` elements). */
export function parseTranslationXml(xml: string): I18nDict {
  const dict: I18nDict = new Map();
  if (!xml) return dict;
  const data = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const [, attrs = '', text = ''] of data.matchAll(xmlStringRe)) dict.set(xmlAttr(attrs, 'name'), xmlText(text));
  for (const [, attrs = '', items = ''] of data.matchAll(xmlPluralsRe)) {
    const group: I18nPluralForms = {};
    for (const [, itemAttrs = '', text = ''] of items.matchAll(xmlItemRe))
      group[xmlAttr(itemAttrs, 'quantity') as keyof I18nPluralForms] = xmlText(text);
    dict.set(xmlAttr(attrs, 'name'), group);
  }
  return new Map([...dict.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')));
}

/**
 * lila's runtime helpers for formatted (`s`) and plural (`p`) strings, unminified. Both return a
 * function with an `asArray` variant for snabbdom children.
 */
const I18N_PRELUDE = `
function p(t) {
  const r = (n, ...e) => l(o(t, n), n, ...e).join('');
  r.asArray = (n, ...e) => l(o(t, n), ...e);
  return r;
}
function s(t) {
  const r = (...n) => l(t, ...n).join('');
  r.asArray = (...n) => l(t, ...n);
  return r;
}
function o(t, n) {
  return t[window.i18n.quantity(n)] || t.other || t.one || '';
}
function l(t, ...r) {
  const n = t.split(/(%(?:\\d\\$)?s)/);
  if (r.length) {
    const e = n.indexOf('%s');
    if (e != -1) n[e] = r[0];
    else
      for (let i = 0; i < r.length; i++) {
        const s = n.indexOf('%' + (i + 1) + '$s');
        if (s != -1) n[s] = r[i];
      }
  }
  return n;
}
`;

/**
 * ES module source that installs the given English catalogs on `window.i18n` (lila's
 * `writeJavascript` for locale en-GB). The first module evaluated also sets `quantity`.
 */
export function i18nModuleCode(catalogs: ReadonlyArray<{ name: string; dict: I18nDict }>): string {
  const lines = [
    '// Generated by vite.config.ts from web/vendor/lila/translation/source (lila, AGPL-3.0-or-later).',
    I18N_PRELUDE,
    "const w = window; w.i18n ??= {}; w.i18n.quantity ??= n => (n == 1 ? 'one' : 'other');",
  ];
  for (const { name, dict } of catalogs) {
    if (!/^[A-Za-z]\w*$/.test(name)) throw new Error(`bad i18n catalog name ${name}`);
    const entries = [...dict].map(
      ([k, v]) =>
        `${JSON.stringify(k)}: ${
          typeof v !== 'string' ? `p(${JSON.stringify(v)})` : formatStringRe.test(v) ? `s(${JSON.stringify(v)})` : JSON.stringify(v)
        }`,
    );
    lines.push(`w.i18n.${name} = {\n  ${entries.join(',\n  ')}\n};`);
  }
  lines.push('export {};');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SCSS
// ---------------------------------------------------------------------------

/**
 * `lib/css/theme/gen/_wrap.scss`: one `$c-x: var(--c-x);` per CSS colour variable declared in the
 * theme files (`_theme.*.scss`), so lila's SCSS can use `$c-x`.
 */
export function colorWrapScss(themeFiles: readonly string[]): string {
  const vars = new Set<string>();
  for (const text of themeFiles)
    for (const line of text.split('\n')) {
      if (!line.includes('--c-')) continue;
      const commentIndex = line.indexOf('//');
      if (commentIndex !== -1 && commentIndex < line.indexOf(':')) continue;
      vars.add((line.split(':')[0] ?? '').trim().replace('--', ''));
    }
  return [...vars]
    .filter(v => /^c-[\w-]+$/.test(v))
    .sort()
    .map(v => `$${v}: var(--${v});`)
    .join('\n')
    .concat('\n');
}

/** Hand-drawn replacements for lila images that are not vendored (AGPL-3.0-or-later, Outpost). */
const svgData = (svg: string): string =>
  `"data:image/svg+xml,${encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')}"`;
const RING = '<circle cx="12" cy="12" r="10" fill="none" stroke="#000" stroke-width="2"/>';
export const INLINE_IMAGES: Readonly<Record<string, string>> = {
  // Disclosure buttons of the move tree (lib/css/tree/_tree.scss): used as CSS masks (alpha only).
  '/assets/images/buttons/plus-button-mask.webp': svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${RING}<path d="M7 12h10M12 7v10" stroke="#000" stroke-width="2.4"/></svg>`,
  ),
  '/assets/images/buttons/minus-button-mask.webp': svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${RING}<path d="M7 12h10" stroke="#000" stroke-width="2.4"/></svg>`,
  ),
  // Engine stop button (lib/css/ceval/_ctrl.scss).
  '../images/buttons/pause.svg': svgData(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="#999"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="#999"/></svg>',
  ),
  // Moving highlight on the engine progress bar.
  '../images/bar-highlight.png': svgData(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="3"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="200" height="3" fill="url(#g)"/></svg>',
  ),
};

/** Where a lila CSS asset lives in Outpost's public tree (`/lichess/...`), before the existence check. */
export function lilaCssAssetPath(url: string): string | null {
  let m = /^\.\.\/font\/([\w.-]+)$/.exec(url);
  if (m) return `/lichess/font/${m[1]}`;
  m = /^\.\.\/images\/board\/([\w.-]+)$/.exec(url);
  if (m) return `/lichess/board/${m[1]}`;
  // Material-difference pieces: lila uses its grey "mono" set, which isn't vendored. The white cburnett
  // pieces (black outline) read on every theme; studio.css dims them like mono.
  m = /^\.\.\/piece\/mono\/([PNBRQK])\.svg$/.exec(url);
  if (m) return `/lichess/piece/cburnett/w${m[1]}.svg`;
  m = /^\.\.\/piece\/([\w-]+)\/([\w.-]+)$/.exec(url);
  if (m) return `/lichess/piece/${m[1]}/${m[2]}`;
  return null;
}

/** Result of `rewriteLilaCssUrls`. */
export interface CssRewrite {
  css: string;
  /** lila asset URLs that Outpost does not ship (their rules were neutralised). */
  dropped: string[];
}

/**
 * Points every `url()` of compiled lila CSS at Outpost's assets:
 *   - fonts, boards and pieces → `/lichess/…` when the file is vendored (`exists`);
 *   - a few UI images → inline SVG (`INLINE_IMAGES`);
 *   - anything else → removed: `@font-face` blocks without a shipped font are deleted, other
 *     `url(…)` values become `none` (only board themes Outpost doesn't offer, and the loader sprite,
 *     which studio.css replaces).
 */
export function rewriteLilaCssUrls(css: string, exists: (publicPath: string) => boolean): CssRewrite {
  const dropped = new Set<string>();
  const target = (raw: string): string | null => {
    const url = raw.trim().replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:') || url.startsWith('/lichess/')) return `"${url}"`;
    const inline = INLINE_IMAGES[url];
    if (inline) return inline;
    const p = lilaCssAssetPath(url);
    if (p && exists(p)) return `"${p}"`;
    dropped.add(url);
    return null;
  };
  // @font-face blocks: keep only those whose font is shipped.
  let out = css.replace(/@font-face\s*\{[^}]*\}/g, block => {
    const m = /url\(([^)]*)\)/.exec(block);
    if (!m) return block;
    const t = target(m[1] ?? '');
    return t ? block.replace(m[0], `url(${t})`) : '';
  });
  out = out.replace(/url\(([^)]*)\)/g, (_all, raw: string) => {
    const t = target(raw);
    return t ? `url(${t})` : 'none';
  });
  return { css: out, dropped: [...dropped].sort() };
}
