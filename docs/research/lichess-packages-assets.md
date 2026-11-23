# Lichess reusable packages and assets: vendor notes for Outpost

**Sources read:**
- lila @ `b071608` (2026-11-22)
- pgn-viewer @ `1c9b707` (2026-10-15)
- chess-openings @ `48a8c0e` (2026-11-20)
- The npm tarballs listed below

Nothing from these sources was built or run. Local copies, all under `/private/tmp/claude-501/-Users-hoggu-Documents-Github/1fce186a-5489-4f2e-95b2-846214e2658f/scratchpad/`:
- `v-lila-assets/lila` (sparse checkout)
- `v-pgnviewer/pgn-viewer`
- `v-chessground/chessground`
- `v-openings/chess-openings`
- `v-tarballs/x/*` (the extracted npm packages)

**Licence status:** every package and asset recommended below can be combined with AGPL-3.0-or-later. GPLv3 §13 allows combining with AGPLv3, and GPLv2+ material can be taken under v3.

---

## 1. `@lichess-org/pgn-viewer` 2.7.3

- **Licence:** GPL-3.0-or-later.
- **Published:** 2026-10-07.
- **Old name:** the unscoped `lichess-pgn-viewer` (2.4.5) is the previous name and has been abandoned.
- **Dependencies:** `@lichess-org/chessground ^10.4.2`, `chessops ^0.15.1`, `snabbdom 3.5.1` (pinned exactly, MIT).
- **Install:** `npm i @lichess-org/pgn-viewer@2.7.3`

**What is in the package:**
- `dist/main.js`: ESM, imports chessground, chessops and snabbdom as peers, so a bundler dedupes them with ours.
- `dist/lichess-pgn-viewer.min.js`: a standalone bundle.
- `dist/lichess-pgn-viewer.css`: the prebuilt stylesheet. It includes chessground base CSS, a "transp" board and the embedded cburnett pieces, plus its own icon font (`lpv-fontello`) as a data URI.
- `scss/`: the SCSS sources.

**CSS import problem (inferred from the exports map, not tried in a Vite build):** the exports map has `"./*": "./dist/*.js"`, so `import '@lichess-org/pgn-viewer/dist/lichess-pgn-viewer.css'` resolves to `dist/dist/...css.js` and fails. Fix it with a Vite alias to the absolute file:

```js
resolve:{alias:{'lpv-css':fileURLToPath(new URL('./node_modules/@lichess-org/pgn-viewer/dist/lichess-pgn-viewer.css',import.meta.url))}}
```

Then `import 'lpv-css'`. Lila does the equivalent with a relative `@import '../../../../node_modules/@lichess-org/pgn-viewer/scss/lichess-pgn-viewer.lib'`.

**You must set `--board-color`.** The bundled board is `background-color: var(--board-color)` with no fallback, so without it the board has no square colour. The demo uses `#886f46`. Alternatively, override `cg-board` with a lila board image.

**API** (`src/main.ts`, `src/pgnViewer.ts`):

```ts
import LichessPgnViewer from '@lichess-org/pgn-viewer';
const lpv = LichessPgnViewer(el, opts); // returns PgnViewer
```

Config defaults (`src/config.ts`):

| Option | Default / values |
|---|---|
| `pgn` | `'*'` |
| `fen` | prepends `[FEN]` to the PGN |
| `showPlayers` | `'auto'`, or true/false |
| `showClocks` | `true` (reads `[%clk]`) |
| `showMoves` | `'auto'`, or `false`/`'right'`/`'bottom'` |
| `showControls` | `true` |
| `maxGlyphs` | `4` (NAG glyphs drawn on the board; 0 = off) |
| `showRepetitions` | `true` |
| `scrollToMove` | `true` (mouse wheel) |
| `keyboardToMove` | `true` (←, →, `f` flips) |
| `orientation` | `undefined` means use the PGN `Orientation` tag |
| `initialPly` | number or `'last'` |
| `chessground` | `{}`, merged into the chessground config |
| `drawArrows` | `true` (false is slightly faster) |
| `menu` | `{getPgn:{enabled,fileName}, practiceWithComputer:{enabled}, analysisBoard:{enabled}}` |
| `lichess` | `'https://lichess.org'`, or `false` to turn off game and player links |
| `classes` | defaults to the element's existing `className` |
| `translate` | `(key,...args)=>string` |

- **Always view-only.** `movable`, `draggable` and `selectable` are forced off. It is not suitable for the Studio's interactive board.
- **Hard-coded lichess.org links.** `analysisUrl` always points to `https://lichess.org/analysis/...`. For Chess.com games, set `lichess:false`, `menu.practiceWithComputer.enabled:false` and `menu.analysisBoard.enabled:false`.

**Controller members:**
- `game`: `mainline`, `metadata`, `nodeAt(path)`, `pathAtMainlinePly(ply|'last')`
- `path`
- `ground` (the chessground API)
- `div`
- `goTo('first'|'prev'|'next'|'last')`
- `canGoTo()`
- `toPath(path, focus=true)`
- `flip()`
- `orientation()`
- `curData()`: `{fen, turn, check, comments, shapes, clocks, path, ply, san, uci, nags, emt}`
- `curNode()`
- `toggleMenu()`, `togglePgn()`

`Path` can be imported from `@lichess-org/pgn-viewer/path` (exports `./*` maps to `dist/path.js`).

**No change-event callback.** Hook it this way: `toPath` is an instance arrow property, and `goTo`, keyboard, wheel and move clicks all call `this.toPath`. So:

```ts
const o = lpv.toPath;
lpv.toPath = (p,f) => { o(p,f); onMove(lpv.curData()); };
```

`flip` does not go through `toPath`.

**Variations and comments** (`src/view/side.ts`):
- Mainline: a two-column grid of `index` + `button.move[data-path]`.
- Each sideline from the mainline: a block `<variation>` element.
- Nested lines: inline inside `paren.open`/`paren.close`.
- `{comments}`: rendered as `<comment>` elements.
- `[%csl]`/`[%cal]`: drawn as board shapes.
- NAGs: drawn as glyphs on the board.

**Embedding many on one page:** call it once per element (the demo loops over elements). Lazy-initialise with IntersectionObserver, which is my suggestion and not something the library does.

**React wrapper — watch out:** `start()` runs snabbdom `patch(element, …)`, which replaces the host element. Create a child imperatively:

```ts
const host = document.createElement('div');
ref.current.append(host);
LichessPgnViewer(host, cfg);
```

On unmount, call `ref.current.replaceChildren()`.

**Theming:** override the `--c-lpv-*` custom properties: accent, accent-over, bg, bg-player, bg-controls, bg-movelist, bg-variation, bg-pane, pgn-text, font, font-shy, font-bg, past-moves, current-move, move-hover, border, side-border, fbt-hover, the inaccuracy/mistake/blunder/good-move/brilliant/interesting colours and their `bg-*-hover`/`bg-*-current` variants. Lila's own mapping is in `ui/lib/css/component/_pgn-viewer.scss`:
- `--c-lpv-accent: var(--c-primary)`
- `--c-lpv-bg: var(--c-bg-zebra)`
- `--c-lpv-bg-variation: var(--c-bg-zebra2)`
- `--c-lpv-current-move: color-mix(in oklab, var(--c-primary) 70%, var(--c-bg))`
- `--c-lpv-move-hover`: the same mix at 30%

## 2. chessground: `@lichess-org/chessground` 10.5.0

- **Licence:** GPL-3.0-or-later. The unscoped `chessground` (9.2.1) is the old name.
- **Usage:** `import { Chessground } from '@lichess-org/chessground'`. Types are importable as `@lichess-org/chessground/config`, `/api` and `/types`.
- **CSS:** exports include `"./assets/*"`, so these imports work directly:
  - `import '@lichess-org/chessground/assets/chessground.base.css'`: layout, square highlights, coords, shapes.
  - `.../chessground.brown.css`: the brown board as an embedded SVG on `#f0d9b5`, plus move-dest, last-move and check colours.
  - `.../chessground.cburnett.css`: the 12 cburnett pieces as base64 SVGs on `.cg-wrap piece.<role>.<color>`.

**How lila themes the board:**
- **Board image:** `body[data-board='<name>'] .is2d cg-board::before{background-image:url(../images/board/<file>)}` (`ui/lib/css/theme/board/_board-2d.scss`). Coordinate colours come from `---cg-ccw`/`---cg-ccb` per board, mapped in `ui/lib/css/theme/board/_boards.scss`.
- **Pieces:** `.is2d .pawn.white{background-image:var(---white-pawn)}` and so on (`ui/lib/css/theme/_pieces.scss`). The variables are set per piece set:
  - server side as `:root{---white-pawn:url(.../piece/<set>/wP.svg)}` (`modules/web/src/main/ui/PieceSetImages.scala`)
  - client side with `document.body.style.setProperty(...)` (`ui/dasher/src/piece.ts`)
- **Highlights** (`ui/lib/css/theme/board/_chessground.scss`):
  - last-move: `rgb(155 199 0/.41)`
  - selected: `rgb(20 85 30/.5)`
  - move-dest: `radial-gradient(rgb(20 85 30/.5) 19%, transparent 20%)`

**Recommendation for Outpost:**
1. Import `chessground.base.css`.
2. Add our own `pieces.css` copying the lila variable pattern: `.cg-wrap piece.pawn.white{background-image:var(--white-pawn)}` ×12, with the variables set from JS when the user picks a set.
3. Add `boards.css` with `.cg-wrap cg-board{background-image:url(/lichess/board/brown.png);background-size:cover}`.

## 3. Lila public assets (licences from `COPYING.md`)

The default for anything in lila not listed as an exception is AGPLv3+ ("lila authors").

### Piece sets
All sets are 12 SVGs named `wP wN wB wR wQ wK bP…bK.svg`. Exceptions: `mono` has 6 files (`P.svg…`), and `monarchy` is webp.

**Use (free and compatible):**

| Set | Licence |
|---|---|
| **cburnett** (lichess default) | GPLv2+ (Colin M.L. Burnett) |
| **merida** | GPLv2+ |
| mono | GPLv2+ (has only 6 files) |
| **chessnut** | Apache-2.0 |
| **fantasy**, **spatial**, **celtic** | MIT (Maurizio Monge) |
| **kiwen-suwi**, **firi**, papercut, **totoy** | CC BY 4.0 |
| **rhosgfx** | CC0 |
| shapes | CC BY-SA 4.0 (one-way compatible with GPLv3) |
| **mpchess** | GPLv3+ |
| letter, pirouetti, pixel | AGPLv3+ |
| governor, kosal | not listed in COPYING, so the AGPLv3+ default applies (UNVERIFIED: the SVGs carry no metadata) |

**Do not use:**
- **alpha**: "free for personal non commercial use".
- **california**: CC BY-NC-SA.
- All CC BY-NC-SA sets: anarcandy, caliente, cardinal, chessboart, cooke, disguised, dubrovny, fresca, gioco, horsey, icpieces, maestro, minimal-warmth, monarchy, staunty, tatiana, xkcd (NC 2.5).
- chess7, companion, leipzig: "freeware" with no right to modify.
- reillycraig, riohacha: no licence.
- shahi-ivory-brown: no-derivatives licence.

**Recommended shipping subset:** cburnett, merida, chessnut, fantasy, spatial, celtic, kiwen-suwi, firi, rhosgfx, mpchess, pixel, letter.

### Board themes
`public/images/board` is AGPLv3+ ("lila authors and pirouetti"). The one exception is `svg/chessboart.svg`, which is NC — exclude it.

Available files:
- PNG: blue, brown, green, green-plastic, ic, pink-pyramid, purple, purple-diag
- JPG: blue2, blue3, blue-marble, canvas2, wood, wood2, wood3, wood4, maple, maple2, leather, marble, grey, metal, olive, horsey (+ `horsey.*.png` overlays)
- SVG: `svg/newspaper.svg`

Each has a `<name>.thumbnail.<ext>` version for a picker. The `.orig.jpg` files are not needed. Coordinate colours: copy the map from `_boards.scss`, e.g. brown `#f0d9b5`/`#946f51`, blue `#dee3e6`/`#788a94`, green `#ffd`/`#6d8753`. Boards listed in that SCSS (wood-worn, putt-putt, cocoa, parchment) are not in `public/images/board`.

**Suggested set:** brown, blue, green, wood4, maple, olive, grey, blue3, purple, ic.

### Sounds
Lila now plays `.mp3` only: `${set}/${Name}.mp3` (`ui/site/src/sound.ts`). `.ogg` files also exist. Each set has Move, Capture, Check, Checkmate, GenericNotify, Confirmation, Berserk, CountDown0–10, Defeat, Draw, Victory, Error, Explosion, LowTime, NewChallenge, NewPM, OutOfBound and Tournament*.

- **Free:** `sfx`, `piano`, `nes`, `futuristic` (Enigmahack, AGPLv3+). COPYING spells the path `public/sounds/`; this is a typo for `public/sound/`.
- **Not free:**
  - `standard` (the classic lichess sounds), `robot`, `woodland`, `instrument` and `other` all fall under "The other sounds in public/sound" in the non-free section.
  - `lisp` is NC.

**Copy with `cp -L` — many files are git symlinks:**
- `Checkmate` → `Check`
- `Confirmation` → `sfx/GenericNotify`
- In sfx, piano and nes, `Error.mp3` and `OutOfBound.mp3` → `../standard/…`, which is non-free. Skip those two.

**Suggested files:** `{sfx,piano,nes}/{Move,Capture,Check,GenericNotify}.mp3`.

If the owner wants the classic `standard` sounds, keep them local and gitignored; do not commit them.

### Fonts (`public/font`)

| File | What it is | Licence |
|---|---|---|
| `lichess.woff2` | icon font | OFL / MIT / CC BY 3.0 / AGPLv3+ mix (Font Awesome, Octicons, Webalys, Zurb, Entypo, Steadysets, Linecons, lichess) |
| `lichess-chess.woff2` | family `'Noto Chess'`, SAN figurines | COPYING says pgn4web GPLv2+ (it lists the stale name `lichess.chess.*`); the .sfd says "Noto Sans, Copyright 2012 Google". Free either way. |
| `noto-sans-{latin,latin-ext,cyrillic,…}.woff2` | Noto Sans | Apache-2.0 per COPYING |
| `roboto-*.woff2` | Roboto | Apache-2.0 per COPYING |

How icons are referenced:
- The font face is defined in `modules/web/src/main/ui/layout.scala`: `@font-face{font-family:'lichess';font-display:block;src:url(font/lichess.woff2)}`.
- Markup uses `<i data-icon="">` with CSS `[data-icon]::before{content:attr(data-icon);font-family:lichess;font-size:1.2em;vertical-align:middle}` (`ui/lib/css/base/_data-icon.scss`, `%data-icon` in `abstract/_extends.scss`).
- Names map to codepoints in `ui/lib/src/licon.ts` (generated, AGPL): `licon.Book`=U+E03B, `Microscope` E01F, `Search` E057, `Gear` E005, `JumpFirst/Prev/Next/Last` E035/E037/E036/E034, `BarChart` E05F, `Trophy` E045, `Bullet` E032, `FlameBlitz` E008, `Rabbit` E002, `Turtle` E00A.
- An SCSS twin is `ui/lib/css/abstract/_licon.scss`.
- Font stacks (`abstract/_extends.scss`): body `'Noto Sans', sans-serif`; headings `Roboto` weight 300; SAN `'Noto Chess','Noto Sans'`. Copy the `@font-face` blocks and unicode-ranges from `ui/lib/css/theme/_font-face.scss`.

## 4. Look and feel tokens

`ui/lib/css/theme/_theme.default.scss` is the dark theme: CSS custom properties on `:root`, with `---site-hue: 37deg`. `_theme.transp.default.scss` (`html.transp`) and `_theme.light.scss` override them.

Dark values, converted to hex:

| Token | Hex |
|---|---|
| `--c-bg-page` | `#161512` |
| `--c-bg` (box) | `#262421` |
| `--c-bg-mid` | `#2c2926` |
| `--c-bg-low` / popup | `#3c3934` |
| `--c-bg-zebra` | `#33312e` |
| `--c-bg-zebra2` | `#403e3a` |
| `--c-bg-variation` | `#282724` |
| `--c-body-gradient` | `#2e2a24` |
| `--c-font` | `#bababa` |
| `--c-font-dim` | `#949494` |
| `--c-font-dimmer` | `#6b6b6b` |
| `--c-primary` (link blue) | `#3692e7` |
| `--c-secondary` / `--c-good` (green) | `#629924` |
| `--c-accent` (orange) | `#d64f00` |
| `--c-bad` | `#cc3333` |
| `--c-brag` (gold) | `#bf811d` |
| `--c-border` | `#404040` |
| `--c-border-page` | `#383838` |
| inaccuracy | `#53b2ea` |
| mistake | `#e69d00` |
| blunder | `#df5353` |
| brilliant | `#21c43a` |
| interesting | `#f075e1` |

- **Body background:** `background:var(--c-bg-page) linear-gradient(to bottom,var(--c-body-gradient),var(--c-bg-page) 116px) no-repeat` (`ui/lib/css/base/_elements.scss`).
- **Transparent theme:** `--c-bg: hsl(0 0% 0%/.6)`, `--c-bg-zebra: hsl(0 0% 100%/.05)`, `--c-bg-zebra2: …/.1`, `--c-bg-variation: hsl(0 0% 0%/.25)`.
- **Explorer win/draw/loss bar** (`ui/analyse/css/explorer/_explorer.scss`):
  - `.white`: `#ccc` with text `#222`
  - `.draws`: `#666` with text `#ddd`
  - `.black`: `#333` with text `#ddd`
  - Light theme: `#fff` / `#a0a0a0` / `#555`
  - Spans are 16px high with inset shadows. A percentage label shows only when the share is over 12%, with a `%` sign only over 20%.
- **True-black OLED variant** (my suggestion, not from lila): `--c-bg-page:#000; --c-bg:#000; --c-bg-mid:#0a0a0a; --c-bg-low:#141414; --c-bg-zebra:#0d0d0d; --c-bg-zebra2:#161616; --c-bg-variation:#050505; --c-body-gradient:#000; --c-border:#222`. Keep the font, primary and accent colours as they are.

## 5. Other reusable Lichess data and code

**lichess-org/chess-openings** (CC0, 3,865 rows):
- Files: `a.tsv`–`e.tsv`, tab-separated with header `eco	name	pgn`, e.g. `A00	Amar Opening	1. Nh3`.
- The `uci` and `epd` columns exist only in the built `dist/` (`bin/gen.py` uses python-chess `board.epd()`, which writes the en passant square only when an en passant capture is legal).
- JS equivalent: replay the SAN with chessops `parseSan`/`play`, then `makeFen(pos.toSetup(), {epd:true})`. `toSetup()` already uses `legalEpSquare`, so the output matches python-chess.
- To classify a game: walk back through its positions until one matches a named EPD.
- Also published as Parquet at hf.co/datasets/Lichess/chess-openings.

**scalachess:** Scala/JVM only, with no JS build on npm. Use chessops, the same author's TypeScript chess library, instead.

**Opening explorer UI:** Lichess publishes no standalone package. It lives in lila under `ui/analyse/src/explorer/` (`explorerView.ts`, `explorerCtrl.ts`, `explorerConfig.ts`, `tablebaseView.ts`), is AGPL, and is tied to AnalyseCtrl and snabbdom. Port the markup:
- `table.moves`: th Move | Games (colspan 2) | White/Draw/Black, then `tr[data-uci]` rows plus a final `tr.sum` "Σ" row.
- `resultBar()`: `div.bar > span.white|draws|black` with `style="width:x%"`.
- Copy the CSS.

**Other lila code worth porting (AGPL):**
- `ui/lib/src/ceval/protocol.ts` (UCI protocol, 238 lines)
- `ui/lib/src/ceval/winningChances.ts`
- `ui/lib/src/ceval/engines/stockfishWebEngine.ts`
- `ui/lib/src/tree/{node,ops,path}.ts` and `ui/analyse/src/treeView/` (move tree)

**`@lichess-org/types` 2.0.180** (AGPL-3.0-or-later, types only, generated from OpenAPI):

```ts
import type { components, paths } from '@lichess-org/types';
// components['schemas']['OpeningExplorerLichess' | 'OpeningExplorerMasters' | 'OpeningExplorerPlayer' | 'GameJson' | 'UserExtended' | 'PerfStat' | 'RatingHistory']
```

**`@lichess-org/stockfish-web` 0.6.1** (AGPL-3.0-or-later, 2026-11-21):
- Flavours, each a `.js` + `.wasm` pair: `sf_19_smallnet`, `sf_19`, `sf_dev`, each with a `_relaxed-simd` variant, plus `fsf_14` (Fairy-Stockfish, for variants).
- NNUE network files are not included. Load them with `module.setNnueBuffer(bytes, index)` using the filenames from `module.getRecommendedNnue(i)`. The README lists smallnet `nn-61e7af4bb97d.nnue` and sf_19 `nn-1a298aa575a0.nnue`, both from tests.stockfishchess.org/api/nn/. Lila serves them from `lifat/nnue/`.
- Boot: `(await import(url)).default({wasmMemory: new WebAssembly.Memory({shared:true, initial, maximum}), locateFile, mainScriptUrlOrBlob})`.
- Requirements: SharedArrayBuffer, SIMD and dynamic import from a worker. SharedArrayBuffer means the server must send COOP `same-origin` and COEP `require-corp` or `credentialless`.
- **Which build lila uses, from `ui/lib/src/ceval/engines/engines.ts`:** desktop and mobile get the same default, `__sf_19_smallnet` ("SF 19 · 1MB", `preferred:true`, auto-swapped to `_relaxed-simd` when the browser supports it). The choice is by feature detection, not device type. The 94MB `sf_19` is opt-in. Mobile only lowers max hash: Android 64MB, iPad 64MB, iOS 32MB, desktop 512MB. Threads default to `navigator.hardwareConcurrency`.

---

## Vendor list

**npm (exact versions):**
- `@lichess-org/chessground@10.5.0` (GPL-3.0+)
- `chessops@0.15.1` (GPL-3.0+)
- `@lichess-org/pgn-viewer@2.7.3` (GPL-3.0+; brings `snabbdom@3.5.1`, MIT)
- `@lichess-org/stockfish-web@0.6.1` (AGPL-3.0+)
- `-D @lichess-org/types@2.0.180` (AGPL-3.0+)

**Copied files:** fetch them with our own script `scripts/vendor-lichess.sh` (`git clone --depth 1 --filter=blob:none --sparse` of lila, checkout `b071608bc4ce71b31cda36ffa493100e3dc3580f`, `cp -L`), then commit the copies.

| From (lila) | To (Outpost) | Licence |
|---|---|---|
| `public/piece/{cburnett,merida,chessnut,fantasy,spatial,celtic,kiwen-suwi,firi,rhosgfx,mpchess,pixel,letter}/*.svg` | `web/public/lichess/piece/<set>/` | per the piece-set table |
| `public/images/board/{brown,blue,green,purple,ic}.png`, `{wood4,maple,olive,grey,blue3}.jpg`, plus each `.thumbnail.*` | `web/public/lichess/board/` | AGPLv3+ |
| `public/sound/{sfx,piano,nes}/{Move,Capture,Check,GenericNotify}.mp3` | `web/public/lichess/sound/<set>/` | AGPLv3+ (Enigmahack) |
| `public/font/{lichess,lichess-chess,noto-sans-latin,noto-sans-latin-ext,roboto-latin,roboto-latin-ext}.woff2` | `web/public/lichess/font/` | see the font table |
| `ui/lib/src/licon.ts` | `web/src/lichess/licon.ts` | AGPLv3+ |
| Tokens hand-ported from `ui/lib/css/theme/_theme.default.scss`, `board/_boards.scss`, `explorer/_explorer.scss`, `component/_pgn-viewer.scss` | `web/src/styles/lichess-theme.css` | AGPLv3+ |
| chess-openings `{a..e}.tsv` @ `48a8c0e` | `server/data/openings/` | CC0 |

**Attribution text for NOTICE / README:**

> Outpost is AGPL-3.0-or-later. It builds on the lichess.org open-source projects (https://github.com/lichess-org):
> - chessground, chessops and pgn-viewer (GPL-3.0-or-later)
> - stockfish-web (AGPL-3.0-or-later; Stockfish is GPL-3.0)
> - @lichess-org/types (AGPL-3.0-or-later)
> - Theme colours, icon mappings and explorer styles adapted from lila (AGPL-3.0-or-later), © 2012-2026 the lila authors
> - Opening names from lichess-org/chess-openings (CC0-1.0)
>
> Assets from lila/public:
> - Piece sets: cburnett (Colin M.L. Burnett, GPLv2+); merida (Armando Hernandez Marroquin, GPLv2+); chessnut (Alexis Luengas, Apache-2.0); fantasy, spatial and celtic (Maurizio Monge, MIT); kiwen-suwi (neverRare, CC BY 4.0); firi (James Faure, CC BY 4.0); rhosgfx (RhosGFX, CC0); mpchess (Maxime Chupin, GPLv3+); pixel (therealqtpi, AGPLv3+); letter (usolando, AGPLv3+)
> - Board images: the lila authors and pirouetti, AGPLv3+
> - Sounds sfx, piano and nes: Enigmahack, AGPLv3+
> - lichess icon font: Dave Gandy/Font Awesome (OFL), GitHub Octicons (MIT), Webalys, Zurb, Daniel Bruce/Entypo, Shapemade, Sergey Shmidt (CC BY 3.0) and the lichess authors (AGPLv3+)
> - Noto Sans (Google) and Roboto (Christian Robertson): Apache-2.0
> - Chess figurine font: pgn4web authors, GPLv2+
>
> Lichess and the lichess logo are not used and are not endorsed.

Also commit lila's `COPYING.md` as `web/public/lichess/COPYING.lila.md`. Do not copy `public/logo` or the favicon: they are non-free and "only use to refer to lichess.org".

**Still unverified:**
1. Whether the Vite alias for the pgn-viewer CSS works in a real build.
2. The licences of governor and kosal (only inferred from the AGPLv3+ default).
3. The exact NNUE-to-flavour mapping and the licence of the network files.
