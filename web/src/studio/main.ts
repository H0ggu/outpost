/**
 * Studio entry (studio.html, PLAN §8): lila's analysis board (web/vendor/lila, option A of
 * docs/research/lila-ui-extraction.md) plus Outpost's chrome.
 *
 * Order matters:
 *   1. globals.ts installs what every lila module expects at import time (`$`, `$html`, `$trim`,
 *      `window.lichess`, `window.i18n`, an empty `window.site`);
 *   2. lila's own stylesheets (compiled from its SCSS by vite.config.ts) and Studio's;
 *   3. the saved look (theme, board, pieces, sound set) goes on <html>/<body>, because lila's sound
 *      module reads `body[data-sound-set]` when it is first imported;
 *   4. boot.ts — and with it every lila module — loads only then.
 *
 * Typecheck boundary (PLAN §1, docs/CONVENTIONS.md "Studio"): vendored lila is imported only as
 * `lila/<package>/<module>`. Vite resolves that to web/vendor/lila/<package>/src/<module>; tsc
 * (web/tsconfig.studio.json) resolves it to the declarations in src/studio/lila-types, so vendored
 * sources are never type-checked. lila's globals are typed from vendor/lila/@types/lichess.
 */
import './globals.ts';
import 'virtual:lila-css/lib.theme.all.css';
import 'virtual:lila-css/site.css';
import 'virtual:lila-css/analyse.free.css';
import 'virtual:lila-css/bits.dialog.css';
import 'virtual:lila-css/keyboardMove.css';
import 'virtual:lila-css/studio.lila.css';
import './studio.css';
import { localPrefs, applyStudioPrefs } from './prefs.ts';
import { parseStudioQuery } from './query.ts';

const params = parseStudioQuery(location.search);
const prefs = localPrefs();
// lila's board resize handle saves the zoom under body[data-zoom-storage] (scripts/lila-patches/001).
try {
  const zoom = Number(localStorage.getItem(document.body.dataset.zoomStorage ?? ''));
  if (zoom >= 0 && zoom <= 100 && localStorage.getItem(document.body.dataset.zoomStorage ?? '') !== null)
    document.body.style.setProperty('---zoom', String(Math.round(zoom)));
} catch {
  // storage unavailable: lila's default zoom
}
document.body.classList.toggle('studio-embed', params.embed);
applyStudioPrefs(prefs);

import('./boot.ts')
  .then(({ boot }) => boot(params, prefs))
  .catch((e: unknown) => {
    console.error(e);
    const main = document.querySelector('main.analyse');
    if (main) {
      const p = document.createElement('p');
      p.className = 'studio-fatal';
      p.textContent = `The Studio could not start: ${e instanceof Error ? e.message : String(e)}`;
      main.replaceChildren(p);
    }
  });
