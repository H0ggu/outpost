/**
 * `socketSend` for the analysis board (PLAN §8.3). In the pure-client analysis mode lila only
 * *sends* on its socket; the one message worth answering is `evalGet` (cloud eval for the shown
 * position), which goes to Outpost's `/api/cloud-eval` proxy and comes back as lila's `evalHit`.
 * Everything else (`evalPut`, `startWatching`, study moves, …) is a no-op.
 */
import { API_ROUTES, type CloudEvalQuery, type CloudEvalResponse } from '@outpost/shared/api';

/** What lila's EvalCache sends with `evalGet` (analyse/src/interfaces.ts `EvalGetData`). */
interface EvalGetData {
  fen: string;
  path: string;
  variant?: string;
  mpv?: number;
  up?: boolean;
}

/** Delivers a socket message to the board (`AnalyseApi.socketReceive`). */
export type SocketReceive = (type: string, data: unknown) => void;

const MAX_MULTI_PV = 5;

/**
 * Makes the socket shim. `getReceive` may return undefined until the board is mounted (answers are
 * then dropped); `canGet` says whether this viewer may call `/api/cloud-eval` (signed in, or
 * anonymous browsing on), so anonymous visitors never trigger 401s; `fetchImpl` is for tests.
 */
export function makeSocketSend(
  getReceive: () => SocketReceive | undefined,
  canGet: () => boolean = () => true,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): (type: string, data?: unknown) => void {
  const pending = new Map<string, Promise<void>>();

  const evalGet = (d: EvalGetData): void => {
    if (!d || typeof d.fen !== 'string' || typeof d.path !== 'string' || !canGet()) return;
    if (d.variant && d.variant !== 'standard' && d.variant !== 'fromPosition') return;
    const multiPv = Math.max(1, Math.min(MAX_MULTI_PV, Math.round(d.mpv ?? 1)));
    const key = `${d.fen}|${multiPv}|${d.path}`;
    if (pending.has(key)) return;
    // a miss is the usual answer: asked for as `pvs: []` rather than a 404 the console would show
    const query: Required<Pick<CloudEvalQuery, 'fen' | 'emptyOnMiss'>> = { fen: d.fen, emptyOnMiss: '1' };
    const params = new URLSearchParams({ ...query, multiPv: String(multiPv) });
    const job = fetchImpl(`${API_ROUTES.cloudEval}?${params}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async res => {
        // 404 (a server that ignores emptyOnMiss) or 204 No Content: no cloud eval for this position
        if (!res.ok || res.status === 204) return;
        const ev = (await res.json()) as CloudEvalResponse;
        if (!ev || !Array.isArray(ev.pvs) || !ev.pvs.length) return; // pvs: [] — no cloud eval
        getReceive()?.('evalHit', { ...ev, fen: d.fen, path: d.path });
      })
      .catch(() => undefined)
      .finally(() => pending.delete(key));
    pending.set(key, job);
  };

  return (type: string, data?: unknown) => {
    if (type === 'evalGet') evalGet(data as EvalGetData);
  };
}
