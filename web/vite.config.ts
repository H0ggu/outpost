/**
 * Vite 8 multi-page build (PLAN §1, §2):
 *   - index.html  → the React SPA (src/app/main.tsx)
 *   - studio.html → the vendored lila analysis board (src/studio/main.ts)
 * public/ (vendored Lichess assets under /lichess, manifest, icons) is copied as-is.
 *
 * Dev: `npm run dev` proxies /api and /assets/lifat to the Fastify server (OUTPOST_API_URL,
 * default http://localhost:8080) without changing the Host header, so the server's same-host
 * Origin check passes. Dev and preview send COOP/COEP like the server does, so stockfish-web
 * can use SharedArrayBuffer.
 *
 * Studio glue (PLAN §8.2, owned by the Studio module), all in `studioLila()` below:
 *   - resolver for lila's own bare imports (`lib`, `lib/*`, `keyboard-move`, `editor/*`, `@/…`) from
 *     vendored files to the importing package's src; Studio code imports lila as `lila/<pkg>/<module>`;
 *   - `virtual:lila-i18n` (+ `/nvui`): translation/source XML → `window.i18n` (English);
 *   - `virtual:lila-css/<entry>.css`: lila's SCSS entries compiled with sass, with a generated
 *     `gen/_wrap.scss` and asset URLs pointed at /lichess;
 *   - `virtual:studio-engines`: URLs of the stockfish-web and stockfish.js files, served from
 *     node_modules in dev and emitted under /assets/vendor/<pkg>-<version>/ in the build;
 *   - `/studio` → studio.html in the dev and preview servers (the production server does the same).
 * The pure parts live in src/studio/build/lilaGlue.ts (unit-tested).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import * as sass from 'sass';
import { defineConfig, type Connect, type Plugin, type ProxyOptions } from 'vite';
import {
  colorWrapScss,
  i18nModuleCode,
  lilaCandidateFiles,
  lilaImportTarget,
  parseTranslationXml,
  rewriteLilaCssUrls,
} from './src/studio/build/lilaGlue.ts';

const API_TARGET = process.env.OUTPOST_API_URL ?? 'http://localhost:8080';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const proxy: Record<string, ProxyOptions> = {
  '/api': { target: API_TARGET, changeOrigin: false },
  '/assets/lifat': { target: API_TARGET, changeOrigin: false },
};

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// ---------------------------------------------------------------------------
// Studio glue
// ---------------------------------------------------------------------------

const VENDOR = here('./vendor/lila');
const PUBLIC = here('./public');
const require = createRequire(import.meta.url);

/** lila catalogs installed on window.i18n at startup; the others load on demand (`loadI18n`). */
const I18N_EAGER = [
  'site',
  'preferences',
  'study',
  'broadcast',
  'timeago',
  'variant',
  'team',
  'keyboardMove',
  'localAnalysis',
  'storm',
] as const;
const I18N_LAZY = ['nvui'] as const;

/** SCSS entries (paths in web/vendor/lila, or inline sources for lila's `bits` package we don't vendor). */
const CSS_ENTRIES: Readonly<Record<string, { file: string } | { source: string }>> = {
  'lib.theme.all': { file: 'lib/css/build/lib.theme.all.scss' },
  site: { file: 'site/css/build/site.scss' },
  'analyse.free': { file: 'analyse/css/build/analyse.free.scss' },
  keyboardMove: { file: 'keyboardMove/css/build/keyboardMove.scss' },
  // ui/bits/css/build/bits.dialog.scss upstream (loaded by lib/view/dialog for every dialog).
  'bits.dialog': { source: "@import 'lib/css/plugin';\n@import 'lib/css/component/dialog';\n" },
};

/** Engine files served to lila's ceval (lib/ceval/engines). */
const ENGINE_PACKAGES = [
  {
    key: 'stockfishWeb',
    name: '@lichess-org/stockfish-web',
    files: [
      'sf_19_smallnet.js',
      'sf_19_smallnet.wasm',
      'sf_19_smallnet_relaxed-simd.js',
      'sf_19_smallnet_relaxed-simd.wasm',
      'sf_19.js',
      'sf_19.wasm',
      'sf_19_relaxed-simd.js',
      'sf_19_relaxed-simd.wasm',
      'fsf_14.js',
      'fsf_14.wasm',
    ],
  },
  { key: 'stockfishJs', name: 'stockfish.js', files: ['stockfish.js', 'stockfish.wasm.js', 'stockfish.wasm'] },
] as const;

const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

function enginePackage(name: string): { dir: string; version: string } {
  const pkgJson = require.resolve(`${name}/package.json`);
  const version = (JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { version: string }).version;
  return { dir: path.dirname(pkgJson), version };
}

/** Public URL prefix of an engine package (versioned, so the server's immutable caching is safe). */
const engineBase = (name: string, version: string): string =>
  `/assets/vendor/${name.replace(/^@[^/]+\//, '')}-${version}`;

const isInside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function compileLilaCss(name: string): { css: string; files: string[]; dropped: string[] } {
  const entry = CSS_ENTRIES[name];
  if (!entry) throw new Error(`unknown lila CSS entry ${name}`);
  const themeDir = path.join(VENDOR, 'lib/css/theme');
  const wrap = colorWrapScss(
    fs
      .readdirSync(themeDir)
      .filter(f => f.startsWith('_') && f.includes('theme.') && f.endsWith('.scss'))
      .map(f => fs.readFileSync(path.join(themeDir, f), 'utf8')),
  );
  const wrapUrl = pathToFileURL(path.join(themeDir, 'gen/_wrap.scss'));
  // lila generates gen/_wrap.scss on disk; we serve it from memory so the vendored tree stays untouched.
  const wrapImporter: sass.Importer<'sync'> = {
    canonicalize: url => (/(^|\/)theme\/gen\/_?wrap(\.scss)?$/.test(url) ? wrapUrl : null),
    load: url => (url.href === wrapUrl.href ? { contents: wrap, syntax: 'scss' } : null),
  };
  const options: sass.Options<'sync'> = {
    importers: [wrapImporter],
    loadPaths: [VENDOR],
    silenceDeprecations: ['import', 'global-builtin'],
    quietDeps: true,
    logger: sass.Logger.silent,
    style: 'expanded',
  };
  const result =
    'file' in entry
      ? sass.compile(path.join(VENDOR, entry.file), options)
      : sass.compileString(entry.source, { ...options, url: pathToFileURL(path.join(VENDOR, `${name}.scss`)) });
  const { css, dropped } = rewriteLilaCssUrls(result.css, p => fs.existsSync(path.join(PUBLIC, p)));
  const files = result.loadedUrls.filter(u => u.protocol === 'file:').map(u => fileURLToPath(u));
  return { css: `/* lila ${name} (AGPL-3.0-or-later, the lila authors), compiled by vite.config.ts */\n${css}`, files, dropped };
}

function studioLila(): Plugin {
  const engines = ENGINE_PACKAGES.map(p => {
    const { dir, version } = enginePackage(p.name);
    return { ...p, dir, version, base: engineBase(p.name, version) };
  });
  const VIRTUAL = '\0outpost-studio:';

  const serveStudio: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    const [pathname = '', query] = url.split('?');
    if (pathname === '/studio' || pathname === '/studio/') {
      req.url = `/studio.html${query === undefined ? '' : `?${query}`}`;
      return next();
    }
    for (const e of engines) {
      if (!pathname.startsWith(`${e.base}/`)) continue;
      const file = pathname.slice(e.base.length + 1);
      if (!(e.files as readonly string[]).includes(file)) break;
      res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      for (const [k, v] of Object.entries(crossOriginIsolation)) res.setHeader(k, v);
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(path.join(e.dir, file)).pipe(res);
      return;
    }
    next();
  };

  return {
    name: 'outpost-studio-lila',
    enforce: 'pre',

    resolveId(source, importer) {
      if (source === 'virtual:lila-i18n' || source.startsWith('virtual:lila-i18n/')) return VIRTUAL + source.slice(8);
      if (source.startsWith('virtual:lila-css/')) return VIRTUAL + source.slice(8);
      if (source === 'virtual:studio-engines') return VIRTUAL + 'studio-engines';
      if (!importer) return null;
      const from = importer.split('?')[0] ?? importer;
      if (!isInside(VENDOR, from)) return null;
      const target = lilaImportTarget(source, path.relative(VENDOR, from).split(path.sep).join('/'));
      if (target === null) return null;
      for (const candidate of lilaCandidateFiles(target)) {
        const file = path.join(VENDOR, candidate);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
      }
      this.error(`lila import "${source}" from ${path.relative(VENDOR, from)} not found (looked for ${target})`);
    },

    load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const name = id.slice(VIRTUAL.length);
      if (name === 'studio-engines') {
        return `export default ${JSON.stringify(Object.fromEntries(engines.map(e => [e.key, e.base])))};`;
      }
      if (name === 'lila-i18n' || name.startsWith('lila-i18n/')) {
        const cats = name === 'lila-i18n' ? I18N_EAGER : [name.slice('lila-i18n/'.length)];
        const catalogs = cats.map(cat => {
          if (!([...I18N_EAGER, ...I18N_LAZY] as readonly string[]).includes(cat)) this.error(`unknown i18n catalog ${cat}`);
          const file = path.join(VENDOR, 'translation/source', `${cat}.xml`);
          this.addWatchFile(file);
          return { name: cat, dict: parseTranslationXml(fs.readFileSync(file, 'utf8')) };
        });
        return i18nModuleCode(catalogs);
      }
      const css = /^lila-css\/([\w.]+)\.css$/.exec(name);
      if (css?.[1]) {
        const { css: code, files, dropped } = compileLilaCss(css[1]);
        for (const f of files) this.addWatchFile(f);
        if (dropped.length && this.environment.mode === 'build')
          this.info(`lila-css/${css[1]}: assets not shipped (rules neutralised): ${dropped.join(', ')}`);
        return code;
      }
      return null;
    },

    configureServer(server) {
      server.middlewares.use(serveStudio);
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [pathname = '', query] = (req.url ?? '').split('?');
        if (pathname === '/studio' || pathname === '/studio/') req.url = `/studio.html${query === undefined ? '' : `?${query}`}`;
        next();
      });
    },

    generateBundle() {
      for (const e of engines)
        for (const file of e.files)
          this.emitFile({ type: 'asset', fileName: `${e.base.slice(1)}/${file}`, source: fs.readFileSync(path.join(e.dir, file)) });
    },
  };
}

export default defineConfig({
  plugins: [studioLila(), react()],
  resolve: {
    alias: [
      // pgn-viewer's exports map ("./*" → "./dist/*.js") hides its stylesheet; alias the file directly.
      { find: 'lpv-css', replacement: here('../node_modules/@lichess-org/pgn-viewer/dist/lichess-pgn-viewer.css') },
      // Studio imports vendored lila as `lila/<package>/<module>` → web/vendor/lila/<package>/src/<module>.
      // tsc maps the same specifier to hand-written declarations instead (tsconfig.studio.json, PLAN §1).
      { find: /^lila\/([^/]+)\/(.+)$/, replacement: `${VENDOR}/$1/src/$2` },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: crossOriginIsolation,
    proxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: crossOriginIsolation,
    proxy,
  },
  build: {
    // No source maps in the image (~2.5 MB, served publicly). Debug build: `npm run build -w @outpost/web -- --sourcemap`.
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      input: {
        main: here('./index.html'),
        studio: here('./studio.html'),
      },
    },
  },
});
