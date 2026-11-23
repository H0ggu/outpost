# Can we lift Lichess's analysis board into Outpost?

**Short answer:** yes. Take the whole `ui/analyse` app, pin it to one commit, and add a thin shim layer (option A). It already runs in a pure-client mode, and this is the cheapest way to get a polished Studio.

**Source checked:** lila at commit `b071608bc4ce71b31cda36ffa493100e3dc3580f` (2026-11-22). It is a sparse, read-only clone at `/private/tmp/claude-501/-Users-hoggu-Documents-Github/1fce186a-5489-4f2e-95b2-846214e2658f/scratchpad/lila-src`, with `ui/` and `translation/source/`. No scripts or package installs were run. The import-closure counter I used is `/private/tmp/claude-501/-Users-hoggu-Documents-Github/1fce186a-5489-4f2e-95b2-846214e2658f/scratchpad/tools/deps.py`.

**Licence:**
- `COPYING.md` puts all of `ui/` under AGPL-3.0-or-later.
- chessground 10.5.0, chessops 0.15.1 and pgn-viewer 2.7.3 are GPL-3.0-or-later.
- `@lichess-org/stockfish-web` is AGPL-3.0-or-later.
- snabbdom and cash-dom are MIT.
- All of these are compatible with releasing our repo as AGPL-3.0-or-later.
- If we copy assets from lila's `public/`, leave out the CC BY-NC-SA ones:
  - piece sets: california, caliente, maestro, fresca, cardinal, icpieces, gioco, tatiana, staunty, dubrovny, anarcandy, disguised, cooke, monarchy, xkcd, minimal-warmth, chessboart, horsey
  - the lisp sounds
- These are fine to use: cburnett and merida (GPLv2+), staunton (MIT), letter and pirouetti (AGPL), and `images/board` (AGPL).

## 1. Package map

The layout has changed: `ui/ceval`, `ui/tree`, `ui/chess` and `ui/common` no longer exist. They were all merged into **`ui/lib`**.

**`ui/analyse/src`** (18.9k lines of code, of which `study/` is 9.0k)
- `ctrl.ts`: `AnalyseCtrl implements CevalHandler`, 1,125 lines.
- Entry points:
  - `start.ts`: `makeStart(patch)(opts)` uses `mountApp` on `main.analyse`.
  - `analyse.user.ts`: `initModule({mode, cfg})`, which calls `wsConnect('/analysis/socket/v5')`.
  - `boot.ts`: replay mode.
- Data and wiring:
  - `interfaces.ts`: `AnalyseOpts`, `AnalyseData`, `AnalysePref`.
  - `socket.ts`: the socket wrapper.
  - `evalCache.ts`: cloud eval.
  - `idbTree.ts`: saves the user's variations and collapsed lines in IndexedDB.
- `treeView/`: `treeView.ts`, `inlineView.ts`, `columnView.ts`, `contextMenu.ts` (574 lines).
- `explorer/`: `explorerCtrl.ts`, `explorerView.ts`, `explorerConfig.ts`, `explorerXhr.ts`, `tablebaseView.ts`, `explorerUtil.ts`, `interfaces.ts` (1,415 lines).
- PGN: `pgnImport.ts` (PGN to `AnalyseData`) and `pgnExport.ts`.
- Navigation: `keyboard.ts`, `navigate.ts`, `fork.ts`, `autoShape.ts`, `ground.ts`.
- Training features:
  - `retrospect/`: learn from mistakes.
  - `practice/`: practise with the computer.
  - `motif/`
  - `local/`: full-game review in the browser, which then POSTs to `/analysis/review`.
- `view/`: `main.ts`, `components.ts`, `tools.ts`, `controls.ts`, `actionMenu.ts`, `settingsView.ts`.

**`ui/lib/src`** (15.4k lines)
- **`ceval/`** (2,665 lines):
  - `ctrl.ts` (`CevalCtrl`) and `protocol.ts` (UCI).
  - `engines/`: `engines.ts` (engine registry), `stockfishWebEngine.ts`, `threadedEngine.ts`, `simpleEngine.ts`, `externalEngine.ts`.
  - `view/main.ts`: `renderGauge`, `renderCeval`, `renderPvs`, `renderCevalSwitch`.
  - `view/settings.ts` and `view/pvBoard.ts`.
  - `winningChances.ts`.
- **`tree/`** (577 lines): `makeTree(root): TreeWrapper`, `ops`, `path`, `node.completeNode`, and `types` (`TreeNode`, `ClientEval`, `ServerEval`).
- **`game/`**:
  - `glyphs.ts`: `annotationShapes`, built on `@lichess-org/chessground/glyph`.
  - `nodePGN.ts`: `renderNodesTxt`.
  - Also `chess.ts`, `promotion.ts`, `sanWriter.ts`.
- **`view/`**: snabbdom helpers (`hl`, `onInsert`, `bind`), `mountApp`, `dialog`, and a `jsx` factory.
- Supporting modules:
  - `storage.ts`, `pubsub.ts`, `i18n.ts`, `xhr.ts`.
  - `device.ts`: `features()` detects sharedMem, simd, relaxedSimd and similar.
  - `bigFileStorage.ts`: caches NNUE files in OPFS or IndexedDB.

**`ui/site/src/site.ts`** is only **36 lines**. It attaches `asset.ts`, `mousetrap.ts` (201 lines), `sound.ts`, `reload.ts` and `powertip.ts` onto `window.site`. That means we can write our own `site.ts` that reuses lila's modules directly.

**Other packages needed:** `ui/keyboardMove` and one file from `ui/editor`.

**Framework:**
- snabbdom, pinned to 3.5.1 (see snabbdom issue #1114).
- cash-dom as a global `$`.
- `.tsx` files use `jsxFactory: "jsx"` from `lib/view`, not React.

**Build:** a custom tool in `ui/.build/src`. We don't need it; Vite plus dart-sass can do the same jobs.
- esbuild 0.28 bundles the files matching `src/**/analyse.*ts`.
- sasso (Rust SCSS) plus lightningcss compile the styles.
- It generates `ui/lib/css/theme/gen/_wrap.scss`, which turns each `--c-x` CSS variable into a `$c-x` SCSS variable.
- It compiles the translation XML into `window.i18n.<cat>` JavaScript files.
- `$html` and `$trim` are compile-time macros.
- The path alias `@/*` points to `${configDir}/src/*`, so it means a different folder in each package.

## 2. How tightly it is tied to lila

**Input data.** `AnalyseOpts` contains:
- `element`, `data: AnalyseData`
- `explorer: {endpoint, tablebaseEndpoint, showRatings}`
- `socketSend`, `externalEngineEndpoint`, `hunter`
- optional: `inlinePgn`, `embed`, `chat`, `userId`, `$side`, `$underboard`

**`AnalyseData` can be built entirely in the browser.** `pgnImport(pgn)` returns:
- `game`: `{id:'synthetic', fen, initialFen, player, status:{id:20,name:'started'}, turns, variant}`
- `player`, `opponent`, `treeParts`, `sidelines`, `userAnalysis: true`

On top of that we add `orientation`, `takebackable: false`, `moretimeable: false` and `pref`. The `pref` fields are `coords`, `showDests`, `destination`, `highlight`, `rookCastle`, `animationDuration`, `keyboardMove` and `moveEvent` (enums in `lib/prefs.ts`). Alternatively we pass `inlinePgn`, and the constructor calls `changePgn` itself.

**WebSocket: a pure-client mode exists.** Legal moves are computed in the browser with chessops (`node.dests()`); `anaDests` no longer exists.
- The socket only *sends*:
  - `evalGet` / `evalPut`: cloud eval.
  - `startWatching`: only when the game is not synthetic.
  - `anaMove` / `anaDrop`: only inside a study.
- It only *receives* `evalHit`, `analysisProgress` and `fen`.
- **Shim:** answer `evalGet` by calling `GET https://lichess.org/api/cloud-eval?fen=…&multiPv=…`, then `ctrl.socket.receive('evalHit', {...json, path})`. Everything else becomes a no-op. Whether the cloud-eval endpoint still works without a token is UNVERIFIED.

**Globals the code expects.** Uses inside `analyse` (excluding study):
- **`site`:**
  - `blindMode` (9 uses)
  - `asset.loadEsm` for `analyse.nvui`, `chart.game`, `analyse.local` and `analyse.gifDialog`
  - `sound.{move,play,saySan,preloadBoardSounds}`
  - `mousetrap.bind/unbind`
  - `asset.url`, `fideFedSrc`, `redirect`, `reload`, `debug`, and an assignment to `site.analysis`
- **`site` in lib:**
  - `storage.ts` needs `site.sri`.
  - The engine files need `site.asset.url` (also `loadIife` for the threaded engine).
  - `dialog` uses `loadCss`.
  - `view/snabbdom.ts` uses `loadI18n`.
- **`i18n`:** catalogs `site`, `preferences`, `study`, `nvui`, `broadcast`, `team`, `variant` and `timeago`, plus `localAnalysis` and `keyboardMove`. The English sources are in `translation/source/*.xml`.
- **`$` (cash-dom):** 41 call sites in 13 analyse files, plus 10 lib view files.
- **`$html` / `$trim`:** used in 6 files. A runtime shim that joins the template strings is enough.
- **`window.lichess = {}`:** required, because `registerPublicApi` writes to it and crashes if it is undefined.
- **`document.body` attributes:**
  - `data-asset-url`, `data-asset-version`, `data-user`, `data-board`
  - piece CSS variables `---white-pawn` and so on, set on `body`

**Server endpoints it calls**, all optional or patchable:
- `/analysis/help` (the keyboard "?" help)
- `/analysis/review` (local review)
- `/api/external-engine`, `/pref/*`
- `changeFen` redirects to `/analysis/<variant>/<fen>`
- action-menu links to `/editor` and `/study`

**Opening explorer.** `explorerXhr` builds the URL as `new URL('./'+db, endpoint)` and sends `credentials: 'include'`. Lichess announced that **the opening explorer now requires authentication** (an OAuth token on each request). So point `opts.explorer.endpoint` at our own server proxy, `${origin}/api/explorer/`, which adds `Authorization: Bearer lip_…`. No code patch is needed. The production host name (explorer.lichess.ovh or .org) and whether the tablebase still works without a token are UNVERIFIED.

**CSS** has three entry files:
- `ui/site/css/build/site.scss`: global `html`, `body`, `a` and `button` styles, plus the chessground board theme.
- `ui/lib/css/build/lib.theme.all.scss`: font faces, the dark (`:root`), `html.light` and transp themes, and pieces.
- `ui/analyse/css/build/analyse.free.scss`

To compile them:
- Generate `gen/_wrap.scss` (a short port of `buildColorWrap`, `.build/src/sass.ts:188`).
- Asset URLs are relative (`../font/…`, `../images/board/…`) or absolute (`/assets/images/buttons/…`). Serve the CSS at `/assets/css/` and lila's `public/` subset at `/assets/{font,images,piece,sound}`.
- The SCSS uses `@import`. dart-sass 1.108.2 still accepts it if we silence the `import` deprecation.
- The DOM needs `#main-wrap.is2d > main.analyse`, with `body[data-board=…]` for the board theme. On the OLED setup, override `--c-bg-page` and friends to true black.

**Size of option A:** 186 runtime TypeScript files, about 26.9k lines, vendored unchanged, plus about 235 SCSS files (about 20k lines). New code is about 250–350 lines:

| Piece | Approx. lines |
|---|---|
| `site-shim.ts` (reuses lila's asset/mousetrap/sound/reload; replaces `loadEsm` with a map of dynamic imports; sets `site.manifest={css:{},js:{},hashed:{}}`, `site.load`, `blindMode=false`) | ~80 |
| Translation XML to JS generator (port of `writeJavascript` in `.build/src/i18n.ts`) | ~60 |
| `_wrap.scss` generator | ~20 |
| Vite resolver plugin (`lib`, `lib/*` to `lib/src`, `keyboard-move` to `keyboardMove/src/exports.ts`, `@/x` to the importer's own `src`) | ~30 |
| `socketSend` shim | ~30 |
| Mount wrapper | ~60 |

Upstream patches needed: about 5–8 lines, covering `changeFen`, `site.redirect('/analysis')`, the help URL, and a `/** @jsx jsx */` pragma in `local/localAnalysisDialog.tsx`.

## 3. Existing standalone extractions

**There are none that are maintained.** GitHub search turns up:
- dozens of full lila forks;
- ports to other games (`WandererXII/lishogi`, which has `ui/embed/src/analyse`; lidraughts);
- unlicensed copies of the whole `ui/` folder inside other apps (for example `tsion-corp/tsionmarket-frontend`, which has no licence and is not something to learn from).

The closest polished alternative is **GuillaumeSD/Chesskit**: AGPL-3.0, 441 stars, active on 2026-11-21, built with Next.js and React. It has its own board and Stockfish, and none of lila's code.

Lichess only publishes these pieces as reusable packages: chessground, chessops, pgn-viewer and stockfish-web.

## 4. Reusing smaller pieces

**ceval: reusable as-is.**
- Three controllers already host it through the `CevalHandler` interface:
  - `AnalyseCtrl`
  - `PuzzleCtrl` (`ui/puzzle/src/ctrl.ts:48`, constructed at `:115`)
  - `EditorCtrl` (`ui/editor/src/ctrl.ts:38`, constructed at `:125`)
- Runtime closure: 42 files, about 5.8k lines, mostly from the lib index files, and tree-shaken in the build.
- API:
  - `new CevalCtrl({variant, initialFen, emit(ev, meta), onUciHover, redraw, externalEngines?, custom?})`
  - `ceval.start(path, steps, threat)`
  - `view.renderGauge`, `renderCeval`, `renderPvs`, `winningChances.povChances`
- Engine files:
  - Served at `/assets/npm/stockfish-web/{sf_19_smallnet,sf_19,fsf_14}[_relaxed-simd].{js,wasm}`.
  - lila pins version **0.5.0**. Version 0.6.1 was published on 2026-11-21; whether it is compatible is UNVERIFIED.
- NNUE files:
  - Loaded from `/assets/lifat/nnue/<module.getRecommendedNnue(i)>`.
  - Serve them through a caching proxy to `tests.stockfishchess.org/api/nn/<name>`. The README names `nn-1a298aa575a0` for sf_19 and `nn-61e7af4bb97d` for the smallnet.
- Cross-origin isolation:
  - It **needs `crossOriginIsolated`**: send `COOP: same-origin` and `COEP: require-corp` (or `credentialless`) on the Studio page.
  - Without it, it falls back to Stockfish 10 in plain JavaScript (the `stockfish.js` package).

**tree:** easy. 577 lines and stable (29 commits in the last 12 months).
- Import from `lib/tree/tree` and `lib/tree/ops` directly.
- `TreeWrapper` provides `addNode`, `nodeAtPath`, `getNodeList`, `deleteNodeAt`, `promoteAt`, `forceVariationAt`, `setCommentAt`, `setGlyphsAt`, `setShapes` and `merge`.
- `completeNode` fills in legal moves.

**treeView:** not separable as it stands.
- It imports `@/view/components` for `renderMoveNodes` and `renderIndex`, and that pulls in 151 files (21k lines, including study).
- To vendor it we would copy those two helpers (about 30 lines) and then provide about 35 `AnalyseCtrl` members, such as:
  - `idbTree.discloseOf`, `visibleChildren`, `settings.disclosureMode`
  - `pendingCopy`, `contextMenuPath`
  - `promote`, `deleteNode`, `forceVariation`, `userJump`

**explorer:** feasible with an adapter.
- 7 files (1.4k lines); with dependencies, 44 files.
- Uses about 25 `AnalyseCtrl` members, such as:
  - `node`, `nodeList`, `data.game`, `synthetic`, `bottomColor`
  - `explorerMove`, `setAutoShapes`, `fork.hover`, `chessground.state`

**Eval gauge:** trivial: `renderGauge` plus `lib/css/ceval/_eval-gauge.scss`.

**PGN:** easy.
- `pgnImport.ts` is 98 lines and depends only on chessops and `lib/tree/node`.
- Export uses `lib/game/nodePGN.ts` and `analyse/src/pgnExport.ts`.

**Keyboard navigation:** easy to rewrite: `navigate.ts` (54 lines) and `fork.ts` (121 lines), plus lila's `site/src/mousetrap.ts`.

## 5. Options

| Option | Effort | What we get |
|---|---|---|
| **A** Vendor the whole `ui/analyse` + `lib` + `keyboardMove` + `site` modules, pinned, with shims | **2–3 days** to a working Studio | Everything Lichess has: board; move tree with variations, context menu, glyphs and comments; ceval with engine picker, multi-PV and threat mode; explorer (masters, lichess, player) and tablebase; practise with the computer; learn from mistakes; keyboard shortcuts; PGN/FEN import and export; saved variations; settings |
| **B** Vendor selected modules (lib ceval/tree/game/view, `explorer/*`, `treeView/*` with patched imports, `pgnImport/Export`, `navigate`, `fork`, `keyboard`, `autoShape`, `ground`) and write our own controller | 4–7 days | We end up rewriting about half of `ctrl.ts` to satisfy the treeView and explorer duck types. More integration bugs, and no real advantage over A |
| **C** Build our own Studio on chessground + chessops + stockfish-web (+ pgn-viewer for read-only replays), styled with lila's SCSS | 1.5–3 weeks to match A | Full control. A hybrid that also reuses `lib/ceval`, `lib/tree` and `pgnImport` still takes 1–2 weeks |

**Recommendation: A.** It is the easiest route to a polished Studio, because the synthetic/`userAnalysis` mode is already fully client-side.

**Steps for A:**
1. Copy `ui/{analyse,lib,keyboardMove,site/src,editor/src,@types/lichess}` into `vendor/lila/`. Record the commit and `COPYING.md` in `vendor/lila/NOTICE`.
2. Use snabbdom 3.5.1 and `@lichess-org/chessground@10.5.0`. Add `cash-dom`, `@badrap/result`, `debounce-promise`, `idb-keyval` and `tablesort`.
3. Add the Vite resolver plugin, exclude `vendor/` from our `tsc`, and add the `/** @jsx jsx */` pragma to the `.tsx` file.
4. Generate the translation JS and `_wrap.scss`. Compile the 3 SCSS entries with dart-sass. Sparse-checkout the `public/` subset we need (`font`, `images/board`, `images/buttons`, `piece/cburnett`, `sound`).
5. Server work:
   - `/assets` static files plus the NNUE caching proxy
   - COOP/COEP headers
   - the explorer proxy with a token
   - optional: a cloud-eval passthrough and a static `/analysis/help`
6. Mount it: React renders `<div id="main-wrap" class="is2d"><main class="analyse"/></div>` once, then calls `makeStart(patch)(opts)` with `socketSend` set to our shim.

**Main risks:**
- **Upstream churn.** In the last 12 months there were **1,173 commits to `ui/analyse`**, 193 to `lib/ceval`, 72 to the explorer and 52 to treeView. The package layout has also been reshuffled before. Pin the commit, never merge upstream, and re-vendor deliberately when needed.
- **No `destroy()` on `AnalyseCtrl`.** Mousetrap bindings, pubsub, `hashchange` and storage listeners all stay behind. Mount it once per page load: either a full-page route, or its own Vite page (`studio.html`).
- **Global CSS.** `site.scss` styles `html`, `body`, `a` and `button`. Either use lila's base CSS across the whole app, so all of Outpost gets the Lichess look and React components reuse lila class names (`.box`, `.button`, `.slist`), or keep the Studio on its own HTML page.
- **Study code comes along.** About 9k lines of study code are dead weight. Trimming 3 static imports in `view/main.ts` and `treeView/inlineView.ts` removes about 6k lines from the bundle. The type imports can stay.
- **Local full-game review needs a server.** It POSTs to `/analysis/review`, which lila answers on the server in Scala (move judgments and accuracy). We would have to reimplement that on our server or turn the feature off.
- **Snabbdom inside React is fine** as long as React never re-renders the host `div` (use `useEffect` once and memoise the component).

Sources:
- [lichess-org/lila](https://github.com/lichess-org/lila)
- [Lichess source index](https://lichess.org/source)
- [The opening explorer now requires authentication](https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3)
- [GuillaumeSD/Chesskit](https://github.com/GuillaumeSD/Chesskit)
- [lila issue #19610](https://github.com/lichess-org/lila/issues/19610), which reports the explorer host unresponsive around Feb 2026 (UNVERIFIED)