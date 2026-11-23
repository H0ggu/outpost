# Conventions for Outpost modules

Read `docs/PLAN.md` first; this page is the "how" for code that lands in the scaffold.

## Ground rules

- **The contract is `shared/src/api.ts`.** Server routes return exactly those types and the web app
  consumes them. If a shape must change, change it there first and keep every workspace compiling.
- **Policies and limits shared by both sides are contract constants**, never copies: the account
  policy (`ACCOUNT_USERNAME_RE`, `USERNAME_MIN/MAX_LENGTH`, `PASSWORD_MIN/MAX_LENGTH`), PGN sizes
  (`PGN_UPLOAD_MAX_BYTES`, `PGN_PASTE_MAX_BYTES`), search lengths (`SEARCH_QUERY_MIN/MAX_LENGTH`),
  `OPENINGS_RANK_MIN_GAMES`, `EVENT_SUGGESTIONS_MAX`.
- **Dependencies are frozen.** Don't add npm packages (the Studio module may add what vendored lila needs).
  Node built-ins cover crypto, zstd (`node:zlib`), SQLite (`node:sqlite`) and fetch.
- **Stay in your lane.** Each module owns its files below; touching another module's files causes merge
  conflicts between parallel branches. `app.ts`, `main.ts` and the shared kit should not need changes.
- Before handing back: `npm run typecheck && npm test && npm run build` must pass.

## Ownership

The modules were built in parallel and merged on 2026-11-23. Since then ownership no longer restricts
edits, but keep each area's structure and conventions: the table still says where things live.

| Module | Server | Web | Migrations |
|---|---|---|---|
| auth | `routes/auth.ts`, `routes/admin.ts`, `auth/*` | — | 100–199 |
| jobs (sync + jobs) | `routes/jobs.ts`, `jobs/*`, `sync/*`, `chess/*` | — | 200–299 |
| stats | `routes/stats.ts`, `routes/games.ts`, `stats/*` | — | 300–399 |
| explorer | `routes/explorer.ts`, `routes/assets.ts`, `explorer/*` | — | 400–499 |
| profiles | `routes/{search,profiles,databases,files,prep}.ts`, `profiles/*` (+ helper folders of the same names) | — | 500–599, 700–799 |
| reference | `routes/{reference,broadcasts}.ts`, `reference/*`, `broadcasts/*` | — | 600–699 |
| studio | — | `src/studio/*` (incl. `src/studio/lila-types/`), `studio.html`, `tsconfig.studio.json`, `vite.config.ts` (Studio glue), `web/vendor` via `scripts/lila-patches/` | — |
| web-profile | — | `src/app/pages/profile/**` (tab pages, `ProfileLayout`, the filters bar, profile-only hooks, components and CSS) | — |
| web-other | — | every other file under `src/app/pages/` (incl. `admin/`), plus `src/app/Layout.tsx` (site chrome) | — |

Server paths are under `server/src/`, web paths under `web/`.

**Shared web kit (frozen for both web modules and Studio).** `src/app/{main.tsx,router.tsx,paths.ts,prefs.ts,RouteError.tsx}`,
`src/app/api/*`, `src/app/components/*`, `src/lichess/*` and `src/styles/*` already cover every §9 route,
path and shared hook. Don't edit them; put new code next to your pages instead:

- components: `src/app/pages/profile/components/*` (web-profile) or `src/app/pages/components/*` (web-other);
- hooks: `src/app/pages/profile/hooks.ts` or `src/app/pages/hooks.ts`, with query keys built from the
  existing `queryKeys` prefixes (e.g. `[...queryKeys.profile(slug), 'explorer-games', …]`) rather than
  new entries in `queryKeys`;
- CSS: a `.css` file next to the page that imports it, using the tokens and class names of
  `src/styles/*`.

If a frozen file is wrong or truly missing something, make the smallest additive change and list it in
your hand-back report so it can be reconciled at merge. Promoting a page-local component to the kit
happens at integration, not on a module branch.

Tests follow the same ownership: name test files after your module (`server/test/<module>-*.test.ts`,
`web/test/<module>-*.test.tsx`) and only edit your own. The scaffold's own tests (`app`, `config`, `db`, `jobs-queue`, `upstream`, `chess-store`,
`filter-sql`, `access`) cover the cross-module API below; the owning module may extend them.

## Cross-module server API (use it, don't re-implement it)

These already exist with final signatures (and working bodies) so parallel branches agree. The owner may
optimise a body but not change a signature or its semantics without updating every caller.

| Need | Call | Owner |
|---|---|---|
| Any Lichess / Chess.com / other upstream request | `app.upstream.fetch/json(url, {auth, signal, allowStatuses})` (`src/http/upstream.ts`); in a job `ctx.upstream`. Map failures with `upstreamHttpError(e)`. | shared kit |
| Enqueue work, show it | `enqueueJob`, `enqueueSync`, `getJob`, `toJobInfo`, `queuePosition`, `sourceSyncStatus` (`src/jobs/`) | jobs |
| Cancel queued work (e.g. a removed source's sync) | `cancelQueuedJobs(db, dedupeKey)` (`src/jobs/`); never `UPDATE jobs` from another module | jobs |
| Apply the orphan policy (sources no profile uses, their games) | `sweepOrphans(db, {signal})` (`src/profiles/service.ts`; also run after a user is purged) | profiles |
| Run your job kind | `registerJobHandler(kind, handler)` from your route plugin (`src/jobs/handlers.ts`) | jobs |
| Store games | `NormalizedGame` + `insertGame` (only writer of `games`/`positions`/`player_games`), `rebuildPlayerGames` (`src/chess/store.ts`) | jobs |
| Read PGN | `parsePgnGames` (stream), `pgnToNormalizedGame` (`src/chess/pgn.ts`) | jobs |
| Opening names, positions | `getOpeningBook` + `classifyOpening` / `openingAt`, `posKey`, `posKeyAfterLine` (`src/chess/`) | jobs |
| Filters → SQL | `playerGamesWhere(filters, { sourceIds })` (`src/stats/filterSql.ts`) | stats |
| Game lists | `GAME_ROW_SELECT` + `toGameRow`, `DB_GAME_ROW_COLUMNS` + `toDbGameRow` (`src/stats/gameRows.ts`) | stats |
| Read a profile / database | `loadProfileForViewer(db, slug, req.user)`, `loadDatabaseForViewer` (`src/profiles/access.ts`) | profiles |
| Reference players in search | `searchReferencePlayers(db, q, {limit, viewer})` (`src/reference/index.ts`); pass the viewer | reference |
| Lila explorer settings → conditions | `explorerQueryRestrictions(query)` (`@outpost/shared/filters`): ANDed with the filters; never match `speeds`/`modes` literally | shared |
| pgn source keys | `pgnSourceKey(databaseId, name)` (`src/chess/store.ts`): the only builder of `sources.key` for `pgn`; `NewSourceInput.key` is the name as written in the PGN | jobs |

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
  `src/app/api/hooks.ts` (which also has `useDebouncedValue`, promoted from the library pages); add page-specific hooks next to your pages, with keys under the existing
  `queryKeys` prefixes (see "Shared web kit" above).
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

## Studio (vendored lila)

- **Vendored lila is never type-checked** (PLAN §1). Import it only as `lila/<package>/<module>`
  (`lila/analyse/start`, `lila/site/asset`, `lila/lib/licon`, …). Vite resolves that to
  `web/vendor/lila/<package>/src/<module>`; `tsconfig.studio.json` resolves it (`paths`) to a declaration
  you write at `src/studio/lila-types/<package>/<module>.d.ts`. Declare only the exports Studio uses, as
  loosely as is safe (e.g. `makeStart`, the parts of `AnalyseOpts` you pass). A missing declaration is a
  TS2307 error, never a silent pull of vendored sources.
- lila's globals (`site`, `i18n`, `$html`, `$trim`, cash `$`) are typed by
  `vendor/lila/@types/lichess/index.d.ts`, which the Studio program includes (declaration files only).
- Never import `web/vendor/lila` by relative path, and never relax `tsconfig.studio.json` to type-check
  lila: `npm run typecheck` (`typecheck:studio-boundary`) fails when any vendored source file enters the
  Studio program.
- lila's own bare imports (`lib`, `lib/*`, `keyboard-move`, `@/…`) are a Vite resolver concern only
  (PLAN §8.2); behaviour changes to vendored files go in `scripts/lila-patches/*.patch`.
- `explorer.endpoint` must be absolute: `explorerEndpoint(location.origin, encodeFiltersSegment(filters))`
  from `@outpost/shared/api`.

## Tests

- Vitest per workspace (`*/test/**/*.test.ts[x]`); `npm test` runs them all.
- Server: `makeTestApp()`, `createUserSession()` and `mutationHeaders` in `server/test/helpers.ts`.
  Tests have no network: `makeTestApp({ fetch })` injects a fake fetch for `app.upstream` (the default one
  throws). Workers don't run in tests; call your job handler directly with `makeJobContext(t, kind, payload)`.
  Seed games with `insertGame(t.db, testGame({...}))` so rows look like production ones.
  Fixtures go in `server/test/fixtures/` and are synthetic or hikaru-only (no private individuals' data).
