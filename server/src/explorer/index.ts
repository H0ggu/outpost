// Lichess-compatible explorer endpoints over Outpost's data (player, reference, games at a position)
// and the masters / lichess / tablebase / cloud-eval proxies with caching in http_cache, plus the
// NNUE network cache — PLAN §6, §8.3 (owner: explorer). Routes: routes/explorer.ts, routes/assets.ts.
//
//   - local.ts: createLocalExplorer — player explorer (NDJSON line), reference explorer (masters
//     shape), /api/explorer/games; built on gameSet.ts (player specs → row sources), query.ts
//     (filters + lila restrictions → SQL, hits at a position), responses.ts (Lichess shapes).
//   - proxy.ts: createExplorerProxy — explorer.lichess.org, tablebase.lichess.ovh and
//     lichess.org/api/cloud-eval through app.upstream, with cache.ts (http_cache) and budget.ts
//     (per-minute FIFO request budgets).
//   - nnue.ts: createNnueStore — verified, atomic, shared downloads of Stockfish networks.
export { RequestBudget, BudgetError, type BudgetOptions } from './budget.ts';
export { CACHE_POLICY, cacheKey, ExplorerCache, freshness, type CacheEntry, type CacheKind } from './cache.ts';
export { neutralFilters, parseSpecOrThrow, referenceGameSet, resolveGameSet, type GameSet } from './gameSet.ts';
export { createLocalExplorer, type LocalExplorer } from './local.ts';
export { createNnueStore, NNUE_NAME_RE, NnueError, parseRange, type NnueStore } from './nnue.ts';
export { gamePgn, loadPgnGame } from './pgn.ts';
export { resolvePosition, type ExplorerPosition } from './position.ts';
export { createExplorerProxy, DEFAULT_BUDGETS, proxyHttpError, type ExplorerProxy, type ProxyResult } from './proxy.ts';
export { collectHits, gamesAtPosition, hitsQuery, setConditions, type Hit } from './query.ts';
export { EXPLORER_LIMITS, fideDp, mastersResponse, performanceRating, playerResponse } from './responses.ts';
