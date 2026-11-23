# Local patches to vendored lila code

`web/vendor/lila` is a copy of lila at the pinned commit plus the patches in this folder.
`scripts/vendor-lichess.sh` re-applies every patch in name order after copying, so re-vendoring never
loses them. Paths in a patch are relative to `web/vendor/lila` (e.g. `a/analyse/src/ctrl.ts`), and
each vendored file belongs to exactly one patch. Every change is guarded by the `outpost` options
the Studio passes (`opts.outpost`, `opts.explorer.outpost`), so without them lila behaves as upstream.

| Patch | What it changes, and why |
|---|---|
| `001-outpost-hooks.patch` | `AnalyseOpts.outpost` hooks for what lila asks its server for: `changeFen` hands the FEN box's position to the Studio, which opens it on a new board tab (lila navigates to `/analysis/<fen>`), the keyboard help (`?`) comes from the Studio (lila fetches `/analysis/help`). Hides menu entries that need lila's server (continue vs AI/friend, board editor, "to study", server-side game review) and the `b` editor key. Drawn arrows and circles are kept on the move (like a study chapter), so they reach the saved PGN. Settings help shows no unshipped videos/images. The board zoom is kept in this browser instead of `POST /pref/zoom`. |
| `002-explorer-outpost-databases.patch` | Explorer databases for Outpost: the `player` database targets an Outpost profile or account (absolute player endpoint that may carry the `/f/<filters>/` segment, display names, a profile/account picker instead of Lichess user autocomplete, whose suggestions redraw the open dialog when they arrive), a `reference` database (the local OTB DB, masters-shaped), game links handled by Outpost (`/studio?game=op123`, masters PGN), no `/opening` page links or lichess logo, a shorter title row for four databases (with a player selected, the other databases become icons so the name fits), and the server's error message instead of a bare status. A database the server can't serve (the Lichess one without a token: `outpost.unavailable(db)`, or a 503 `no_token`) is not fetched and says why at full size instead of lila's collapsed "Oops, sorry!". Sign-in is per database (`outpost.requiresAuth(db)`, with `signInReason(db)` as the sign-in view's text): with anonymous browsing on, only the token-relayed Lichess database asks a visitor to sign in. The player database's move table has a "Last" column (`lastPlayed` on each move, formatted by `outpost.lastPlayed`), as ChessMonitor's explorer has. |
| `003-pgn-import-annotations.patch` | lila only keeps PGN comments, NAGs, `[%cal]`/`[%csl]` shapes, `[%clk]` and `[%eval]` when its server imports a study chapter; the client importer now reads them, plus `ECO`/`Opening` and the game result, so My Files round-trips. Exports `glyphOfNag`/`pgnCommentId` for the Studio's annotation panel. |
| `004-ceval-shipped-engines.patch` | The engine list offers only engines whose files Outpost ships: stockfish-web (SF 19, SF 19 smallnet, Fairy-Stockfish HCE) when the page is cross-origin isolated, and stockfish.js otherwise. Drops the stockfish-nnue.wasm, stockfish.wasm and multi-variant builds and the per-variant NNUE nets. |
| `005-tsconfig-vendored-references.patch` | Removes project references to lila packages that are not vendored (`bits`, `chart`, `dasher`): Vite's TypeScript transform follows them and fails on the missing folders. |

Edit the vendored files, then regenerate the patch the file belongs to against a commit that holds
the unpatched copy (`<base>`, e.g. the scaffold commit, or a fresh `npm run vendor` with this folder empty):

    git diff --relative=web/vendor/lila <base> -- web/vendor/lila/<files of that patch> > scripts/lila-patches/NNN-name.patch

and check that the pristine copy plus all patches reproduces `web/vendor/lila` (apply them in name
order with `git apply --directory=web/vendor/lila`).
