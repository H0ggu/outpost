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

Open http://localhost:5173. Other scripts:

| Command | Does |
|---|---|
| `npm test` | Vitest for shared, server and web |
| `npm run typecheck` | TypeScript 7 (`tsc`) for every workspace; `web/vendor` is excluded |
| `npm run build` | Builds the web app into `web/dist` (served by the server when present) |
| `npm start` | Runs the server (`node server/src/main.ts`) |
| `npm run vendor` | Re-vendors Lichess code and assets at the pinned commits (`scripts/vendor-lichess.sh`) |

Layout: `shared/` (API contract types, filters, chess helpers), `server/` (Fastify + `node:sqlite`),
`web/` (React SPA + the Studio page). The plan and research notes are in `docs/`.

## Configuration

Set in `.env` (or the environment). Relative paths resolve against the repository root.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind |
| `PUBLIC_ORIGIN` | — (required in production) | Public address, e.g. `https://chess.example.com`; used for the CSRF/Origin check, Secure cookies and links |
| `TRUSTED_PROXIES` | empty | IPs/CIDRs or `loopback` of proxies whose `X-Forwarded-For` is trusted |
| `DATA_DIR` | `./data` | SQLite file, NNUE cache, uploads |
| `LICHESS_TOKEN` | empty | Lichess personal token (any scope; `study:read` recommended). Needed for the Lichess and player explorers and broadcasts; faster game export; rating history. Can also be set by the admin in the UI (env wins) |
| `CHESSCOM_CONTACT` | empty | Contact for the User-Agent sent to Chess.com (it rejects anonymous clients). Can also be set in the UI (env wins) |
| `SETUP_TOKEN` | generated, logged | One-time token for creating the first admin at `/setup` |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent` |

## Licence

AGPL-3.0-or-later. See `LICENSE` and `NOTICE.md` for third-party licences and attribution.
