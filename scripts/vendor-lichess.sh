#!/usr/bin/env bash
# Reproducibly vendor Lichess code and free assets into Outpost (PLAN §2, §8.1;
# docs/research/lila-ui-extraction.md, docs/research/lichess-packages-assets.md "Vendor list").
#
#   lila @ LILA_COMMIT                      → web/vendor/lila/{analyse,lib,keyboardMove,site,editor,@types/lichess}
#                                              + tsconfig.base.json, translation/source, COPYING.md, NOTICE
#   lila public/ (free assets only)         → web/public/lichess/{piece/<set>,board,sound/<set>,font}
#   lila ui/lib/src/licon.ts                → web/src/lichess/licon.ts
#   chess-openings @ OPENINGS_COMMIT        → server/data/openings/{a..e}.tsv (+ COPYING.txt)
#   scripts/lila-patches/*.patch (if any)   → applied to web/vendor/lila afterwards
#
# Downloaded code is untrusted: this script only copies files. It never runs anything from the
# clones (no package installs, builds or scripts). Symlinks are dereferenced with cp -L.
# Non-free lila assets are never copied: no alpha/california/other CC BY-NC-SA piece sets,
# no `standard`/robot/woodland/instrument/other/lisp sounds, no logo or favicon.
#
# Usage: bash scripts/vendor-lichess.sh      (or: npm run vendor)
set -euo pipefail

LILA_REPO=https://github.com/lichess-org/lila.git
LILA_COMMIT=b071608bc4ce71b31cda36ffa493100e3dc3580f
OPENINGS_REPO=https://github.com/lichess-org/chess-openings.git
OPENINGS_COMMIT=48a8c0e733facfdc9a3723fe882e51ec28014074

PIECE_SETS=(cburnett merida chessnut fantasy spatial celtic kiwen-suwi firi rhosgfx mpchess pixel letter)
BOARDS_PNG=(brown blue green purple ic)
BOARDS_JPG=(wood4 maple olive grey blue3)
SOUND_SETS=(sfx piano nes)
SOUND_FILES=(Move Capture Check Checkmate GenericNotify) # Checkmate is an upstream symlink to Check; sound.ts preloads it
FONTS=(lichess lichess-chess noto-sans-latin noto-sans-latin-ext roboto-latin roboto-latin-ext)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/outpost-vendor.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# fetch_at <repo> <commit> <dir> <sparse patterns...>
# Fetches exactly one commit without history or unneeded blobs, then checks out only the
# sparse patterns. Falls back to a blob-less full clone if the server refuses fetch-by-SHA.
fetch_at() {
  local repo=$1 commit=$2 dir=$3
  shift 3
  git init -q "$dir"
  git -C "$dir" config core.symlinks true
  git -C "$dir" config advice.detachedHead false
  git -C "$dir" remote add origin "$repo"
  git -C "$dir" sparse-checkout set --no-cone "$@"
  if ! git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$commit" 2>/dev/null; then
    log "fetch by commit refused; falling back to a blob-less clone of $repo"
    rm -rf "$dir"
    git clone -q --filter=blob:none --no-checkout "$repo" "$dir"
    git -C "$dir" sparse-checkout set --no-cone "$@"
  fi
  git -C "$dir" checkout -q "$commit"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || die "checked out the wrong commit in $dir"
}

# ---------------------------------------------------------------------------
# lila
# ---------------------------------------------------------------------------
log "fetching lila @ $LILA_COMMIT (sparse)"
LILA_PATTERNS=(
  /COPYING.md
  /ui/tsconfig.base.json
  /ui/@types/lichess/
  /ui/analyse/
  '!/ui/analyse/tests/'
  /ui/lib/
  '!/ui/lib/tests/'
  /ui/keyboardMove/
  '!/ui/keyboardMove/tests/'
  /ui/site/src/
  /ui/site/css/
  /ui/site/types/
  /ui/site/package.json
  /ui/site/tsconfig.json
  /ui/editor/src/
  /ui/editor/package.json
  /ui/editor/tsconfig.json
  /translation/source/
  /public/font/
)
for s in "${PIECE_SETS[@]}"; do LILA_PATTERNS+=("/public/piece/$s/"); done
for b in "${BOARDS_PNG[@]}"; do LILA_PATTERNS+=("/public/images/board/$b.png" "/public/images/board/$b.thumbnail.png"); done
for b in "${BOARDS_JPG[@]}"; do LILA_PATTERNS+=("/public/images/board/$b.jpg" "/public/images/board/$b.thumbnail.jpg"); done
for s in "${SOUND_SETS[@]}"; do LILA_PATTERNS+=("/public/sound/$s/"); done
fetch_at "$LILA_REPO" "$LILA_COMMIT" "$WORK/lila" "${LILA_PATTERNS[@]}"
L="$WORK/lila"
LILA_DATE="$(git -C "$L" show -s --format=%cI HEAD)"

log "copying lila ui → web/vendor/lila"
V="$ROOT/web/vendor/lila"
rm -rf "$V"
mkdir -p "$V/site" "$V/editor" "$V/@types" "$V/translation"
cp -RL "$L/ui/analyse" "$L/ui/lib" "$L/ui/keyboardMove" "$V/"
cp -RL "$L/ui/site/src" "$L/ui/site/css" "$L/ui/site/types" "$L/ui/site/package.json" "$L/ui/site/tsconfig.json" "$V/site/"
cp -RL "$L/ui/editor/src" "$L/ui/editor/package.json" "$L/ui/editor/tsconfig.json" "$V/editor/"
cp -RL "$L/ui/@types/lichess" "$V/@types/"
cp -L "$L/ui/tsconfig.base.json" "$V/"
cp -RL "$L/translation/source" "$V/translation/"
cp -L "$L/COPYING.md" "$V/COPYING.md"
# Belt and braces: nothing executable-by-tooling or test-only.
find "$V" \( -name node_modules -o -name tests -o -name dist \) -prune -exec rm -rf {} +

cat >"$V/NOTICE" <<EOF
Vendored from lila, the lichess.org server and UI: https://github.com/lichess-org/lila
Commit: $LILA_COMMIT
Commit date: $LILA_DATE
Script: scripts/vendor-lichess.sh (re-run it to reproduce this folder byte for byte)

Contents (paths relative to lila/ui unless noted):
  analyse/ lib/ keyboardMove/            whole packages, minus tests/
  site/{src,css,types,package.json,tsconfig.json}
  editor/{src,package.json,tsconfig.json}
  @types/lichess/
  tsconfig.base.json
  translation/source/ (lila/translation/source, English XML)
  COPYING.md (lila/COPYING.md)

Licence: AGPL-3.0-or-later, (c) 2012-2026 the lila authors (see COPYING.md for the exceptions).
These files are copied unchanged. Local changes live in scripts/lila-patches/*.patch and are
re-applied by the vendoring script; never edit files here without adding a patch.
Never merge upstream into this folder; re-vendor deliberately at a new pinned commit.
EOF

log "copying licon.ts → web/src/lichess/licon.ts"
mkdir -p "$ROOT/web/src/lichess"
{
  printf '// Vendored unchanged from lila @ %s: ui/lib/src/licon.ts (AGPL-3.0-or-later, the lila authors).\n' "$LILA_COMMIT"
  printf '// Codepoints of the lichess icon font (web/public/lichess/font/lichess.woff2). Re-vendor with scripts/vendor-lichess.sh.\n'
  cat "$L/ui/lib/src/licon.ts"
} >"$ROOT/web/src/lichess/licon.ts"

log "copying free assets → web/public/lichess"
P="$ROOT/web/public/lichess"
rm -rf "$P/piece" "$P/board" "$P/sound" "$P/font"
mkdir -p "$P/piece" "$P/board" "$P/sound" "$P/font"
for s in "${PIECE_SETS[@]}"; do
  mkdir -p "$P/piece/$s"
  n=0
  for f in "$L/public/piece/$s"/*.svg; do cp -L "$f" "$P/piece/$s/"; n=$((n + 1)); done
  [ "$n" -eq 12 ] || die "piece set $s has $n svg files (expected 12)"
done
for b in "${BOARDS_PNG[@]}"; do cp -L "$L/public/images/board/$b.png" "$L/public/images/board/$b.thumbnail.png" "$P/board/"; done
for b in "${BOARDS_JPG[@]}"; do cp -L "$L/public/images/board/$b.jpg" "$L/public/images/board/$b.thumbnail.jpg" "$P/board/"; done
for s in "${SOUND_SETS[@]}"; do
  mkdir -p "$P/sound/$s"
  for f in "${SOUND_FILES[@]}"; do
    src="$L/public/sound/$s/$f.mp3"
    if [ -L "$src" ]; then
      case "$(readlink "$src")" in
        *standard* | *robot* | *woodland* | *instrument* | *other* | *lisp*) die "$s/$f.mp3 links to a non-free sound set" ;;
      esac
    fi
    cp -L "$src" "$P/sound/$s/"
  done
done
for f in "${FONTS[@]}"; do cp -L "$L/public/font/$f.woff2" "$P/font/"; done
cp -L "$L/COPYING.md" "$P/COPYING.lila.md"

# ---------------------------------------------------------------------------
# chess-openings
# ---------------------------------------------------------------------------
log "fetching chess-openings @ $OPENINGS_COMMIT"
fetch_at "$OPENINGS_REPO" "$OPENINGS_COMMIT" "$WORK/openings" /a.tsv /b.tsv /c.tsv /d.tsv /e.tsv /COPYING.txt
O="$ROOT/server/data/openings"
rm -rf "$O"
mkdir -p "$O"
cp -L "$WORK/openings"/{a,b,c,d,e}.tsv "$WORK/openings/COPYING.txt" "$O/"
for f in a b c d e; do
  [ "$(head -n 1 "$O/$f.tsv")" = "$(printf 'eco\tname\tpgn')" ] || die "unexpected header in $f.tsv"
done
cat >"$O/README.md" <<EOF
Opening names from https://github.com/lichess-org/chess-openings (CC0-1.0, see COPYING.txt),
commit $OPENINGS_COMMIT. Columns: eco, name, pgn. Re-vendor with scripts/vendor-lichess.sh.
EOF

# ---------------------------------------------------------------------------
# Local patches
# ---------------------------------------------------------------------------
shopt -s nullglob
patches=("$ROOT"/scripts/lila-patches/*.patch)
if [ ${#patches[@]} -gt 0 ]; then
  for p in "${patches[@]}"; do
    log "applying $(basename "$p")"
    git -C "$ROOT" apply --directory=web/vendor/lila "$p"
  done
fi

log "done: lila $LILA_COMMIT ($LILA_DATE), chess-openings $OPENINGS_COMMIT"
