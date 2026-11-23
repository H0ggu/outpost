/**
 * Globals lila's code expects before any of it runs (PLAN §8.2,
 * docs/research/lila-ui-extraction.md "Globals the code expects"): cash as `$`, the `$html`/`$trim`
 * template tags, `window.lichess` (written by `registerPublicApi`) and the English `window.i18n`.
 * Imported first by main.ts; the lila modules themselves load later, from boot.ts.
 */
import cash from 'cash-dom';
import 'virtual:lila-i18n';
import { html, trim } from './templates.ts';

const w = window as unknown as Record<string, unknown>;
w.$ = cash;
w.$html = html;
w.$trim = trim;
w.lichess ??= {};
w.site ??= {};
