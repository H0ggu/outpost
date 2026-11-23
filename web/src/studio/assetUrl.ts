/**
 * `site.asset.url` for the Studio (PLAN §8.2): maps lila's asset layout (`/assets/<path>` on
 * lichess.org) to what Outpost serves.
 *
 *   sound/<set>/<Name>.mp3       → /lichess/sound/…   (vendored free sets, web/public/lichess)
 *   piece/… images/board/… font/ → /lichess/…
 *   npm/stockfish-web/<file>     → the stockfish-web build (vite.config.ts `virtual:studio-engines`)
 *   npm/stockfish.js/<file>      → the fallback engine for browsers without cross-origin isolation
 *   lifat/nnue/<name>            → /assets/lifat/nnue/<name> (server download cache, PLAN §6)
 *
 * Anything else (help videos, flairs, federation flags, the logo) is not shipped: the empty string
 * tells the patched callers to show nothing (scripts/lila-patches/001).
 */

/** Where the engine builds are served (`virtual:studio-engines`). */
export interface EngineBases {
  stockfishWeb: string;
  stockfishJs: string;
}

const NNUE_RE = /^nn-[0-9a-f]{12}\.nnue$/;
const FILE_RE = /^[\w.-]+$/;

/** URL of a lila asset path, or `''` when Outpost doesn't ship it. */
export function lilaAssetUrl(assetPath: string, engines: EngineBases): string {
  const p = assetPath.replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
  const parts = p.split('/');
  if (parts.some(s => s === '' || s === '.' || s === '..')) return '';
  const [top, second, ...rest] = parts;
  const file = parts.at(-1) ?? '';
  switch (top) {
    case 'sound':
      return parts.length === 3 && FILE_RE.test(file) ? `/lichess/${p}` : '';
    case 'piece':
      return parts.length === 3 ? `/lichess/${p}` : '';
    case 'font':
      return parts.length === 2 ? `/lichess/${p}` : '';
    case 'images':
      return second === 'board' && rest.length === 1 ? `/lichess/board/${file}` : '';
    case 'lifat':
      return second === 'nnue' && rest.length === 1 && NNUE_RE.test(file) ? `/assets/lifat/nnue/${file}` : '';
    case 'npm':
      if (rest.length !== 1 || !FILE_RE.test(file)) return '';
      if (second === 'stockfish-web') return `${engines.stockfishWeb}/${file}`;
      if (second === 'stockfish.js') return `${engines.stockfishJs}/${file}`;
      return '';
    default:
      return '';
  }
}

/** Sound names lila asks for (`move`, `genericNotify`, …) that the vendored sets contain. */
export const SHIPPED_SOUNDS: ReadonlySet<string> = new Set(['move', 'capture', 'check', 'checkmate', 'genericNotify']);
