/**
 * Studio entry (studio.html) — placeholder.
 *
 * TODO(studio): mount lila's analysis board (web/vendor/lila, PLAN §8;
 * docs/research/lila-ui-extraction.md option A): site/socket shims, Vite resolver plugin for
 * `lib`, `lib/*`, `keyboard-move` and `@/…`, translation XML → window.i18n, gen/_wrap.scss and the
 * three SCSS entries, then `makeStart(patch)(opts)` on `main.analyse`, plus the Outpost chrome
 * (My Files, board tabs, layouts, settings) and the query parameters in StudioQuery
 * (src/app/paths.ts). src/studio is type-checked by its own program, web/tsconfig.studio.json
 * (yours to tune for the vendored lila code; it runs in `npm run typecheck`); the SPA program
 * (web/tsconfig.json) excludes it.
 */
import '../styles/lichess-theme.css';

const el = document.querySelector<HTMLElement>('.studio-loading');
if (el) el.textContent = 'Studio loading…';
