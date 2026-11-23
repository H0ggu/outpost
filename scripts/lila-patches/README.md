# Local patches to vendored lila code

`web/vendor/lila` is an unmodified copy of lila at the pinned commit. When the Studio needs an upstream
change (docs/research/lila-ui-extraction.md lists ~5-8 lines: `changeFen`, `site.redirect('/analysis')`,
the help URL, a `/** @jsx jsx */` pragma), put it here as a `NNN-short-name.patch` with paths relative to
`web/vendor/lila` (e.g. `a/analyse/src/ctrl.ts`). `scripts/vendor-lichess.sh` re-applies every patch in
name order after copying, so re-vendoring never loses them. Make one with:

    git diff --relative=web/vendor/lila -- web/vendor/lila > scripts/lila-patches/001-change-fen.patch
