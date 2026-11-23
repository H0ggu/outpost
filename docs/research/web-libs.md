# Library research for the self-hosted app (checked 2026-11-23)

Sources: npm registry metadata, the package tarballs, Node v26.13.1 docs and source, lichess-org/lila source, and official blogs and docs. I also ran checks on local Node 26.13.1 (chessops, node:sqlite, zstd, type-stripping across workspaces).

## 0. Current versions (npm `latest`)
| pkg | ver | notes |
|---|---|---|
| chessground | 9.2.1 (2025-05) | GPL-3.0-or-later, no dependencies |
| chessops | 0.15.1 (2026-07-12) | GPL-3.0-or-later, dependency `@badrap/result ^0.3` |
| stockfish (nmrugg) | 19.0.1 (2026-10-10) | GPL-3.0 |
| @lichess-org/stockfish-web | 0.6.1 (2026-11-21) | package.json says AGPL-3.0-or-later, but the LICENSE file is GPLv3 |
| typescript | 7.0.2 (2026-07-08) | 6.0.3 is the last JS-based release |
| vite / @vitejs/plugin-react | 8.3.8 / 6.3.0 | |
| vitest | 5.1.1 | engines `^22.12 \|\| ^24 \|\| >=26` |
| react / react-dom | 19.3.1 | |
| react-router | 8.5.2 | `version-7` tag is 7.18.6 |
| @tanstack/react-query | 5.108.3 | |
| fastify / @fastify/static | 5.12.8 / 10.1.12 | 6.0.0-alpha.6 exists; avoid it |
| world-atlas / topojson-client / d3-geo / i18n-iso-countries | 2.0.2 / 3.1.0 / 3.1.2 / 7.14.0 | ISC / ISC / ISC / MIT |
| Node | 26.13.1 is LTS "Lithium"; 24.22.3 is LTS "Krypton" | |

## 1. chessground 9.2.1
- Install with `npm i chessground`. The package is ESM (`"type":"module"`). Its exports are `"."` → `dist/chessground.js`, `"./assets/*"` and `"./*"` → `dist/*.js`. Types sit next to the files: `chessground/api`, `/config`, `/types`, `/draw`.
- CSS ships in `node_modules/chessground/assets/`:
  ```ts
  import 'chessground/assets/chessground.base.css';
  import 'chessground/assets/chessground.brown.css';    // board as an inline SVG data URI
  import 'chessground/assets/chessground.cburnett.css'; // 12 pieces as inline SVG data URIs
  ```
  No extra image files are needed. The base CSS does not size the board, so the container needs a size, e.g. `width:100%; aspect-ratio:1`.
- Key Config fields (from `src/config.ts`):
  - `fen`, `orientation`, `turnColor`, `check` (Color|boolean), `lastMove: Key[]`, `coordinates` (default true), `coordinatesOnSquares`, `viewOnly`, `animation:{enabled,duration}` (default 200 ms; under 70 ms disables it).
  - `movable:{free,color:'white'|'black'|'both',dests:Map<Key,Key[]>,showDests,events:{after(orig,dest,meta)},rookCastle}`.
  - `premovable`, `draggable`, `events:{change,move,select}`.
  - `drawable:{enabled,visible,shapes,autoShapes,brushes,onChange}`.
- Draw shapes: `{orig, dest?, brush?, modifiers?:{lineWidth,hilite}, label?:{text,fill}, piece?, customSvg?}`. Default brushes are green, red, blue, yellow, paleBlue, paleGreen, paleRed, paleGrey, purple, pink and white.
- `set()` overrides `movable.dests` and `autoShapes` rather than merging them. An orientation change calls `redrawAll()` internally.
- Resizing: 9.x attaches a `ResizeObserver` to the wrap element and updates bounds automatically. Call `api.redrawAll()` only after re-inserting or moving the DOM node. The old `document.body` `chessground.resize` event is only a fallback for browsers without ResizeObserver.
- Promotion: chessground has no promotion picker. Detect a pawn reaching the last rank in `after` and show your own picker.
```tsx
const el = useRef<HTMLDivElement>(null), cg = useRef<Api>();
useEffect(() => { cg.current = Chessground(el.current!, cfg); return () => cg.current?.destroy(); }, []); // StrictMode-safe
useEffect(() => { cg.current?.set(cfg); }, [cfg]);
const cfgFor = (pos: Chess, lastMove?: Key[]): Config => ({
  fen: makeFen(pos.toSetup()), turnColor: pos.turn, check: pos.isCheck() ? pos.turn : false, lastMove,
  movable: { free: false, color: pos.turn, dests: chessgroundDests(pos), events: { after: onMove } } });
cg.current.setAutoShapes([{ orig: 'g1', dest: 'f3', brush: 'paleBlue', label: { text: '+0.4' } }]);
```
- Licences:
  - Chessground is GPL-3.0-or-later. Its README says you "must release your source code" to users of the site.
  - cburnett pieces: Colin M.L. Burnett, GPLv2+ (per lila COPYING.md). Merida is also GPLv2+. California, maestro, cardinal and staunty are CC BY-NC-SA 4.0. Alpha is "personal non-commercial".
  - The lila board images are AGPLv3+.

## 2. chessops 0.15.1
Imports use subpaths: `chessops/chess|fen|san|util|pgn|compat|variant|transform`.
```ts
import { Chess, castlingSide, normalizeMove } from 'chessops/chess';
import { parseFen, makeFen, INITIAL_FEN, INITIAL_EPD } from 'chessops/fen';
import { parseSan, makeSan, makeSanAndPlay } from 'chessops/san';
import { parseUci, makeUci, parseSquare, kingCastlesTo } from 'chessops/util';
import { chessgroundDests, chessgroundMove, scalachessCharPair, lichessRules } from 'chessops/compat';
const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();   // Result: .isOk/.unwrap()
const mv = parseSan(pos, 'Nf3')!; pos.play(mv);                 // play mutates; makeSan clones
const epdKey = makeFen(pos.toSetup(), { epd: true });           // "board turn castling ep"
```
- **EPD normalisation (tested):** `toSetup()` uses `legalEpSquare`, so the ep square appears only when an ep capture is legal. After 1.e4 the key is `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -`. Castling rights are also normalised by `fromSetup`. This makes it a good transposition key.
- **Castling gotcha (tested):** chessops moves castle king-to-rook. `makeUci(parseSan(pos,'O-O'))` gives `e1h1`. `pos.isLegal({e1→g1})` is true, and `normalizeMove` turns it into e1h1. Stockfish and most UCI consumers expect `e1g1` in standard chess:
  ```ts
  const stdUci = (pos, m) => { const s = castlingSide(pos, m); return s ? makeUci({ from: m.from, to: kingCastlesTo(pos.turn, s) }) : makeUci(m); };
  ```
- `chessgroundDests(pos, {chess960?})` returns `Map<SquareName,SquareName[]>`. For the king it adds both g1/c1 and the rook squares; chessground then filters by `rookCastle`. `chessgroundMove(m)` returns `[from,to]` for `lastMove`.
- **PGN:**
  - `parsePgn(text)` returns `Game<PgnNodeData>[]`, where `Game` is `{headers:Map, comments?, moves:Node}` and `PgnNodeData` is `{san, startingComments?, comments?, nags?}`.
  - `startingPosition(headers)` returns a Result<Position>.
  - Nodes support `node.mainline()`, `mainlineNodes()` and `end()`.
  - `walk(node, ctx, (ctx,data,childIndex)=>bool|void)` and `transform(node, ctx, (ctx,data,i)=>U|undefined)`. The ctx needs `clone()`; Position has it, and `Box` wraps other values.
  - `makePgn(game)`.
  - `parseComment(str)` returns `{text, shapes, clock?:seconds, emt?, evaluation?:{pawns|mate,depth?}}` and parses `[%clk]`, `[%eval]`, `[%cal]` and `[%csl]`.
- **Streaming PGN:** `new PgnParser((game, err)=>{}, initHeaders?, maxBudget=1_000_000)`. Feed it with `parser.parse(chunk,{stream:true})`, then `parser.parse('')`.
- **Variants:** `chessops/variant` has `defaultPosition(rules)` and `setupPosition(rules, setup)`. Rules are chess, antichess, kingofthehill, 3check, atomic, horde, racingkings, crazyhouse. Chess960 runs through `Chess` with file-letter castling FEN. `compat.lichessRules('kingOfTheHill')` maps Lichess variant keys.
- **Zobrist:** chessops 0.15.1 has none (no hash module; grep confirmed). Options:
  - (a) Store the EPD text with a UNIQUE index (simplest).
  - (b) Use 8 bytes of `crypto.createHash('sha1')` over the EPD as a BLOB or INTEGER key.
  - (c) Write your own Polyglot Zobrist (781-key table, about 60 lines).

## 3. Stockfish in the browser
| | nmrugg `stockfish@19.0.1` | `@lichess-org/stockfish-web@0.6.1` |
|---|---|---|
| Builds | `stockfish-19-lite-single` (28 KB js + 1.85 MB wasm)<br>`-lite` (MT, 1.70 MB)<br>`-19-single` (99.2 MB)<br>`-19` (MT, 99.1 MB)<br>`-asm` (3.2 MB, slow) | `sf_19`, `sf_19_smallnet`, `sf_dev`, `fsf_14` (variants), plus `_relaxed-simd` versions<br>wasm is 0.5–0.7 MB each |
| NNUE | Built into the wasm. Lite uses the 1 MB net nn-61e7af4bb97d; full uses nn-1a298aa575a0 | Not shipped. Fetch nn-1a298aa575a0 (98.5 MB) or nn-61e7af4bb97d (1.17 MB, smallnet) yourself from `https://tests.stockfishchess.org/api/nn/<name>`, then call `module.setNnueBuffer(bytes, idx)`; `getRecommendedNnue(i)` gives names |
| Threads / COOP+COEP | `*-single` and asm need no special headers. MT builds need `crossOriginIsolated` | **All builds** need SharedArrayBuffer, WASM SIMD and dynamic `import()` in a worker. Lichess passes `wasmMemory: new WebAssembly.Memory({shared:true, initial:1536 (smallnet) / 2560 pages, maximum})` |
| API | Classic `Worker` + `postMessage` UCI strings | ES module factory: `(await import(url)).default({wasmMemory, locateFile, mainScriptUrlOrBlob})` → `{uci(cmd), listen, onError}`. The README calls it "not straight-forward"; Lichess-specific |

**Recommendation: nmrugg `stockfish`, `lite-single` as the default.**
- It works on phones without COOP/COEP; the README lists iOS 16+ and Android.
- It is about 1.9 MB with the net built in, uses a plain Worker, and needs no net-loading code.
- When `crossOriginIsolated` is true, optionally switch to `lite` (MT) with `setoption name Threads value N`.

COOP/COEP gotcha: `COEP: require-corp` blocks cross-origin images such as Lichess or Chess.com avatars unless those servers send CORP/CORS headers. `credentialless` is not supported in Safari (caniuse). To set the headers:
- Fastify: `onSend` hook calling `reply.header('Cross-Origin-Opener-Policy','same-origin')` and `reply.header('Cross-Origin-Embedder-Policy','require-corp')`.
- Vite: `server.headers` and `preview.headers`.

Hosting with Vite:
- Copy `node_modules/stockfish/bin/stockfish-19-lite-single.{js,wasm}` to `apps/web/public/engine/`, either with an npm script using `cp` / `fs.cpSync` or with vite-plugin-static-copy 4.1.1.
- Do **not** use `new Worker(new URL(...))`, because Vite would bundle the emscripten glue.
- The glue reads the wasm URL from the worker URL hash (checked in the 19.0.1 bin), which allows a versioned wasm URL: `new Worker('/engine/stockfish-19-lite-single.js#' + encodeURIComponent('/engine/stockfish-19-lite-single.wasm?v=19.0.1'))`.
- `.wasm` must be served as `application/wasm`. @fastify/static → @fastify/send → mime@3 does this (checked).

```ts
const send = (c: string) => w.postMessage(c);
send('uci');                                   // ...'uciok'
send('setoption name MultiPV value 3'); send('setoption name Hash value 32');
send('isready');                               // wait 'readyok'
send('ucinewgame'); send(`position fen ${fen}`); // or 'position startpos moves e2e4 e7e5'
send('go depth 22');                           // or 'go infinite' … 'stop' → 'bestmove e2e4 ponder e7e5'
w.onmessage = ({ data: l }) => { if (!l.startsWith('info ') || !l.includes(' pv ')) return;
  const t = l.split(' '), g = (k: string) => t[t.indexOf(k) + 1];
  if (t.includes('lowerbound') || t.includes('upperbound')) return;
  const depth = +g('depth'), mpv = +(g('multipv') ?? 1), kind = g('score'), val = +t[t.indexOf('score') + 2];
  const pv = t.slice(t.indexOf('pv') + 1); /* kind 'cp'|'mate', side-to-move POV → negate for black */ };
```
- SF line order: `depth seldepth multipv score <cp|mate> N [wdl w d l] [lowerbound|upperbound] nodes nps hashfull tbhits time pv …`.
- After `stop`, wait for `bestmove` before sending a new `position`/`go`, or stale `info` lines leak through.

## 4. node:sqlite and zlib zstd (Node 26.13.1)
- **Status:**
  - node:sqlite is Stability 1.2 "Release candidate" (since 25.7 and 24.15).
  - No flag is needed and no ExperimentalWarning is printed (checked).
  - It is `node:`-scheme only. Bundled SQLite is 3.54.1.
- **Rename in v26.11.0:** `DatabaseSync` → `Database` and `StatementSync` → `Statement`. The old names stay as documentation-only deprecated aliases (DEP0210/0211). Node 24 only has `DatabaseSync`. Pin `engines.node >= 26.11` if you use `Database`.
- **Constructor:** `new Database(path, {readOnly, timeout (busy ms), readBigInts, returnArrays, enableForeignKeyConstraints (default true), defensive (default true), allowExtension, limits})`.
- **Statements and methods:**
  - `db.exec(sql)` and `db.prepare(sql, {readBigInts, returnArrays, persistent})`.
  - `stmt.run()` returns `{changes, lastInsertRowid}`; `.get()`, `.all()`, `.iterate()`.
  - `stmt.setReadBigInts(bool)`, `setReturnArrays`, `columns()`, `expandedSQL`.
  - `db.function(name, {deterministic, varargs, …}, fn)` and `db.aggregate(name, {start, step, result, inverse})` (window functions).
  - `db.createTagStore()` (LRU SQL template tags), `db.createModule` (virtual tables, v26.11), `serialize`/`deserialize` (v26.1), `sqlite.backup()`, sessions, `db.isTransaction`, `using` / `Symbol.dispose`.
- **Gotchas (tested):**
  - Rows are null-prototype objects and BLOBs come back as `Uint8Array`.
  - An int64 above 2^53 throws `ERR_OUT_OF_RANGE` unless readBigInts is on. That includes `run()`'s `lastInsertRowid` when the rowid is a 64-bit hash, so prepare inserts with `{readBigInts:true}`, or store hashes as BLOB(8).
- **Missing compared with better-sqlite3:** no `db.transaction()` wrapper, `pluck()` or `expand()`. Wrapper to use instead:
  ```ts
  const tx = <T>(fn: () => T) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } };
  ```
- **Pragmas:** `journal_mode=WAL` (checked), `synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size=-65536`, `mmap_size=268435456`, `PRAGMA optimize` on close.
- **Performance:** run bulk inserts in one transaction and reuse prepared statements. The API is synchronous, so put heavy imports in a `worker_threads` worker with its own connection; WAL allows concurrent readers.
- **zstd:**
  - `zlib.createZstdDecompress(opts)`, `zstdDecompressSync`, and the `createZstdCompress` counterparts exist (added 23.8 / 22.15).
  - Docs say Stability 1 Experimental, but there is no flag or warning (stream round-trip tested).
  - Options: `params:{[zlib.constants.ZSTD_d_windowLogMax]: 31}` for long-window frames, `chunkSize`, `rejectGarbageAfterEnd` (26.5).
  - Pipe it into `PgnParser` with `stream.setEncoding('utf8')`.

## 5. Recommended versions for the npm-workspaces SPA + Fastify monorepo
- **Node 26 LTS.** Run the server `.ts` directly: type stripping is Stable since 25.2 / 24.12, so tsx is not needed.
  - Node refuses `.ts` under node_modules, but workspace symlinks resolve to the real path. Importing a workspace package's `.ts` export worked on 26.13.1 (tested).
  - Recommended tsconfig: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` (or `allowImportingTsExtensions` + `noEmit`). No enums, namespaces or parameter properties.
- **TypeScript 7.0.x for `tsc -b --noEmit`.** It is the Go-native compiler (platform binaries) and about 10× faster.
  - It has **no stable JS API** (only `typescript/unstable/*`); a new API is planned for 7.1.
  - Breaking defaults compared with 6.0: `strict:true`, `module:esnext`, `types:[]` (set `"types":["node"]`), `rootDir:"./"`, `noUncheckedSideEffectImports:true`.
  - Hard errors: `baseUrl`, `moduleResolution node/node10/classic`, `target es5`, `esModuleInterop:false`, AMD/UMD/System modules, import `asserts`.
  - Vite, Vitest and Node don't call TS, so they are unaffected.
  - typescript-eslint 8.73 has peer `typescript >=4.8.4 <6.1.0`. If you lint with it, use the official alias: `"@typescript/native":"npm:typescript@^7.0.2", "typescript":"npm:@typescript/typescript6@^6.0.2"`.
  - Simpler alternative: `typescript@~6.0.3` with a 7-ready tsconfig.
- **Vite 8.3** (8.0 released 2026-03-12).
  - Rolldown replaces esbuild + Rollup, Oxc minifies JS, and Lightning CSS minifies CSS.
  - Renames (old names auto-converted but deprecated): `build.rollupOptions` → `build.rolldownOptions`, `worker.rollupOptions` → `worker.rolldownOptions`, `esbuild` → `oxc`, `optimizeDeps.esbuildOptions` → `rolldownOptions`.
  - The object form of `manualChunks` is removed.
  - The CJS default-import interop changed (`legacy.inconsistentCjsInterop`).
  - Default targets are Chrome 111, Firefox 114 and Safari 16.4.
  - Use `@vitejs/plugin-react@6` (needs vite ^8; Babel removed; React Compiler opt-in via `@rolldown/plugin-babel`).
- **Vitest 5.1** (5.0 released 2026-09-03). It needs Vite ≥6.4 and Node ≥22.12. Changes:
  - `clearMocks` now defaults to true.
  - No parent-directory config lookup.
  - `vi.mock` must be top-level.
  - The `bench` API was rewritten.
  - `test.sequential` was removed.
- **React 19.3, TanStack Query 5.108, Fastify 5.12 + @fastify/static 10 (`fastify:'5.x'`, `setHeaders` option).**
- **React Router 8.5** (8.0 released 2026-06-17).
  - ESM-only; needs React ≥19.2.7 and Node ≥22.22.
  - `react-router-dom` is removed: import `RouterProvider` from `react-router/dom` and everything else from `react-router`.
  - Middleware is always on.
  - For a plain SPA use data mode (`createBrowserRouter` + `<RouterProvider>`) without `@react-router/dev`.
  - If anything blocks you, 7.18.x is still maintained.
- No Node-26 incompatibilities found: every package's `engines` allows 26.

## 6. World map
- `world-atlas/countries-110m.json` is 108 KB (38 KB gzipped) with 177 features. `countries-50m.json` is 756 KB (230 KB gzipped) with 241 features.
- `geometry.id` is the ISO 3166-1 **numeric** code as a zero-padded string, e.g. `"004"`. `properties` only has `name`.
- Features with no id: N. Cyprus, Somaliland and Kosovo (in 110m and 50m), plus Indian Ocean Ter. and Siachen Glacier in 50m.
- 110m has no polygons for SG, AD, MT, BH, LI, MC, SM, VA, MV, MU or SC. Draw dots for those, or use 50m.
```ts
import { feature } from 'topojson-client'; import { geoEqualEarth, geoPath } from 'd3-geo';
import world from 'world-atlas/countries-110m.json';
const fc = feature(world as any, (world as any).objects.countries); const path = geoPath(geoEqualEarth().fitSize([w, h], fc));
```
- Types: `@types/topojson-client` 3.1.5 and `@types/d3-geo` 3.1.1. d3-geo is ESM.
- **Mapping:** use `numericToAlpha2()` from i18n-iso-countries (MIT; `codes.json` rows are `[alpha2, alpha3, numeric]`, 12 KB, includes XK→983), or generate a static ~250-row table from it. For names use built-in `new Intl.DisplayNames(['en'],{type:'region'})`, so no locale registration is needed.
- **Special codes:**
  - Kosovo has no atlas id: match `properties.name==='Kosovo'` → XK.
  - Lichess flags (checked against lila `Flags.scala`):
    - GB-ENG/SCT/WLS/NIR → GB
    - ES-AN/AR/AS/CT/EU/GA and IC → ES
    - CA-QC → CA
    - PT-20/PT-30 → PT
    - RU-BA/RU-TAT → RU
    - AM-RA: your choice
    - AN, EU, `_earth`, `_united-nations` and other `_…` codes → no country
  - Chess.com (probed `/pub/country/{code}`):
    - XE/XS/XW → GB
    - XB/XC/XG/XA → ES
    - XK → Kosovo
    - XT ("Chinese Taipei") → TW
    - XX (International), XO (Olympic) and XP (Paralympic) → none
- Licences: Natural Earth data is public domain, and world-atlas, topojson-client and d3-geo are ISC.

## Unverified
- Whether the Lichess `.pgn.zst` dumps need `windowLogMax > 27`; setting 31 is harmless.
- Real phone performance and memory of the MT builds.
- Whether a Vite `?url` import of the emscripten JS is emitted untouched; avoided by using `public/`.

**Sources:** [npm registry](https://registry.npmjs.org) · [chessground](https://github.com/lichess-org/chessground) · [chessops CHANGELOG](https://github.com/niklasf/chessops/blob/master/CHANGELOG.md) · [stockfish.js](https://github.com/nmrugg/stockfish.js) · [stockfish-web](https://github.com/lichess-org/stockfish-web) · [lila stockfishWebEngine.ts](https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/engines/stockfishWebEngine.ts) · [lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md) · [lila Flags.scala](https://github.com/lichess-org/lila/blob/master/modules/user/src/main/Flags.scala) · [Node sqlite.md v26.13.1](https://github.com/nodejs/node/blob/v26.13.1/doc/api/sqlite.md) · [Node zlib.md](https://github.com/nodejs/node/blob/v26.13.1/doc/api/zlib.md) · [Node typescript.md](https://github.com/nodejs/node/blob/v26.13.1/doc/api/typescript.md) · [TS 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) · [Vite 8 announcement](https://vite.dev/blog/announcing-vite8) · [Vite migration](https://vite.dev/guide/migration) · [Vitest migration](https://vitest.dev/guide/migration) · [React Router CHANGELOG](https://github.com/remix-run/react-router/blob/main/CHANGELOG.md) · [caniuse COEP credentialless](https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless) · [world-atlas](https://github.com/topojson/world-atlas)