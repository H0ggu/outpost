# Outpost

Self-hosted chess statistics and opponent preparation. Link any number of Lichess and Chess.com
accounts (or a FIDE player from a reference database, or a player inside your own PGN files) into one
profile and get Overview, Games, Explorer, Openings, Opponents, World map, Activity and Rating views,
filters on everything, a prep report for upcoming opponents, live broadcasts, and a Studio built on
Lichess's own analysis board.

It uses only public data — the official Lichess and Chess.com APIs and openly licensed datasets —
and reuses Lichess's open-source code and assets (chessground, chessops, pgn-viewer, stockfish-web and
the lila analysis board). See `NOTICE.md`. Not affiliated with Lichess or Chess.com.

## Quick start (Docker)

```sh
cp .env.example .env          # set PUBLIC_ORIGIN, LICHESS_TOKEN and CHESSCOM_CONTACT
mkdir -p data                 # on Linux: sudo chown 1000:1000 data (the container runs as uid 1000)
docker compose up -d --build
docker compose logs outpost   # copy the setup token, then open PUBLIC_ORIGIN/setup
```

One container, one port (8080 by default), one data folder (`./data`: SQLite database, Stockfish NNUE
cache, uploads). Health check: `GET /api/health`.

Outpost doesn't care how it is reached. Open the port directly on your network, or put any reverse proxy
or tunnel in front of it (Caddy, nginx, Traefik, a VPN…) — then set `PUBLIC_ORIGIN` to the address users
type and `TRUSTED_PROXIES` to the proxy's address so rate limits see real client IPs.

## Development

Requires Node ≥ 26.11 (the server runs its TypeScript directly through Node's type stripping).

```sh
npm install
cp .env.example .env          # optional in dev
npm run dev                   # server on :8080 (node --watch) + Vite on :5173 (proxies /api)
```

Open http://localhost:5173. In development the server on :8080 only answers the API (it never serves
`web/dist`), and it accepts state-changing requests from `localhost` only; to try the dev server from
another device, set `PUBLIC_ORIGIN` to the address you open there (e.g. `http://192.168.1.10:5173`).
Other scripts:

| Command | Does |
|---|---|
| `npm test` | Vitest for shared, server and web |
| `npm run typecheck` | TypeScript 7 (`tsc`) for every workspace; the Studio (`web/src/studio`) has its own program, which types vendored lila through declarations and never checks its sources |
| `npm run build` | Builds the web app into `web/dist` (served by `npm start` and Docker). No source maps; `npm run build -w @outpost/web -- --sourcemap` adds them |
| `npm start` | Runs the server in production mode (`NODE_ENV=production`, so `PUBLIC_ORIGIN` is required) |
| `npm run vendor` | Re-vendors Lichess code and assets at the pinned commits (`scripts/vendor-lichess.sh`) |

Layout: `shared/` (API contract types, filters, chess helpers), `server/` (Fastify + `node:sqlite`),
`web/` (React SPA + the Studio page). The plan and research notes are in `docs/`.

## Configuration

Set in `.env` (or the environment). Relative paths resolve against the repository root.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind (Docker always binds `0.0.0.0` inside the container) |
| `PUBLIC_ORIGIN` | — (required in production) | Public address, e.g. `https://chess.example.com`; used for the CSRF/Origin check, Secure cookies and links |
| `TRUSTED_PROXIES` | empty | IPs/CIDRs or `loopback` / `linklocal` / `uniquelocal` of proxies whose `X-Forwarded-For` is trusted (`true`/`*` is refused) |
| `DATA_DIR` | `./data` | SQLite file, NNUE cache, uploads |
| `LICHESS_TOKEN` | empty | Lichess personal token (any scope; `study:read` recommended). Needed for the Lichess opening explorer, live broadcasts and broadcast round imports (including auto-import); speeds up game export. Can also be set by the admin in the UI (env wins) |
| `CHESSCOM_CONTACT` | empty | Contact for the User-Agent sent to Chess.com (it rejects anonymous clients). Can also be set in the UI (env wins) |
| `SOURCE_URL` | empty | Where this instance's source code is published (AGPL-3.0 §13); the footer links to it. Set it when you run a modified Outpost for others |
| `SETUP_TOKEN` | generated, logged | One-time token for creating the first admin at `/setup` |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent` |
| `OUTPOST_WORKERS` | `true` (`false` in tests) | Run the background job workers and the auto-refresh scheduler |

## Limits

Per user (admins have no game allowance): 2,000,000 games across their PGN databases, 3 imports
pending at a time, PGN uploads up to 50 MB (pasted PGN 5 MB), 10 database exports per minute; Studio
files up to 100 MB of PGN (recycle bin included). Profile PGN exports hold at most 10,000 games.
Chess.com opponent lookups (country and title for the world map) stop at 1,000 requests per run and
continue in the next hourly run. Decisions behind these and other defaults: `docs/DECISIONS.md`.

## Licence

AGPL-3.0-or-later. See `LICENSE` and `NOTICE.md` for third-party licences and attribution.
