# Conventions for Outpost modules

Read `docs/PLAN.md` first; this page is the "how" for code that lands in the scaffold.

## Ground rules

- **The contract is `shared/src/api.ts`.** Server routes return exactly those types and the web app
  consumes them. If a shape must change, change it there first and keep every workspace compiling.
- **Dependencies are frozen.** Don't add npm packages (the Studio module may add what vendored lila needs).
  Node built-ins cover crypto, zstd (`node:zlib`), SQLite (`node:sqlite`) and fetch.
- **Stay in your lane.** Each module owns its files below; touching another module's files causes merge
  conflicts between parallel branches. `app.ts`, `main.ts` and the shared kit should not need changes.
- Before handing back: `npm run typecheck && npm test && npm run build` must pass.

## Ownership

| Module | Server | Web | Migrations |
|---|---|---|---|
| auth | `routes/auth.ts`, `routes/admin.ts`, `auth/*` | — | 100–199 |
| jobs (sync + jobs) | `routes/jobs.ts`, `jobs/*`, `sync/*`, `chess/*` | — | 200–299 |
| stats | `routes/stats.ts`, `routes/games.ts`, `stats/*` | — | 300–399 |
| explorer | `routes/explorer.ts`, `routes/assets.ts`, `explorer/*` | — | 400–499 |
| profiles | `routes/{search,profiles,databases,files,prep}.ts`, `profiles/*` (+ helper folders of the same names) | — | 500–599, 700–799 |
| reference | `routes/{reference,broadcasts}.ts`, `reference/*`, `broadcasts/*` | — | 600–699 |
| studio | — | `src/studio/*`, `studio.html`, `tsconfig.studio.json`, `vite.config.ts` (Studio glue), `web/vendor` via `scripts/lila-patches/` | — |

Tests follow the same ownership: name server test files after your module (`server/test/<module>-*.test.ts`)
and only edit your own. The scaffold's own tests (`app`, `config`, `db`, `jobs-queue`, `upstream`, `chess-store`,
`filter-sql`, `access`) cover the cross-module API below; the owning module may extend them.

## Cross-module server API (use it, don't re-implement it)

These already exist with final signatures (and working bodies) so parallel branches agree. The owner may
optimise a body but not change a signature or its semantics without updating every caller.

| Need | Call | Owner |
|---|---|---|
| Any Lichess / Chess.com / other upstream request | `app.upstream.fetch/json(url, {auth, signal, allowStatuses})` (`src/http/upstream.ts`); in a job `ctx.upstream`. Map failures with `upstreamHttpError(e)`. | shared kit |
| Enqueue work, show it | `enqueueJob`, `enqueueSync`, `getJob`, `toJobInfo`, `queuePosition`, `sourceSyncStatus` (`src/jobs/`) | jobs |
| Run your job kind | `registerJobHandler(kind, handler)` from your route plugin (`src/jobs/handlers.ts`) | jobs |
| Store games | `NormalizedGame` + `insertGame` (only writer of `games`/`positions`/`player_games`), `rebuildPlayerGames` (`src/chess/store.ts`) | jobs |
| Read PGN | `parsePgnGames` (stream), `pgnToNormalizedGame` (`src/chess/pgn.ts`) | jobs |
| Opening names, positions | `getOpeningBook` + `classifyOpening` / `openingAt`, `posKey`, `posKeyAfterLine` (`src/chess/`) | jobs |
| Filters → SQL | `playerGamesWhere(filters, { sourceIds })` (`src/stats/filterSql.ts`) | stats |
| Game lists | `GAME_ROW_SELECT` + `toGameRow`, `DB_GAME_ROW_COLUMNS` + `toDbGameRow` (`src/stats/gameRows.ts`) | stats |
| Read a profile / database | `loadProfileForViewer(db, slug, req.user)`, `loadDatabaseForViewer` (`src/profiles/access.ts`) | profiles |
| Reference players in search | `searchReferencePlayers` (`src/reference/index.ts`; returns `[]` until reference implements it) | reference |
| web-profile | — | `src/app/pages/profile/*` (+ a filters bar under `src/app/pages/profile/`) | — |
| web-other | — | every other file in `src/app/pages/` | — |

## Server (Fastify 5, Node type stripping)

- Run directly with `node`: relative imports keep `.ts`, type-only imports use `import type`, and no enums,
  namespaces or parameter properties (`erasableSyntaxOnly`).
- One plugin per area in `src/routes/`, thin; logic lives in the module folder. Build paths from
  `API_ROUTES` with `:param` placeholders: `app.get(API_ROUTES.profile(':slug'), { preHandler: requireViewer }, …)`.
- Access: `optionalUser`, `requireUser`, `requireViewer` (anonymous only when `anonymousBrowsing`),
  `requireAdmin` from `src/auth/session.ts`; `req.user` is then set. Per-object checks (private profile,
  owner) stay in the route.
- Validation: `parseBody/parseQuery/parseParams(schema, …)` and `parseFiltersQuery(req.query)` from
  `src/http/validate.ts`. Errors: throw `HttpError` or the helpers in `src/http/errors.ts`; the error
  handler produces `{error:{code,message,details?}}`.
- Non-GET requests already pass the CSRF/Origin check before your handler. Security headers are global.
- Rate limits: `@fastify/rate-limit` is registered with `global: false`; opt in per route with
  `config: { rateLimit: { max, timeWindow } }`.
- Background work (workers, schedulers, setup-token logging) starts in your plugin with
  `app.addHook('onReady', …)` and stops in `app.addHook('onClose', …)`. Anything that runs jobs or calls
  upstream on a timer starts **only when `app.config.startWorkers`** (env `OUTPOST_WORKERS`, off under
  `NODE_ENV=test`), so tests that enqueue jobs never reach Lichess or Chess.com.
- Upstream: **never call `fetch()` directly**. Use `app.upstream` (jobs: `ctx.upstream`): it sends the
  User-Agent, adds the Lichess token only for Lichess hosts and only with `auth: 'optional' | 'required'`,
  shares one per-host 429 cool-down between all modules (Lichess limits per token and IP) and times out.
  The Lichess token never reaches the browser.
- Settings: `readSettings(app.db, app.config)` (env wins for the Lichess token and Chess.com contact).

## Database (`node:sqlite`)

- `app.db.get/all/run/value/iterate(sql, params)` with cached statements; `app.db.tx(() => …)` is
  synchronous (BEGIN IMMEDIATE; nested calls use savepoints). Heavy imports: a worker thread with its own
  `openDb(config.dbPath)`.
- Times are epoch **ms**, booleans 0/1 (JS booleans bind fine), JSON in `*_json` TEXT. Tables are STRICT.
- New schema = a new file `server/src/db/migrations/NNN_name.sql` in your range; never edit an applied
  one. Table rebuilds: add `-- outpost:foreign-keys-off` (see `db/migrate.ts`).
- `positions.pos_key` = `posKey(epd)` from `src/chess/posKey.ts`; `next_uci` in standard castling
  (`stdUci` from `@outpost/shared/chess`). Duplicate keys for PGN/reference games: see `001_init.sql`.

## Web (React 19, React Router 8 data mode, TanStack Query 5)

- Data: `api` from `src/app/api/client.ts` (adds `X-Outpost: 1`, throws `ApiError`) and hooks in
  `src/app/api/hooks.ts`; add page-specific hooks next to your pages with keys under `queryKeys`.
  Stats hooks take `filters` plus the endpoint's own params (`OpeningsParams`, …), which never reuse a
  filter key (`statsQuery` throws if they do); the rating chart narrows `filters.src`/`filters.tc`.
- Links: `paths` in `src/app/paths.ts`. The Studio is a separate page — use `<a href>` or
  `ButtonLink reloadDocument`, never an SPA `<Link>`.
- Filters live in the URL: `useUrlFilters()`; serialise with `@outpost/shared/filters`.
- UI kit: `src/app/components` (Box/Card, Button, Tabs, Table, WdlBar, Spinner, EmptyState, ErrorBox,
  FlagEmoji, TimeClassIcon, Icon + `licon`). `Board` and `PgnViewer` are imported from their files.
  Use lila class names and the CSS tokens in `src/styles/lichess-theme.css` (dark / true-black / light);
  layouts must work at 360 px.
- Cross-origin isolation (COEP `require-corp`): no external images, fonts, scripts or iframes — avatars
  are not shown, flags are emoji.

## Tests

- Vitest per workspace (`*/test/**/*.test.ts[x]`); `npm test` runs them all.
- Server: `makeTestApp()`, `createUserSession()` and `mutationHeaders` in `server/test/helpers.ts`.
  Tests have no network: `makeTestApp({ fetch })` injects a fake fetch for `app.upstream` (the default one
  throws). Workers don't run in tests; call your job handler directly with `makeJobContext(t, kind, payload)`.
  Seed games with `insertGame(t.db, testGame({...}))` so rows look like production ones.
  Fixtures go in `server/test/fixtures/` and are synthetic or hikaru-only (no private individuals' data).
