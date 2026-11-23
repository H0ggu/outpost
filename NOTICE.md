# Notices and attribution

Outpost is free software under the **GNU Affero General Public License v3.0 or later** (see `LICENSE`).
If you run a modified Outpost for other people over a network, the AGPL requires you to offer them its
source code.

**Outpost is not affiliated with, endorsed by or sponsored by Chess.com or Lichess.** "Lichess" and the
Lichess logo are not used as Outpost branding; the Lichess logo, favicon and other non-free Lichess assets
are not included. Chess data comes only from the official public APIs (Lichess API, Chess.com Published-Data
API) and openly licensed datasets.

## Lichess open-source projects

Outpost builds on the lichess.org open-source projects (https://github.com/lichess-org):

- **chessground** 10.5.0, **chessops** 0.15.1 and **pgn-viewer** 2.7.3 — GPL-3.0-or-later
- **stockfish-web** 0.6.1 — AGPL-3.0-or-later (per its package metadata); Stockfish itself is GPL-3.0
  (the Stockfish developers, https://stockfishchess.org)
- **@lichess-org/types** — AGPL-3.0-or-later (type definitions, development only)
- **lila** (the lichess.org server and UI), © 2012-2026 the lila authors — AGPL-3.0-or-later:
  - `web/vendor/lila/`: an unmodified copy of `ui/{analyse,lib,keyboardMove,site,editor,@types/lichess}`
    and `translation/source` at commit `b071608bc4ce71b31cda36ffa493100e3dc3580f` (see
    `web/vendor/lila/NOTICE`; lila's own licence file is `web/vendor/lila/COPYING.md`). It powers the Studio.
  - `web/src/lichess/licon.ts`: the icon-font codepoint map, copied from `ui/lib/src/licon.ts`.
  - Theme colours, board/piece CSS patterns, icon mappings and explorer styles adapted from lila into
    `web/src/styles/`.
- **chess-openings** — opening names from https://github.com/lichess-org/chess-openings (CC0-1.0), commit
  `48a8c0e733facfdc9a3723fe882e51ec28014074`, in `server/data/openings/`.

## Assets from lila/public (`web/public/lichess/`)

Copied by `scripts/vendor-lichess.sh` from lila at the commit above; lila's `COPYING.md` is included as
`web/public/lichess/COPYING.lila.md`.

- **Piece sets:** cburnett (Colin M.L. Burnett, GPLv2+); merida (Armando Hernandez Marroquin, GPLv2+);
  chessnut (Alexis Luengas, Apache-2.0); fantasy, spatial and celtic (Maurizio Monge, MIT); kiwen-suwi
  (neverRare, CC BY 4.0); firi (James Faure, CC BY 4.0); rhosgfx (RhosGFX, CC0); mpchess (Maxime Chupin,
  GPLv3+); pixel (therealqtpi, AGPLv3+); letter (usolando, AGPLv3+)
- **Board images:** the lila authors and pirouetti, AGPLv3+
- **Sounds** sfx, piano and nes: Enigmahack, AGPLv3+
- **lichess icon font:** Dave Gandy / Font Awesome (OFL), GitHub Octicons (MIT), Webalys, Zurb, Daniel
  Bruce / Entypo, Shapemade, Sergey Shmidt (CC BY 3.0) and the lichess authors (AGPLv3+)
- **Fonts:** Noto Sans (Google) and Roboto (Christian Robertson), Apache-2.0
- **Chess figurine font** (Noto Chess): pgn4web authors, GPLv2+

Not included, because they are not free: the alpha, california and other CC BY-NC-SA piece sets, the
`standard` (and robot, woodland, instrument, other, lisp) sounds, and the Lichess logo and favicon.

## Data

- **Lichess games and profiles** are fetched from the Lichess API on behalf of the instance owner.
- **Lichess broadcast database** (https://database.lichess.org/#broadcasts), when imported into the
  reference database, is licensed **CC BY-SA 4.0** by lichess.org; Outpost shows this attribution wherever
  that data appears, and anything derived from it must be shared under the same licence.
- **Chess.com data** comes from the Chess.com Published-Data API. Outpost is not affiliated with Chess.com.
- **World map:** Natural Earth (public domain) via world-atlas (ISC) and topojson-client (ISC).
- **Stockfish NNUE networks** are downloaded at run time from https://tests.stockfishchess.org and cached
  in `DATA_DIR/nnue`; they are not redistributed with Outpost.

## Other third-party software

Bundled or installed via npm (see `package-lock.json` for the full list and versions):
snabbdom, cash-dom, @badrap/result, debounce-promise, idb-keyval, tablesort (MIT); stockfish.js (GPL-3.0);
React, React DOM, React Router, TanStack Query, Fastify and its plugins, zod, undici, qrcode,
i18n-iso-countries (MIT); d3-array, d3-geo, d3-interpolate, d3-scale, d3-shape, d3-time,
d3-time-format, topojson-client, world-atlas (ISC).
