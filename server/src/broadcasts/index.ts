// Live Lichess broadcasts proxy (list, tour, round previews with a 5 s cache, round PGN) — PLAN §5,
// §6 (owner: reference). Every upstream call carries the Lichess token (auth: 'required'); without
// one the routes answer 503 `upstream_unavailable` with `details.reason: 'no_token'`.
export {
  BROADCAST_ID_RE,
  fetchOfficialBroadcasts,
  fetchRound,
  fetchRoundPgn,
  fetchTour,
  standardLastMove,
  toBroadcastRound,
  toBroadcastsResponse,
  toBroadcastSummary,
  toGamePreview,
  type LichessRoundResponse,
  type LichessTourWithRounds,
} from './lichess.ts';
export { BROADCAST_CACHE_MS, BroadcastService, TtlCache } from './service.ts';
