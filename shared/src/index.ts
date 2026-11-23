/**
 * @outpost/shared: the API contract (api.ts), the profile filter schema (filters.ts) and pure
 * chess helpers (chess.ts). Import the subpaths (`@outpost/shared/api`) or this barrel.
 * The package exports TypeScript source: Node's type stripping and Vite consume it directly.
 */
export * from './api.ts';
export * from './chess.ts';
export * from './filters.ts';
