/**
 * Failed lazy chunks. Every page and some widgets are separate chunks with hashed names; after
 * an upgrade the old ones are gone, so a tab opened before it fails on its next navigation.
 * Reloading picks up the new version (decision 36). A reload is attempted once a minute at most
 * per tab, so a server that is really down shows an error instead of reloading in a loop.
 */

/** Whether an error is a failed dynamic import (Chromium, Firefox, Safari wording; Vite preload). */
export function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /dynamically imported module|Importing a module script failed|Unable to preload|ChunkLoadError|Loading chunk/i.test(msg);
}

const RELOAD_KEY = 'outpost:chunk-reload';
/** At most one automatic reload per tab in this window. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

/**
 * Reloads the page to fetch the current version, unless this tab already did so within the last
 * minute (or the tab's storage is unavailable, so a loop could not be ruled out). Returns
 * whether a reload was started.
 */
export function reloadForNewVersion(now: number = Date.now(), reload: () => void = () => window.location.reload()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
