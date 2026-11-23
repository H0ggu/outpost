/**
 * Outpost's `window.site` for the vendored analysis board (PLAN §8.2), in place of lila's
 * ui/site/src/site.ts. It reuses lila's own asset, sound, mousetrap and reload modules and maps
 * everything that would reach the lichess.org server:
 *   - asset URLs → Outpost's assets (assetUrl.ts); CSS is bundled, so `loadCss` resolves at once;
 *   - `loadEsm` → dynamic imports of the few lila modules Studio can run; the rest are safe no-ops;
 *   - `loadI18n` → the generated English catalogs;
 *   - `redirect('/analysis')` → the Studio itself.
 *
 * Import this after main.ts has set `<body data-sound-set>` and the piece variables: lila's sound and
 * asset modules read them when they load.
 */
import * as asset from 'lila/site/asset';
import Mousetrap from 'lila/site/mousetrap';
import { redirect, reload, unload } from 'lila/site/reload';
import sound from 'lila/site/sound';
import engines from 'virtual:studio-engines';
import { lilaAssetUrl, SHIPPED_SOUNDS } from './assetUrl.ts';

type Init = { init?: unknown; npm?: boolean };
type EsmModule = { initModule?: (o: unknown) => unknown; default?: (o: unknown) => unknown };

/** lila modules `site.asset.loadEsm` can load in Outpost. */
const ESM: Readonly<Record<string, () => Promise<EsmModule>>> = {
  keyboardMove: () => import('lila/keyboardMove/keyboardMove'),
};

/** Shown instead of lila's server-side or unvendored tools. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  'analyse.local': 'Full-game computer review needs the lichess.org server; it is not part of Outpost.',
};

async function loadEsm<T>(name: string, opts: Init = {}): Promise<T> {
  const loader = ESM[name];
  if (!loader) {
    const reason = UNAVAILABLE[name];
    if (reason) {
      const { alert } = await import('lila/lib/view');
      await alert(reason);
    } else console.info(`Outpost: lila module ${name} is not available`);
    // Never settles: callers that await a missing module simply do nothing.
    return new Promise<T>(() => undefined);
  }
  const mod = await loader();
  const init = mod.initModule ?? mod.default;
  if (!init) throw new Error(`lila module ${name} has no initModule`);
  return (opts.npm && !opts.init ? init : init(opts.init)) as T;
}

async function loadI18n(catalog: string): Promise<void> {
  if ((window.i18n as unknown as Record<string, unknown>)[catalog]) return;
  if (catalog === 'nvui') await import('virtual:lila-i18n/nvui');
}

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/[/+=]/g, '_');
};

/** Fills `window.site` (created empty by globals.ts) before lila's analyse modules load. */
export function installSite(): Site {
  const site = window.site;
  // Only the move sounds of the free sets are vendored: lila's other named sounds stay silent.
  const resolvePath = sound.resolvePath.bind(sound);
  sound.resolvePath = (name: string) => (SHIPPED_SOUNDS.has(name) ? resolvePath(name) : undefined);

  Object.assign(site, {
    debug: false,
    info: { commit: 'b071608bc4ce71b31cda36ffa493100e3dc3580f', message: 'lila (vendored)', date: '2026-11-22' },
    sri: randomToken(),
    displayLocale: document.documentElement.lang || 'en',
    blindMode: false,
    quietMode: false,
    mousetrap: new Mousetrap(document),
    powertip: {
      watchMouse() {},
      manualGameIn() {},
      manualGame() {},
      manualUser() {},
      manualUserIn() {},
    },
    asset: {
      baseUrl: () => '',
      url: (path: string) => lilaAssetUrl(path, engines),
      flairSrc: () => '',
      fideFedSrc: () => '',
      loadCss: () => Promise.resolve(),
      releaseCss: () => undefined,
      removeCss: () => undefined,
      jsModule: asset.jsModule,
      loadIife: (path: string) => Promise.reject(new Error(`Outpost does not ship ${path}`)),
      loadEsm,
      loadPieces: asset.loadPieces,
      loadI18n,
    },
    unload,
    redirect: (to: RedirectTo, beep?: boolean) => {
      const url = typeof to === 'string' ? to : `/game/${to.id}`;
      if (/^\/?analysis(\/|$|\?)/.test(url)) return redirect('/studio', beep);
      console.info(`Outpost: ignored lila redirect to ${url}`);
      return Promise.resolve();
    },
    reload,
    announce: () => undefined,
    sound,
    load: Promise.resolve(),
    quantity: (n: number) => window.i18n.quantity(n),
    manifest: { css: {}, js: {}, hashed: {} },
  } satisfies Partial<Site> & Record<string, unknown>);
  return site;
}
