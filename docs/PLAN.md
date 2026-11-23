# Outpost: build plan

Outpost is a self-hosted chess statistics and opponent-preparation app. It does what chessmonitor.com does, using only public Lichess and Chess.com data, and it reuses Lichess's own open-source code and assets wherever possible.

This file is the source of truth for design decisions. The answers given to the module agents' open questions at integration, each with its reason, are in `docs/DECISIONS.md`. The research behind it is in `docs/research/`:

| File | Covers |
|---|---|
| `lichess-api.md` | Lichess API |
| `chesscom-api.md` | Chess.com API |
| `chessmonitor-features.md` | ChessMonitor feature inventory |
| `web-libs.md` | Libraries |
| `lila-ui-extraction.md` | Vendoring the Lichess analysis board |
| `lichess-packages-assets.md` | Lichess packages and assets, with licences |

## 0. Principles
1. **Lichess first.** Use Lichess's polished code before writing our own:
   - chessground for the board
   - chessops for chess logic and PGN
   - pgn-viewer for read-only game replays
   - stockfish-web for the engine
   - **lila's own analysis board** (`ui/analyse`, vendored) for the Studio and every interactive explorer
   - lila's piece sets, boards, sounds, fonts, icon font and theme colours

   Only write new UI where Lichess has nothing: the stats pages, the profile pages and the admin pages.
2. **Self-hosted and network-agnostic.**
   - One container and one port, deployed with plain `docker compose`.
   - Configured with `PUBLIC_ORIGIN` and `TRUSTED_PROXIES`.
   - Safe to expose to the public internet: auth, rate limits, strict headers.
   - No dependency on any VPN, tunnel or reverse proxy.
3. **No scraping.** Use only official public APIs (Lichess API, Chess.com PubAPI) and openly licensed data (database.lichess.org, lichess-org/chess-openings). Never scrape ChessMonitor or undocumented Chess.com endpoints.
4. **Licence: AGPL-3.0-or-later.** Attribution lives in `NOTICE.md`. Leave out non-free Lichess assets: alpha, california and the other CC BY-NC-SA piece sets, the `standard` sounds, and the logo.
5. **Pluggable reference database.** The over-the-board ("Ultra"-style) database is any PGN collection. Lichess broadcasts are the first source, and the owner may add a licensed OTB database later without code changes.

## 1. Stack
| Layer | Choice |
|---|---|
| Runtime | **Node 26 LTS**. Server TypeScript runs directly through Node's type stripping (no build step), so it needs `erasableSyntaxOnly`, `.ts` import extensions, and no enums or parameter properties. |
| Server | **Fastify 5**, with @fastify/static, @fastify/cookie and @fastify/multipart. Validation with **zod 4**. |
| DB | **`node:sqlite`** (`Database`; Node ≥ 26.11). One file at `${DATA_DIR}/outpost.db`. WAL mode. SQL migrations in `server/src/db/migrations/NNN_name.sql`, applied in order. |
| Web | **Vite 8** multi-page app: `index.html` is the React SPA; `studio.html` is the vendored lila analyse app. **React 19 + React Router 8** in data mode, **TanStack Query 5**. |
| Board and chess | `@lichess-org/chessground@10.5.0`, `chessops@0.15.1`, `@lichess-org/pgn-viewer@2.7.3`, `snabbdom@3.5.1` |
| Engine | `@lichess-org/stockfish-web`, driven by lila's ceval. It needs cross-origin isolation, which we set on every response. The lila fallback engine covers browsers that aren't isolated. |
| Charts | d3 modules (scale, shape, array, geo) with React-rendered SVG, plus `world-atlas` and `topojson-client` for the map |
| Tests | **Vitest 5** |
| Typecheck | TypeScript 7 (`tsc --noEmit`). Vendored lila code is excluded from our own typecheck: `src/studio` imports it as `lila/<package>/<module>`, which Vite maps to `web/vendor/lila/<package>/src/<module>` and `web/tsconfig.studio.json` (`paths`) maps to hand-written declarations in `src/studio/lila-types/`. Only lila's ambient `@types/lichess` declarations are included. `npm run typecheck` fails if a vendored source file enters any program. |
| Package manager | npm workspaces: `shared`, `server`, `web` |

## 2. Repository layout
```
outpost/
  package.json            # workspaces, scripts: dev, build, test, typecheck, vendor
  tsconfig.base.json
  shared/src/             # types + pure helpers shared by server and web
    api.ts                #   API request/response types (the contract, see §6)
    filters.ts            #   filter query schema + (de)serialisation
    chess.ts              #   time-class mapping, result helpers, UCI castling normalisation
  server/src/
    main.ts               # entry: config → db → migrate → app.listen
    config.ts             # env parsing
    app.ts                # buildApp(): registers plugins + route modules
    db/{index.ts,migrate.ts,migrations/*.sql}
    http/                 # security headers, CSRF/origin check, rate limit, errors, upstream client
    auth/                 # passwords (scrypt), sessions, TOTP, setup token
    jobs/                 # persistent job queue + worker + scheduler
    sync/                 # lichess + chesscom clients, importers, geo lookup
    chess/                # position keys, opening classifier, PGN helpers, game store (insertGame)
    stats/                # profile statistics queries, filter → SQL
    explorer/             # Lichess-compatible explorer endpoints + proxies
    profiles/             # profile/database access checks, search, databases, files, prep
    reference/            # broadcast / OTB reference DB import + player index
    broadcasts/           # live Lichess broadcasts proxy
    routes/               # one Fastify plugin per area (thin; logic lives in modules)
  server/data/openings/{a..e}.tsv   # lichess-org/chess-openings (CC0); config.openingsDir
  web/
    index.html  studio.html
    public/lichess/{piece,board,sound,font}/   # vendored lila assets (see NOTICE.md)
    src/app/              # React SPA: routes, pages, components
    src/styles/           # lichess-theme.css (tokens; dark, true-black, light) + components.css
    src/studio/           # Studio entry: site shim, socket shim, mount, Outpost chrome
    vendor/lila/          # pinned copy of lila ui/{analyse,lib,keyboardMove,site/src,editor/src,@types/lichess}
  scripts/vendor-lichess.sh   # reproducible vendoring (sparse clone lila @ pinned commit, cp -L)
  Dockerfile  docker-compose.yml  .env.example  NOTICE.md  LICENSE  README.md
```
Vendored lila commit: **`b071608bc4ce71b31cda36ffa493100e3dc3580f`** (2026-11-22). Never merge upstream into it; re-vendor deliberately when needed.

## 3. Configuration (env)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind (Docker always binds `0.0.0.0` inside the container) |
| `PUBLIC_ORIGIN` | (required in production) | e.g. `https://chess.example.com`. Used for the Origin/CSRF check and absolute links. |
| `TRUSTED_PROXIES` | empty | IPs, CIDRs or `loopback`/`linklocal`/`uniquelocal`, passed to Fastify `trustProxy`. Gives correct client IPs for rate limits. `true`/`*` is refused (any client could spoof its IP). |
| `DATA_DIR` | `./data` | Holds the SQLite file, NNUE cache and uploads |
| `LICHESS_TOKEN` | empty | Personal token (any scope; `study:read` recommended). **Required** for the Lichess opening explorer, live broadcasts and broadcast round imports (including auto-import). Also speeds up game export. The admin can also set it in the UI; env wins. (Outpost's own player explorer reads local data and needs no token.) |
| `CHESSCOM_CONTACT` | empty | Contact text put in the Chess.com User-Agent, `Outpost/<ver> (self-hosted; contact: <value>)`. Chess.com returns 403 to anonymous user agents. The admin can set it in the UI. |
| `SOURCE_URL` | empty | Public URL of this instance's source code (AGPL-3.0 §13). Sent as `SessionInfo.sourceUrl`; the footer links to it, or to the AGPL text and NOTICE when unset. |
| `SETUP_TOKEN` | generated, printed to logs | One-time token to create the first admin |
| `LOG_LEVEL` | `info` | Log level |
| `OUTPOST_WORKERS` | `true` (`false` when `NODE_ENV=test`) | Start the job workers, the auto-refresh scheduler and any other upstream-calling timer (`config.startWorkers`) |
| `NODE_ENV` | `development` | `npm start` and Docker force `production`; `npm run dev` is development |

## 4. Data model (SQLite)
Migration `001_init.sql` creates the following. Later modules add their own migrations in reserved number ranges:

| Module | Range |
|---|---|
| auth | 100–199 |
| sync/jobs | 200–299 |
| stats | 300–399 |
| explorer | 400–499 |
| profiles/db/files | 500–599 |
| reference/broadcasts | 600–699 |
| prep | 700–799 |

Migrations at integration (2026-11-23), applied in number order on a fresh database:
`001_init`, `100_auth_totp`, `101_auth_activity` (last seen, deleting users, known devices),
`200_jobs_scheduler`, `201_job_checkpoints`, `300_stats_indexes` (`games_stats` covering index),
`400_explorer_cache_status`, `401_explorer_database_stats` (triggers + `games_explorer_db` index: a
later rebuild of `games` must recreate them), `500_databases_files`, `501_sources_autoincrement`,
`503_files_quota`, `600_reference`, `601_reference_fide_dedupe` (the one FIDE rule: `fide` sources
link reference games only, one copy per game; decision 1). There is no `502` (merged into `601`).

- **users** `(id, username UNIQUE COLLATE NOCASE, password_hash, role 'admin'|'user', disabled, totp_secret, created_at, prefs_json)`
- **sessions** `(id_hash PK, user_id, created_at, expires_at, last_seen_at, ip, user_agent)`
- **invites** `(code PK, created_by, created_at, expires_at, used_by, used_at)`
- **instance_settings** `(key PK, value)`
- **sources** `(id, kind 'lichess'|'chesscom'|'fide'|'pgn', key, display_name, site_user_id, title, country, profile_json, sync_state_json, last_synced_at, last_sync_error, created_at, UNIQUE(kind,key))`. One row per sync identity. `key` is the lowercase username, the FIDE id, or `<databaseId>:<playerKey(name)>` (built only by `pgnSourceKey`).
- **profiles** `(id, slug UNIQUE, display_name, owner_user_id, visibility 'private'|'public', auto_refresh, created_at, updated_at, views)`
- **profile_sources** `(profile_id, source_id, hidden, PRIMARY KEY(profile_id, source_id))`
- **bookmarks** `(user_id, profile_id, created_at, PK(user_id, profile_id))`
- **games**: one row per distinct game.
  - Columns: `(id, origin 'lichess'|'chesscom'|'pgn'|'reference', origin_id, url, database_id NULL, white, black, white_key, black_key, white_rating, black_rating, white_title, black_title, white_fide_id, black_fide_id, result '1-0'|'0-1'|'1/2-1/2', termination, time_class, time_control, rated, variant, event, round, started_at, ended_at, ply_count, moves_san, eco, opening_name, opening_ply, accuracy_white, accuracy_black, headers_json, UNIQUE(origin, origin_id))`
  - `termination` is one of `mate|resign|timeout|abandon|agreement|repetition|stalemate|insufficient|fifty|timeout_vs_insufficient|other`.
  - `time_class` is one of `bullet|blitz|rapid|classical|correspondence|unknown`.
  - Only standard chess is stored: no variants, no games against engines, no from-position games.
- **player_games**: one row per (source, game) from that player's side. This is the table the stats query.
  - Columns: `(source_id, game_id, color 'w'|'b', outcome 'w'|'d'|'l', rating, rating_after, opp_name, opp_key, opp_rating, opp_title, opp_source_kind, ended_at, time_class, rated, PRIMARY KEY(source_id, game_id))`
  - Index on `(source_id, ended_at)`.
- **positions** `(game_id, ply, pos_key INTEGER, next_uci TEXT NULL)` for the first **50 plies**.
  - Index `(pos_key, game_id)`.
  - `pos_key` is a 53-bit integer taken from the SHA-1 of the chessops EPD (`makeFen(setup,{epd:true})`, which only includes a legal en-passant square), so transpositions merge.
  - `next_uci` uses standard castling notation (e1g1).
- **players_cache** `(kind, key, country, title, name, fetched_at, PK(kind,key))`: opponent country and title for the world map.
- **databases** `(id, owner_user_id, name, kind 'games'|'reference', visibility, source_label, licence, created_at, game_count)`
- **files** `(id, owner_user_id, folder, name, kind 'study'|'repertoire', color NULL, pgn, created_at, updated_at, deleted_at NULL)`: Studio "My Files". Deleting a file soft-deletes it into the recycle bin.
- **jobs** `(id, kind, payload_json, status 'queued'|'running'|'done'|'error'|'cancelled', priority, user_id, progress_json, error, created_at, started_at, finished_at, dedupe_key)`
- **http_cache** `(key PK, body, content_type, fetched_at, etag)`: cache for Lichess explorer and masters responses.
- **prep_sets** `(id, owner_user_id, name, created_at)`, **prep_opponents** `(prep_id, profile_id)`

## 5. Feature map (ChessMonitor → Outpost)
Every row is in scope. "Lila" means the feature is reused from vendored lila code.

| ChessMonitor feature | Outpost implementation |
|---|---|
| Link Chess.com/Lichess accounts (multiple), merged profile | A profile is a set of `sources` (Lichess usernames, Chess.com usernames, a FIDE id from the reference DB, or a player name inside a PGN database). No limit on the number of accounts. No OAuth needed: these are public usernames. |
| View any player / create and update other profiles | Any user can create a profile for any player from search. Profiles are private by default, can be renamed, and can merge several accounts. |
| Profile tabs: Overview, Games, Explorer, Openings, Opponents (most played, famous/titled, behaviour), World Map, Activity, Rating | React pages over `stats/` endpoints. The Explorer tab embeds the lila analysis board (`/studio?embed=explorer…`) with the explorer opened on this profile's own data. |
| Filters: colour, date presets and custom range, time control (multi), source/account (multi), rated/unrated, outcome (multi), opponent strength (relative), opponent name, event, position (line) | One shared filter schema (`shared/filters.ts`) stored in the URL query and applied by every stats endpoint and the player explorer |
| Explorer with transpositions, W/D/L bars, last played, games at a position, engine eval | Lila explorer UI over our `/api/explorer/player` (position-keyed, so transpositions merge) plus lila ceval. "All N games" under the player explorer's recent games lists every game at the position (`/api/explorer/games`, paged, same filters and lila settings): in the Studio's side panel, whose rows open in the Studio; in the profile Explorer tab, as the Games tab at that line. The bars follow the viewer's `winratePerspective` (the player's wins / draws / losses, or White / Black). Per-move engine evals in the explorer are a stretch goal. |
| Openings table (most played / best / worst, min/max moves, min games), with a click-through to the explorer | `stats/openings`; a click opens the Explorer tab at that line |
| Update button, queue, cooldown, daily auto refresh, high-priority updates | Persistent job queue with one worker per upstream site (each site is rate-limited separately). Queue position is shown in the UI, there is a cooldown setting, and an auto-refresh schedule (per-profile toggle, hour set by the admin). |
| Bookmarks, players list | Bookmarks per user; a Players page listing public profiles, bookmarks and recently viewed |
| Private profile, custom page address, hide one account | `visibility`, editable `slug`, `profile_sources.hidden` |
| Unified search (Lichess, Chess.com, reference DB) | `/api/search`: Lichess autocomplete, Chess.com exact-username check, a local index of known usernames, reference-DB player names and FIDE ids, and local profiles |
| Ultra/Masters DB, global explorer, FIDE player pages | Masters explorer is proxied from Lichess (no token needed); the Lichess explorer is proxied with the token. **Local reference DB**: Lichess broadcast monthly dumps (CC BY-SA 4.0) and any PGN. It can replace the masters source in settings. A FIDE player profile is built from reference-DB games (source kind `fide`). |
| Live broadcasts | Broadcasts page: official Lichess broadcasts list, then a round page with a grid of live mini-boards (polled, using the token), then any game opens in the Studio. Finished rounds can be auto-imported into the reference DB. |
| Custom PGN databases (upload/paste, duplicate check, visibility, export, delete) | `databases` + `games(origin 'pgn')`. Duplicate key: same colours, same date, same players, same position after ply 80 (or the final position). Can be attached to a profile as a `pgn` source by player name. |
| PGN bulk export | `GET …/games.pgn` with filters, streamed, at most 10,000 games |
| Studio: board, notation with variations, glyphs and comments, engine (multi-PV, threat, arrows), explorers (masters, online, player, my DBs), PGN/FEN import and export, keyboard shortcuts, themes and piece sets | **Lila analysis board vendored** (all of these come from lila), plus Outpost chrome: My Files sidebar (folders, open/save/save-as, import, recycle bin, search the current position across files), board tabs, layout presets, and settings for board theme, piece set and sound set |
| My Files / repertoires, synced to mobile | `files` table (PGN with variations) behind the authenticated API. The PWA works on phones, so the same files are available everywhere. |
| Tournament preparation (Pro) | **Prep** page: a list of opponents, then per-opponent report cards with their White and Black repertoire (top lines), worst-scoring lines, recent games, activity by time and a jump-to-explorer link. Printable. |
| Elo estimate | Only if we can cite a published conversion; otherwise left out and documented. |
| Mobile app | Responsive layouts + PWA manifest. Lila's analysis board is already mobile-ready. |
| Subscriptions, voting, Discord, partner programme | Not applicable (self-hosted, no tiers) |
| Free-form panel docking (Studio) | Partial: layout presets instead of drag-and-dock |

## 6. HTTP API (the contract)
All endpoints are JSON under `/api` unless marked otherwise. Request and response TypeScript types live in `shared/src/api.ts`, and the server and web must both use them.

**Auth and CSRF:**
- Session cookie `outpost_session`: HttpOnly, Secure when `PUBLIC_ORIGIN` is https, SameSite=Lax.
- Every non-GET request must carry the header `X-Outpost: 1` **and** have an `Origin` equal to `PUBLIC_ORIGIN`. Outside production, the request's own host is also accepted when it is a loopback name (`localhost`, `127.0.0.1`, `[::1]`); to use the dev server from another device, set `PUBLIC_ORIGIN` to the address you open.

**Errors:** `{error:{code, message}}` with the matching HTTP status.

**Common filter query** (`ProfileFilters`, all optional):

| Param | Values |
|---|---|
| `color` | `white` \| `black` |
| `period` | `24h` \| `7d` \| `30d` \| `3m` \| `6m` \| `12m` |
| `from`, `to` | `YYYY-MM-DD` |
| `tc` | csv of time classes |
| `src` | csv of source ids |
| `rated` | `rated` \| `unrated` |
| `outcome` | csv of `w,d,l` |
| `opp` | `-200` \| `-100` \| `100` \| `200` \| `eq` (relative strength, ±100 for eq) |
| `oppName` | text |
| `event` | text |
| `line` | UCI moves csv from the start position: only games that reached the position after this line |

### Session, account and admin
| Method | Path | Notes |
|---|---|---|
| GET | `/api/session` | `{user|null, setupRequired, signupMode, anonymousBrowsing, hasLichessToken, version, sourceUrl?}`; `hasLichessToken` says whether a token is configured (never the token), so the UI explains the Lichess explorer and broadcasts instead of asking for a 503 |
| POST | `/api/setup` | `{token, username, password}` creates the first admin |
| POST | `/api/login` | `{username, password, totp?}` |
| POST | `/api/logout` | |
| POST | `/api/signup` | `{username, password, invite?}` |
| GET/PUT | `/api/me/prefs` | `UserPrefs`: theme `dark`\|`black`\|`light`, boardTheme, pieceSet, soundSet, winratePerspective `player`\|`white`, timezone `local`\|`utc`, studioLayout |
| POST | `/api/me/password` | |
| POST | `/api/me/totp/setup`, `/api/me/totp/enable`, `/api/me/totp/disable` | Setup requires the current password (`TotpSetupRequest`, decision 8); enable takes a code for the pending secret; disable takes the password **or** a code |
| GET | `/api/me/sessions` | |
| DELETE | `/api/me/sessions/:id` | |
| GET/PUT | `/api/admin/settings` | signupMode `closed`\|`invite`\|`open`, anonymousBrowsing, lichessToken (write-only, shown masked), chesscomContact, autoRefreshHourUtc, updateCooldownMinutes, initialSyncMonths (0 = all), mastersSource `lichess`\|`reference:<dbId>`, broadcastAutoImport (default off, decision 22) |
| GET | `/api/admin/users` | |
| PATCH/DELETE | `/api/admin/users/:id` | |
| GET/POST | `/api/admin/invites` | |
| DELETE | `/api/admin/invites/:code` | |
| GET | `/api/admin/jobs` | |
| POST | `/api/admin/jobs/:id/retry`, `/api/admin/jobs/:id/cancel` | |
| GET | `/api/admin/status` | Versions, DB size, token validity, upstream reachability (cached about a minute; `?refresh=1` checks again), job counts per state |
| GET | `/api/jobs/mine` | Queued and running jobs relevant to me, with queue positions |

### Search and profiles
| Method | Path | Notes |
|---|---|---|
| GET | `/api/search?q=` | `{profiles, lichess, chesscom, reference, unavailable?, notSearched?}`; `q` is 2–100 characters (`SEARCH_QUERY_MIN/MAX_LENGTH`). Each list is best hit first (exact username, has a profile here, seen in imported games, titled); `notSearched` names the sites `q` was not sent to because it can't be a username there |
| GET | `/api/profiles` | `?scope=mine\|public\|recent` |
| POST | `/api/profiles` | `{displayName, slug?, sources:[{kind,key,databaseId?}]}`; for `pgn`, `key` is the player's name as written in the PGN and `databaseId` is required |
| GET | `/api/profiles/:slug` | `ProfileHeader`: name, sources with sync status, visibility, owner?, bookmarked, totals, current ratings per source and time class, lastUpdated, queue info |
| PATCH | `/api/profiles/:slug` | displayName, slug, visibility, autoRefresh, hidden source ids |
| DELETE | `/api/profiles/:slug` | |
| POST | `/api/profiles/:slug/sources` | |
| DELETE | `/api/profiles/:slug/sources/:sourceId` | |
| POST | `/api/profiles/:slug/update` | Enqueue a sync for each source; respects the cooldown |
| GET | `/api/profiles/:slug/status` | |
| PUT/DELETE | `/api/profiles/:slug/bookmark` | |
| GET | `/api/bookmarks` | |

Endpoint parameters never reuse a filter key. Mutations return the type listed in `MUTATION_RESPONSES` (`shared/src/api.ts`); those without a richer result return `{ok:true}`.

### Stats (all take the filter query)
| Path | Returns |
|---|---|
| `/api/profiles/:slug/overview` | Per-time-class table (games, current rating, W/D/L); games by colour; termination × result; top White and Black openings; latest games (5); activity for the last 90 days; rating sparkline for the last year |
| `/api/profiles/:slug/games` | `?page&pageSize` (20). Returns `{total, summary:{w,d,l}, games:[GameRow]}` |
| `/api/profiles/:slug/games.pgn` | Streamed `application/x-chess-pgn`, max 10,000 games, player names normalised |
| `/api/profiles/:slug/openings` | `?side=white\|black\|both&order=most\|best\|worst&minGames&minMoves&maxMoves`. Rows: `{eco, name, line (uci csv), games, w, d, l, avgPly}` |
| `/api/profiles/:slug/opponents` | `?view=most\|titled&page`. Rows: `{key, name, kind, title, games, w, d, l, lastRating, lastPlayed}` |
| `/api/profiles/:slug/behaviour` | For each of W, D and L: rows of `{termination, count, pct, avgMoves}` |
| `/api/profiles/:slug/worldmap` | `{countries:[{code (ISO alpha-2), games, opponents, w, d, l}], unknownGames, pendingLookups}` |
| `/api/profiles/:slug/activity` | `?tz=IANA`. Returns `{days:[{date,games,score}], byHour[24], byWeekday[7], grid[7][24]}`, each with games and score |
| `/api/profiles/:slug/rating` | Filters only (narrow the filter's `src`/`tc` to chart one source or time class). Returns `{series:[{sourceId, timeClass, points:[[t, rating]]}], averages:[{n, avgRating, avgOppRating, score}]}` |
| `/api/profiles/:slug/events` | `?q=` only (no filters): event-name suggestions for the filters bar. Returns `{events:[{name, games}]}`, at most 20 distinct events of the visible sources, events starting with `q` first, then substring matches, most played first |

### Games, explorer and proxies
| Method | Path | Notes |
|---|---|---|
| GET | `/api/games/:id` | `{game: GameDetail, pgn}` |
| GET | `/api/explorer/masters`, `/api/explorer/masters/pgn/:id` | Proxy to `https://explorer.lichess.org` (cached 3 h; uses the local reference DB if `mastersSource` is set) |
| GET | `/api/explorer/lichess` | Proxy with token, cached, at most 20 requests/min with a queue |
| GET | `/api/explorer/player` | Lichess-compatible **NDJSON**, one final line. `player=<profile slug>` or `lichess:<user>` / `chesscom:<user>` / `db:<id>` / `ref:<fideId>`. Takes `color, speeds, modes, since, until, fen, play, recentGames, moves`, plus Outpost filters in a path segment: `/api/explorer/f/<base64url(filters)>/player` (lila builds `new URL('./player', endpoint)`, so the query would be lost). Lila's `speeds`/`modes`/`since`/`until` are ANDed with those filters through `explorerQueryRestrictions` (`shared/filters.ts`): `ultraBullet` counts as bullet, and a full speed set or `modes=rated,casual` means no restriction, so PGN and reference games (`unknown` time class, unrated) stay visible. `recentGames[].id` is the Outpost game id prefixed `op` (e.g. `op123`). Outpost extension `games`: every game reaching the position, those that ended there included (lila's totals count moves only), which is the `/api/explorer/games` total. |
| GET | `/api/explorer/reference` | Same shape as masters, from the local reference DB |
| GET | `/api/explorer/games` | `?player&fen\|play&…filters&page`, plus lila's `speeds/modes/since/until` as in the player explorer: games that reach a position |
| GET | `/api/tablebase/:variant` | Proxy to `tablebase.lichess.ovh` (cached). **No session required**: lila's tablebase request omits credentials. |
| GET | `/api/cloud-eval` | Proxy to `lichess.org/api/cloud-eval`. A miss is 404, or 200 with `pvs: []` when the request sets `emptyOnMiss=1` (the Studio does, so the browser logs nothing; decision 12) |
| GET | `/assets/lifat/nnue/:name` | Downloads the NNUE file once from `tests.stockfishchess.org/api/nn/:name` into `DATA_DIR/nnue` and serves it from there. Name allow-list: `^nn-[0-9a-f]{12}\.nnue$`. |

### Databases, files, reference, broadcasts and prep
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/databases` | |
| GET/PATCH/DELETE | `/api/databases/:id` | |
| POST | `/api/databases/:id/import` | Multipart `.pgn` upload (≤ 50 MB, `PGN_UPLOAD_MAX_BYTES`) or `{pgn}` text (≤ 5 MB, `PGN_PASTE_MAX_BYTES`); becomes a job. 429 with 3 imports pending, 403 past the owner's game allowance |
| GET | `/api/databases/:id/games` | |
| GET | `/api/databases/:id/export.pgn` | |
| DELETE | `/api/databases/:id/games/:gameId` | |
| GET | `/api/files` | `?folder&trash=1` |
| POST | `/api/files` | |
| GET/PUT/DELETE | `/api/files/:id` | |
| POST | `/api/files/:id/restore` | |
| GET | `/api/files/search?fen=` | |
| GET | `/api/folders` | |
| GET | `/api/reference` | Databases (the built-in broadcast one flagged `builtin`), counts, broadcast months, licence/attribution |
| GET | `/api/reference/players?q=` | |
| POST | `/api/admin/reference/broadcast-months` | `{months:['YYYY-MM']}` becomes jobs |
| POST | `/api/admin/reference/import` | Multipart PGN or `{url}`; becomes a job into a named reference DB |
| GET | `/api/broadcasts` | Active and recent official broadcasts |
| GET | `/api/broadcasts/tour/:tourId` | |
| GET | `/api/broadcasts/round/:roundId` | Game previews; clients poll every 10 s; server cache 5 s |
| GET | `/api/broadcasts/round/:roundId.pgn` | |
| GET | `/api/broadcasts/round/:roundId/game/:gameId.pgn` | One board's game, cut from the cached round PGN (no extra upstream call) |
| GET/POST | `/api/prep` | |
| GET/PUT/DELETE | `/api/prep/:id` | |
| GET | `/api/prep/:id/report` | Per-opponent `{profile, asWhite:{topLines, worstLines}, asBlack:{…}, recentGames, activity, ratings}` |

## 7. Sync engine
- **Jobs.** Persistent `jobs` table with one in-process worker per lane:
  - `lichess` lane: one request in flight.
  - `chesscom` lane: one request in flight.
  - `local` lane: PGN and reference imports.

  On a 429, back off 60 s or more, with exponential backoff on 5xx. Jobs left `running` at startup go back to `queued`. Every job stores progress for the UI.
  All upstream calls (jobs and routes alike) go through one client, `app.upstream` (`server/src/http/upstream.ts`): User-Agent, token injection for Lichess hosts only, a per-host 429 cool-down shared by every module, and timeouts. Workers and schedulers start only when `config.startWorkers`.
- **Lichess.**
  1. Stream `GET /api/games/user/{u}` as NDJSON with `Accept: application/x-ndjson` and the token. Parameters: `since=<last createdAt+1>`, `sort=dateAsc`, `opening=true`, `accuracy=true`, `perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence`.
  2. Skip games that are a variant, `fromPosition`, against AI, or anonymous.
  3. UltraBullet counts as bullet.
  4. Ratings are stored pre-game; `rating_after = rating + ratingDiff`.
  5. Profile info comes from `GET /api/user/{u}`. Rating charts are built from the synced games (`player_games`), so `/api/user/{u}/rating-history` is not used.
- **Chess.com.**
  1. Fetch `/pub/player/{u}` and `/stats`, then `/games/archives`, then each month in order. Lowercase the username; zero-pad `MM`.
  2. Revalidate months with ETag `If-None-Match`; always re-poll the current and previous month.
  3. Keep only `rules=='chess'`. Use the `time_class` field as given (daily counts as correspondence). Ratings are **post-game**: `rating_after` = rating; `rating` = previous rating in the same class if known, otherwise the same value.
  4. Parse moves from the PGN with chessops. Result codes map per the research notes.
- **After inserting games:**
  1. Classify the opening: the deepest ply among the first 40 whose EPD matches lichess chess-openings.
  2. Write `positions` (50 plies) and `player_games` (one row per source that appears in the game). `fide` sources only link reference-database games, one copy per game across reference databases (migration `601`, decision 1), so a FIDE profile never shows a user's PGN database.
  3. Queue opponent geo lookups: Lichess `POST /api/users` (300 ids per batch, no limit per run); Chess.com `/pub/player/{u}` serially at low priority, most recently met opponents first, at most 1,000 requests per run (the hourly sweep continues after a pause).
- **Scheduling.** Daily auto refresh at `autoRefreshHourUtc` for profiles with `auto_refresh`. Manual updates enforce `updateCooldownMinutes`. The initial import can be limited to the last N months (`initialSyncMonths`).

## 8. Studio (vendored lila analyse)
Follow `docs/research/lila-ui-extraction.md`, option A.
1. **Vendor.** `scripts/vendor-lichess.sh` copies lila's `ui/{analyse,lib,keyboardMove,site/src,editor/src,@types/lichess}` at the pinned commit into `web/vendor/lila`. It also copies `COPYING.md` and the free assets (§0) into `web/public/lichess`. Use `cp -L`.
2. **Build glue.**
   - A Vite resolver plugin maps `lib`, `lib/*`, `keyboard-move` and `@/…` (lila's own imports) to the importing package's `src`. Our Studio code imports lila as `lila/<package>/<module>` (Vite alias; typed by declarations, see §1).
   - Translation XML is turned into `window.i18n` JS (English only).
   - Generate `gen/_wrap.scss`, then compile the three SCSS entry files with `sass`.
   - Runtime `$html`/`$trim` shims; `window.lichess = {}`.
   - Our own `site` shim reuses lila's asset, mousetrap and sound modules, and maps `loadEsm` to dynamic imports.
3. **Mount.** `studio.html` mounts `makeStart(patch)(opts)` on `main.analyse`:
   - `socketSend` shim: `evalGet` goes to `/api/cloud-eval` and the answer comes back as `evalHit`; everything else is a no-op.
   - `explorer.endpoint` is the absolute `${origin}/api/explorer/` (or `…/f/<filters>/`), built with `explorerEndpoint(location.origin, segment?)` from `@outpost/shared/api` (lila resolves `new URL('./<db>', endpoint)`, which throws on a relative base); `tablebaseEndpoint` is `/api/tablebase`.
   - Patch the explorer "player" database so it can target an Outpost profile, and make game links open in Outpost.
   - Local full-game review POSTs to `/analysis/review` on lila's server, so disable it.
4. **Outpost chrome around the board.**
   - My Files sidebar: folders, open, save, save as, import PGN/FEN, recycle bin, and position search via `/api/files/search`.
   - "Position" side panel: the games at a position from the player explorer's "All N games" (`/api/explorer/games` with the explorer's filters segment, colour, speeds, modes and months), a page at a time; a row opens the game at that position.
   - Board tabs, holding multiple PGNs switched with `changePgn`.
   - Layout presets and settings (board theme, piece set, sound set, true-black).
   - Query parameters: `?game=`, `?file=`, `?pgn=`, `?fen=`, `?explorer=player:<slug>&color=`, `?filters=`, `?embed=explorer` (minimal chrome, used in the profile Explorer tab iframe). The embed posts its board's line, position and the explorer's game count to the page (`web/src/app/explorerEmbed.ts`, same origin), so the tab's "N games at this position" and "Open in Studio" follow the board; its "All N games" opens the tab's Games tab at that line.
   - The player explorer's picker suggests bookmarked, own and recent profiles, then the PGN databases the user may read (`db:<id>`, "my DBs"); search adds Lichess / Chess.com accounts and FIDE players (`ref:<fideId>`).
   - The material difference uses lila's `mono` piece set (vendored, GPLv2+; decision 13).
5. **Headers.** Every response sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so stockfish-web can use SharedArrayBuffer. Nothing cross-origin is embedded: we don't show avatars, and flags are emoji or local files.

## 9. Web app (React)
- **Look.** Lichess dark theme tokens (`lichess-theme.css`), with **true black as the default** because the owner uses an OLED screen; dark and light are also available. Typography and the icon font are lila's (`data-icon`, `licon` codepoints). Explorer-style W/D/L bars use lila's colours.
- **Routes:**
  - `/`, `/login`, `/setup`, `/signup`, `/search`
  - `/u/:slug` and its tabs: `games`, `explorer`, `openings`, `opponents`, `worldmap`, `activity`, `rating`, `settings`
  - `/profiles/new`, `/players`, `/bookmarks`
  - `/databases`, `/databases/:id`
  - `/prep`, `/prep/:id`
  - `/broadcasts`, `/broadcasts/:roundId`
  - `/explorer` (global explorer, which goes to the Studio with the explorer open)
  - `/settings`, `/admin/*`
  - `/studio` is a separate page.
- **Filters bar.** Shared by the Games, Explorer, Openings and Opponents tabs. State lives in the URL query. The opponent and event fields suggest names (the most played opponents; `GET …/events?q=`, decision 35).
- **Footer.** AGPL notice, NOTICE.md, and the instance's source code when `SOURCE_URL` is set (decision 30).
- **Game previews.** `@lichess-org/pgn-viewer` (mounted imperatively into a child div). "Analyse" opens the Studio.
- **Mobile.** Responsive down to 360 px, plus a PWA manifest.

## 10. Security
- Passwords: `crypto.scrypt` (N=2^15, r=8, p=1, 64-byte key), compared in constant time.
- Sessions: random 32-byte ids, stored as SHA-256 hashes, 30-day sliding expiry.
- Optional TOTP (RFC 6238). Turning it on needs the current password (decision 8).
- Login and signup throttled per IP and per username; IPs come from `TRUSTED_PROXIES`.
- **Setup.** The first admin is created with `SETUP_TOKEN` (printed to the log once if it was generated).
- **Signup** modes: `closed`, `invite` or `open`.
- **Headers:**
  - CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`
    (`font-src` allows `data:` for pgn-viewer's embedded icon font, `lpv-fontello`)
  - COOP/COEP as in §8
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`
- **Access.** Public profiles and their stats can be read anonymously only when `anonymousBrowsing` is on. Everything else needs a session, and owners or admins for mutations.
- **Secrets.** The Lichess token never reaches the browser. All upstream calls go through the server.
- **Uploads.** Size limits: PGN 50 MB (pasted PGN 5 MB), reference import 2 GB streamed to disk.
- **Per-user limits** (decision 7): 2,000,000 games across a user's PGN databases (admins: none), 3 pending imports, 10 database exports per minute; Studio files 100 MB of PGN (recycle bin included), 10,000 files, 2,000,000 indexed positions; prep lines from each opponent's latest 5,000 games.

## 11. Testing and verification
- **Unit tests (Vitest):**
  - position keys and transpositions
  - opening classifier
  - Chess.com and Lichess game mapping, from fixtures in `server/test/fixtures`. These are small **synthetic or hikaru-only** samples: no private individuals' data.
  - stats queries on a seeded DB
  - explorer response shape
  - auth flows via `app.inject`
  - PGN import and the duplicate check
  - zstd broadcast import on a tiny fixture
- **Integration:** live smoke test against real APIs (small accounts, limited months). Playwright screenshots of every page at desktop and phone width.
- **Docker:** `docker compose build && up`, then health check `GET /api/health`.

## 12. Delivery order
1. Scaffold: workspaces, configs, DB plus `001_init.sql`, app skeleton, shared contract types, vendoring script and assets, theme CSS, route and page stubs.
2. Parallel modules, each in its own worktree branch:
   - auth+admin
   - sync+jobs
   - stats
   - explorer+proxies
   - profiles/search/databases/files/prep (server)
   - reference+broadcasts
   - Studio (lila)
   - web profile pages
   - web other pages
3. Merge and integrate, run all tests, live smoke test, screenshots.
4. Review workflow (security, correctness, contract conformance, feature completeness, UI), then fixes.
5. Docker build, README and NOTICE, commit, push to the private repo `H0ggu/outpost`.
