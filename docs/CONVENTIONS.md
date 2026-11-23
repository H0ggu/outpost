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
| profiles | `routes/{search,profiles,databases,files,prep}.ts` (+ helper folders of the same names) | — | 500–599, 700–799 |
| reference | `routes/{reference,broadcasts}.ts`, `reference/*`, `broadcasts/*` | — | 600–699 |
| studio | — | `src/studio/*`, `studio.html`, `vite.config.ts` (Studio glue), `web/vendor` via `scripts/lila-patches/` | — |
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
  `app.addHook('onReady', …)` and stops in `app.addHook('onClose', …)`.
- Settings: `readSettings(app.db, app.config)` (env wins for the Lichess token and Chess.com contact).
  Upstream requests send `userAgent(config.version, settings.chesscomContact)`. The Lichess token never
  reaches the browser.

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
  Fixtures go in `server/test/fixtures/` and are synthetic or hikaru-only (no private individuals' data).
