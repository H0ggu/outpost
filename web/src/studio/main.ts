/**
 * Studio entry (studio.html) — placeholder.
 *
 * TODO(studio): mount lila's analysis board (web/vendor/lila, PLAN §8;
 * docs/research/lila-ui-extraction.md option A): site/socket shims, Vite resolver plugin for
 * `lib`, `lib/*`, `keyboard-move` and `@/…`, translation XML → window.i18n, gen/_wrap.scss and the
 * three SCSS entries, then `makeStart(patch)(opts)` on `main.analyse`, plus the Outpost chrome
 * (My Files, board tabs, layouts, settings) and the query parameters in StudioQuery
 * (src/app/paths.ts).
 *
 * Typecheck boundary (PLAN §1, docs/CONVENTIONS.md "Studio"): import vendored lila only as
 * `lila/<package>/<module>` (e.g. `import { makeStart } from 'lila/analyse/start'`). Vite resolves
 * that to web/vendor/lila/<package>/src/<module>; tsc (web/tsconfig.studio.json) resolves it to a
 * declaration you write in src/studio/lila-types/<package>/<module>.d.ts, so vendored sources are
 * never type-checked. lila's globals (`site`, `i18n`, `$html`, …) are typed from
 * vendor/lila/@types/lichess. The SPA program (web/tsconfig.json) excludes src/studio.
 */
import '../styles/lichess-theme.css';

const el = document.querySelector<HTMLElement>('.studio-loading');
if (el) el.textContent = 'Studio loading…';
