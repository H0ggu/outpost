/** Virtual modules served by vite.config.ts (`studioLila`). */

/** Installs lila's eagerly used English catalogs on `window.i18n`. */
declare module 'virtual:lila-i18n' {}
/** lila's screen-reader catalog (loaded on demand by `site.asset.loadI18n('nvui')`). */
declare module 'virtual:lila-i18n/nvui' {}

/** URL prefixes of the engine builds lila's ceval loads. */
declare module 'virtual:studio-engines' {
  const engines: { stockfishWeb: string; stockfishJs: string };
  export default engines;
}
