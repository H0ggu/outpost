/**
 * Putting a tab's cursor back on lila's board after its game was loaded (boot.ts). Structural types
 * only (the members of lila's AnalyseCtrl used here), so this is unit-tested without lila.
 */

/** What restoring the cursor needs from lila's AnalyseCtrl. */
export interface CursorHost {
  path: string;
  tree: { lastPly(): number; pathExists(path: string): boolean };
  mainlinePlyToPath(ply: number): string;
  userJump(path: string): void;
}

/** The tree path a tab's saved cursor stands for (null: end of the mainline; gone: the start). */
export function cursorPath(host: CursorHost, saved: string | null): string {
  if (saved === null) return host.mainlinePlyToPath(host.tree.lastPly());
  return host.tree.pathExists(saved) ? saved : '';
}

/**
 * Moves lila's cursor to the tab's saved path. After `reloadData` lila stands at the root but has not
 * told the explorer (or anything else that follows the cursor) about it: only a jump does, which is
 * why lila's own `changePgn` always jumps after reloading. So `afterReload` jumps even when the path
 * stays the same; at mount, lila's constructor already did this for the root.
 */
export function restoreCursor(host: CursorHost, saved: string | null, afterReload: boolean): void {
  const path = cursorPath(host, saved);
  if (afterReload || path !== host.path) host.userJump(path);
}
