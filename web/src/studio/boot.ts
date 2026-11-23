/**
 * Mounts lila's analysis board (PLAN §8.3) and the Outpost chrome around it.
 *
 *   1. `window.site` is filled by the site shim (site.ts), the session and prefs are read;
 *   2. the tabs saved in this browser tab come back, then the query (`?game=`, `?file=`, `?pgn=`,
 *      `?fen=`) opens what it names, so the first game is known before lila starts;
 *   3. `makeStart(patch)(opts)` mounts lila on `main.analyse` with the socket shim, Outpost's explorer
 *      endpoints and the `outpost` hooks (scripts/lila-patches);
 *   4. the explorer opens on the requested database (`?explorer=`), and the chrome mounts.
 */
// First: lila modules read `window.site` while they load.
import './site.ts';
import { API_ROUTES, type SessionInfo } from '@outpost/shared/api';
import { api } from '../app/api/client.ts';
import type { AnalyseApi, AnalyseCtrl, AnalyseOpts } from 'lila/analyse/interfaces';
import makeStart from 'lila/analyse/start';
import { patch as lilaPatch } from 'lila/analyse/view/util';
import { alert } from 'lila/lib/view';
import { restoreCursor } from './board.ts';
import { analyseDataOf, StudioCtrl } from './ctrl.ts';
import { makeExplorerOpts } from './explorer.ts';
import { keyboardHelpHtml } from './keyboardHelp.ts';
import { emptyGamePgn } from './pgn.ts';
import type { StudioPrefs } from './prefs.ts';
import type { StudioParams } from './query.ts';
import { makeSocketSend } from './socket.ts';
import type { StudioTab } from './tabs.ts';
import { mountChrome } from './view/chrome.ts';

/** How long the board must be still before its game is exported to the tab (and compared with its saved version). */
const DIRTY_CHECK_MS = 400;

async function loadSession(): Promise<SessionInfo | null> {
  try {
    return await api.get<SessionInfo>(API_ROUTES.session);
  } catch {
    return null; // server unreachable: the board still works, My Files says why it can't load
  }
}

/** lila's data for a tab's shown game; a game that no longer parses becomes an empty board. */
function dataOf(tab: StudioTab): { data: ReturnType<typeof analyseDataOf>; error?: string } {
  try {
    return { data: analyseDataOf(tab.games[tab.current] ?? emptyGamePgn(), tab.orientation) };
  } catch (e) {
    return { data: analyseDataOf(emptyGamePgn(), tab.orientation), error: e instanceof Error ? e.message : String(e) };
  }
}

export async function boot(params: StudioParams, prefs: StudioPrefs): Promise<void> {
  // like lila's analyse entry: the piece images are decoded before the board is drawn
  const [session] = await Promise.all([loadSession(), window.site.asset.loadPieces]);
  const ctrl = new StudioCtrl(params, prefs, params.embed ? null : sessionStorage);
  ctrl.setSession(session);
  if (!params.embed) ctrl.tabs.load();
  await ctrl.openFromQuery();
  if (!ctrl.activeTab) ctrl.newTab();
  const first = ctrl.activeTab!;

  let lila: AnalyseApi | undefined;
  const socketSend = makeSocketSend(
    () => lila?.socketReceive,
    () => ctrl.signedIn || !!ctrl.session?.anonymousBrowsing,
  );
  const side = document.createElement('aside');
  side.className = 'analyse__side studio-side';

  const explorer = makeExplorerOpts({
    origin: location.origin,
    filtered:
      params.explorer?.db === 'player' && params.filters
        ? { player: params.explorer.player, segment: params.filters }
        : undefined,
    signedIn: () => ctrl.signedIn,
    anonymousBrowsing: () => !!ctrl.session?.anonymousBrowsing,
    hasLichessToken: () => ctrl.session?.hasLichessToken,
    isAdmin: () => ctrl.session?.user?.role === 'admin',
    loginUrl: ctrl.loginUrl,
    redraw: () => ctrl.analyse?.redraw(),
    openGame: ctrl.openExplorerGame,
    showGames: ctrl.showPositionGames,
    playerPerspective: () => ctrl.winratePerspective === 'player',
  });
  ctrl.playerLabel = explorer.outpost.playerLabel;

  const initial = dataOf(first);
  const opts: AnalyseOpts = {
    data: initial.data,
    hunter: false,
    explorer,
    socketSend,
    externalEngineEndpoint: '',
    wiki: false,
    userId: session?.user?.username.toLowerCase(),
    $side: params.embed ? undefined : $(side),
    outpost: {
      changeFen: fen => ctrl.changeFen(fen),
      keyboardHelpHtml: () => keyboardHelpHtml(),
    },
  };
  lila = makeStart(lilaPatch)(opts);
  const analyse = window.site.analysis as AnalyseCtrl;

  const load = (tab: StudioTab): void => {
    const { data, error } = dataOf(tab);
    analyse.flipped = false;
    analyse.reloadData(data, false);
    restoreCursor(analyse, tab.path, true);
    analyse.redraw();
    if (error) void alert(`This game could not be read and was replaced by an empty board: ${error}`);
  };

  restoreCursor(analyse, first.path, false);
  ctrl.attach(analyse, load);
  if (initial.error) void alert(`This game could not be read and was replaced by an empty board: ${initial.error}`);

  // After each lila redraw: the chrome follows the cursor (next frame); the tab's PGN, cursor and
  // unsaved marker follow once the board settles (moves, deletions, promotions, comments …).
  const lilaRedraw = analyse.redraw.bind(analyse);
  let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  analyse.redraw = () => {
    lilaRedraw();
    ctrl.redraw();
    ctrl.postEmbedPosition();
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => ctrl.onBoardChange(), DIRTY_CHECK_MS);
  };
  window.addEventListener('pagehide', () => ctrl.syncActive());

  ctrl.openExplorerFromQuery();
  mountChrome(ctrl, {
    top: params.embed ? null : document.getElementById('top'),
    bar: params.embed ? null : document.getElementById('studio-bar'),
    side: params.embed ? null : side,
  });
  ctrl.applyLayout();
  ctrl.applyPendingJump();
  if (!params.embed) void ctrl.refreshFiles();
  ctrl.redraw();
  analyse.redraw();
}
