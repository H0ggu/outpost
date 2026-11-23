// Live Lichess broadcasts proxy (top list, tour, round previews with a 5 s cache, round PGN) — PLAN
// §5, §6 (owner: reference). Every upstream call carries the Lichess token (auth: 'required');
// without one the routes answer 503 `upstream_unavailable` with `details.reason: 'no_token'`.
export {
  BROADCAST_ID_RE,
  fetchRound,
  fetchRoundPgn,
  fetchTopBroadcasts,
  fetchTour,
  parseTop,
  roundGamePgn,
  standardLastMove,
  toBroadcastRound,
  toBroadcastsResponse,
  toBroadcastSummary,
  toGamePreview,
  topEntrySummary,
  type LichessRoundResponse,
  type LichessTop,
  type LichessTopEntry,
  type LichessTourWithRounds,
} from './lichess.ts';
export { BROADCAST_CACHE_MS, BROADCAST_LIMITS, BroadcastService, RequestBudget, TtlCache } from './service.ts';
