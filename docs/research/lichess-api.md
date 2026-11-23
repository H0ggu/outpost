# Lichess HTTP API: implementation notes (checked 2026-11-23)

Sources: the OpenAPI spec at github.com/lichess-org/api (`doc/specs`, v2.0.180), lila source (`app/controllers/Game.scala`, `Api.scala`, `Auth.scala`, `conf/routes`, `IpTrust.scala`), lila PR #21283, the blog post "The opening explorer now requires authentication" (read via the thibault blog atom feed, because the HTML page is behind Cloudflare), database.lichess.org, and my own anonymous curl tests today.

## 0. General rules
- Base URL: `https://lichess.org`. The explorer is on a different host: **`https://explorer.lichess.org`**. The spec says "not lichess.org". The old host `explorer.lichess.ovh` still answers with the same backend, but the docs now use `.org`.
- **User-Agent is required**: "All requests going to lichess.org MUST include a `User-Agent` header with your website URL, or the name of your application, or a contact email." Requests without one "may be rejected or rate limited."
- Rate limits: make **one request at a time**. On a 429, "In most cases, waiting one minute before retrying will be sufficient, but some limits may require longer. Reduce your request frequency before retrying."
- Auth header: `Authorization: Bearer <token>`.
  - Create a personal token at `https://lichess.org/account/oauth/token`. A pre-filled form works too: `https://lichess.org/account/oauth/token/create?scopes[]=study:read&description=my-app`.
  - Tokens match `^[A-Za-z0-9_]+$`. Handle lengths of at least 512 characters, and don't rely on the `lip_` prefix.
  - PKCE flow: only `S256`, tokens last about 1 year, no refresh tokens.
  - `POST /api/token/test` takes up to 1000 tokens (text/plain, comma-separated) and returns `{token: {userId, scopes, expires}|null}`.
- Recommended token for this app: **one personal token with the `study:read` scope**. That covers the game export bonus, the explorer and broadcasts. No other scope is needed for public data.
- Most endpoints send `Access-Control-Allow-Origin: *`. Still, keep the token on the server; the docs say never put it in a frontend bundle.
- IP throttling (lila `IpTrust.throttle`): streaming throughput is divided for IPs classified as proxies: vpn ÷3, residential ÷3, tor ÷4, public ÷5, `http1` ÷2. Datacenter/server IPs get ÷1. Use an HTTP/2 client. What the `http1` class actually matches is UNVERIFIED.

## 1. Game export: `GET /api/games/user/{username}`
- **Format** is chosen by the `Accept` header: `application/x-ndjson` (one JSON game per line) or `application/x-chess-pgn` (the default). The response is chunked and sent as an attachment; read it as a stream. Results are sorted newest first by default.
- **Query parameters** (defaults in brackets):
  - `since`, `until`: epoch ms, minimum 1356998400070.
  - `max`: an integer of at least 1; leave it out to get all games.
  - `vs`: opponent username.
  - `rated`: bool.
  - `perfType`: comma-separated list from `ultraBullet,bullet,blitz,rapid,classical,correspondence,chess960,crazyhouse,antichess,atomic,horde,kingOfTheHill,racingKings,threeCheck`.
  - `color`: `white` or `black`.
  - `analysed`: bool.
  - `moves` [true], `tags` [true].
  - `pgnInJson` [false]: NDJSON only; adds a `pgn` field.
  - `clocks` [false], `evals` [false].
  - `accuracy` [false]: JSON only.
  - `opening` [false].
  - `division` [false]: JSON only.
  - `ongoing` [false]: ongoing games are delayed 3–60 s.
  - `finished` [true]: set it to false to get only ongoing games.
  - `literate` [false].
  - `lastFen` [false]: NDJSON only.
  - `withBookmarked` [false].
  - `sort`: `dateAsc` or `dateDesc` [dateDesc].
- **Throughput** (lila source; the docs give the first figure as 20):

| Requester | Games per second |
|---|---|
| Anonymous | 25 |
| OAuth token | 30 (session cookies don't count) |
| Exporting your own games | 60 |

  These rates are then divided by the IP factor above.
- **Concurrency**: 2 downloads per IP (20 when you export your own games) and 2 per user. Closed accounts are not exported.
- **NDJSON object** (spec `GameJson`, confirmed live):
  - Top level: `id, rated, variant, speed, perf, createdAt, lastMoveAt` (ms), `status, source` (e.g. `pool`, `simul`), `players{white,black}, winner?, opening?, moves, pgn?, initialFen?, daysPerTurn?, clock?, clocks?, analysis?, division?, arenaTour?{id,name}, swissTour?{id}`.
  - With `lastFen=true` you also get `lastFen` and `lastMove`. The `lastMove` field (UCI) is not in the spec.
  - `variant` values: `standard, chess960, crazyhouse, antichess, atomic, horde, kingOfTheHill, racingKings, threeCheck, fromPosition`. `initialFen` is present for fromPosition and chess960 games.
  - `speed` values: `ultraBullet` … `correspondence`.
  - `status` values: `created, started, aborted, mate, resign, stalemate, timeout, draw, outoftime, cheat, noStart, unknownFinish, insufficientMaterialClaim, variantEnd`. `winner` is `white`/`black` and is absent for draws.
  - Each player object: `user{id,name,title?,flair?,patron?,patronColor?}, rating, ratingDiff?, provisional?, name?, team?, berserk?`. With evals or accuracy: `analysis{inaccuracy,mistake,blunder,acpl,accuracy?,phases?{opening,middlegame,endgame}}`. An AI side has `{aiLevel, analysis?}` and no `user` or `rating`. The shape for anonymous players is UNVERIFIED (expect no `user`).
  - `title` values: `GM, WGM, IM, WIM, FM, WFM, NM, CM, WCM, WNM, LM, BOT`.
  - `opening{eco,name,ply}` appears with `opening=true`.
  - `moves` is space-separated SAN.
  - `clock{initial,increment,totalTime}` is in seconds; `totalTime` = initial + 40×increment. Correspondence games have `daysPerTurn` instead.
  - `clocks[]` is in **centiseconds**.
  - `analysis[]` entries per ply: `{eval (cp) | mate, best? (UCI), variation? (SAN), judgment?{name: Inaccuracy|Mistake|Blunder, comment}}`.
  - `division{middle?,end?}` gives plies and can be `{}`.
- **Gotchas**:
  - In both games I sampled, `clocks.length == plies+1`; the last entry is the final clock of the side to move.
  - `lastFen` move counters looked wrong in the sample (`... b kq - 1 1`). Don't trust its halfmove/fullmove counters.
  - PGN tags: `Event, Site (https://lichess.org/game/{id}), Date, Round, White, Black, Result, GameId, UTCDate, UTCTime, WhiteElo, BlackElo, WhiteRatingDiff, BlackRatingDiff, [WhiteTitle], Variant, TimeControl ("180+0"), ECO, Opening, Termination`.
- **Re-fetching by ID**: `POST /api/games/export/_ids`, body is comma-separated IDs. Limit 300 IDs at 30 games/s (600 at 100/s for verified accounts).
- Game URL pattern: `https://lichess.org/{id}`, plus `/white` or `/black`.

## 2. Users
- **`GET /api/user/{username}`**
  - Parameters: `trophies` [false], `profile` [true], `rank` [false] (adds `perfs.X.rank`), `fideId` [false].
  - Fields: `id, username, title?, flair?, patron?, patronColor?, verified?, createdAt, seenAt, disabled?` (only on closed accounts), `tosViolation?, playTime{total,tv,human?}, url, playing?, count{all,rated,ai?,draw,drawH?,loss,lossH?,win,winH?,bookmark,playing,import,me}, streaming?, streamer?, fideId?`, and with a token `followable/following/blocking`.
  - **Country is `profile.flag`** (e.g. `"GF"`). Other `profile` fields: `location, bio, realName, fideRating, uscfRating, ecfRating, cfcRating, rcfRating, dsbRating, links` (newline-separated).
  - `perfs.{bullet,blitz,...,puzzle}` = `{games, rating, rd, prog, prov?, rank?}`. `storm`, `racer` and `streak` are `{runs, score}`.
- **`POST /api/users`**
  - Body is text/plain with comma-separated IDs, **up to 300**, returned in the same order.
  - Parameters: `profile` [true], `rank`.
  - Each item is a `User` object: it includes `profile.flag`, but **no `count`, `url` or `streamer`** (checked live).
  - Limit: 10,000 users per 10 minutes and 150,000 per day with a token; fewer anonymously.
- **`GET /api/player/autocomplete`**
  - Parameters: `term` (spec minLength 4), `object` (false gives `["name",…]`; true gives `{"result":[{id,name,title?,flair?,patron?,online?}]}`), `names` (preferred casing), `exists`, `friend` (needs OAuth), `team`, `tour`, `swiss`, `teacher`.
  - A 3-character term returned only an exact match in my test.
- **`GET /api/user/{username}/rating-history`**
  - Returns `[{name, points:[[year, month0, day, rating],…]}]`. **Months start at 0.** At most one point per day.
  - **`name` is now the perf key** (`bullet`, `kingOfTheHill`, `puzzle`, …), changed in Oct 2026. It used to be a display name like "Bullet" or "King of the Hill".
  - **Gotcha (Aug 2026)**: the history is only generated on demand for OAuth requests. Anonymous requests get a cached copy if one exists, otherwise `[]`. Send the token.
- **`GET /api/user/{username}/perf/{perfType}`** (`PerfStat`):
  - `user{name}, perf{glicko{rating,deviation,provisional},nb,progress}, rank|null, percentile`.
  - `stat{highest/lowest{int,at,gameId}, bestWins/worstLosses{results[{opRating,opId(LightUser),at,gameId}]}, count{all,rated,win,loss,draw,tour,berserk,opAvg,seconds,disconnects}, resultStreak{win,loss}{cur,max}{v,from,to}, playStreak{nb,time}{cur,max}, lastDate}`.
- Related: `GET /api/fide/player/{id}`, `/api/fide/player/{id}/ratings`, `/api/fide/player?q=` (FIDE list data: `id, name, title, federation, year, standard, rapid, blitz, photo`). No auth.

## 3. Opening explorer (`https://explorer.lichess.org`)
**Authentication (verified):**
- Since **2026-03-03**, anonymous explorer requests are refused because of a DDoS ("you now need to add an oauth token to each explorer request").
- **Update 2026-11-19**: "The masters opening explorer is now available to anon players" (lila commit c2e3233).
- My curl tests today:

| Endpoint | Anonymous result |
|---|---|
| `/masters` | 200 |
| `/masters/pgn/{id}` | 200 |
| `/lichess` | **401** (from nginx) |
| `/player` | **401** (from nginx) |

- Send `Authorization: Bearer <token>`. **Any scope works, including none.** nginx calls lila's `/auth/check`, which is `OpenOrScoped()` with no scope list.
- Limit (blog): "**20 requests per minute**", counted per user; max depth is 50 plies. `/auth/check` returns an `X-Tier` header (verified accounts = 2), which suggests higher limits for verified accounts. That is my inference and UNVERIFIED.

**Common parameters:**
- `fen`: X-FEN of the root position.
- `play`: comma-separated UCI moves from `fen`. Send it so the server can find the opening name.
- `since`, `until`: `YYYY-MM` or `YYYY`. Defaults are 1952-01 and 3000-12. Lila's own frontend sends only the year for masters.
- `moves`: number of moves returned [12].
- A bad move returns 400 text, e.g. `bad request: illegal move e2e5: illegal uci move`.

**`/masters`:**
- Extra parameter: `topGames` (≤15) [15].
- Response: `{opening|null{eco,name}, white, draws, black, moves[{uci,san,averageRating,white,draws,black,game|null,opening|null}], topGames[{uci,id,winner|null,white{name,rating,title?},black{…},year,month|null}]}`.
- Responses carry `Cache-Control: max-age=10800`.
- `GET /masters/pgn/{id}` returns PGN with tags `Event, Site, Date, Round, White, Black, Result, WhiteElo, BlackElo, LichessId`. 404 if the ID is unknown. Cached 30 days.

**`/lichess`** (rated Lichess games only):
- Extra parameters:
  - `variant` [standard].
  - `speeds`: comma-separated Speed values.
  - `ratings`: buckets `0,1000,1200,1400,1600,1800,2000,2200,2500`; each runs up to the next value.
  - `topGames` (≤4), `recentGames` (≤4).
  - `history` [false]: adds `history[{month,white,draws,black}]`.
- Response: same shape as masters, plus `recentGames`. Game objects add `speed` and `mode` (`rated` or `casual`), and `month` is a string. The server may return fewer games than requested (banned users are filtered out).

**`/player`:**
- Parameters: `player` (required), `color` (required; white or black), `variant, fen, play, speeds, modes` (rated,casual), `since, until, moves`, `recentGames` (≤8) [8].
- Response is an **NDJSON stream**: indexing starts on demand, and each line is a fuller snapshot. Use the last line; empty keep-alive lines may appear.
- Line shape: `{opening, queuePosition, white, draws, black, moves[{uci,san,averageOpponentRating,performance,white,draws,black,game|null,opening|null}], recentGames[…]}`.
- New games are indexed at most once per minute; previously ongoing games are revisited at most once per day. 503 means the indexing queue is full.
- Explorer game IDs link to `https://lichess.org/{id}`. `moves[].game` is non-null only when a single game reached that move (UNVERIFIED rule, consistent with the samples).

## 4. Broadcasts
**Auth policy (PR #21283, merged 2026-08-18):** "Please authenticate all broadcast API requests… Anonymous requests will soon be heavily rate limited, and might be blocked." Use a token with **`study:read`**.

| Endpoint type | With token | Anonymous |
|---|---|---|
| JSON (tournament, round) | 120 requests/min | 10/min ("soon to be zero") |
| PGN streams | 8 concurrent | 1 concurrent |
| PGN downloads | 3 concurrent, 30 games/s | 1 concurrent, 10 games/s |

Anonymous round PGN export still returned 200 today.

**Endpoints:**
- `GET /api/broadcast?nb=1..100&html&live`: NDJSON of official broadcasts. Active ones come first, sorted by tier; then finished ones by most recent sync. No auth needed.
  - Line shape: `{tour{id,name,slug,info{format,tc,fideTC,location,timeZone,players,website,standings},createdAt,url,tier,dates[],image,description}, rounds[{id,name,slug,startsAt,finished?,ongoing?,url}], defaultRoundId, group?}`.
- `GET /api/broadcast/top?page=1..20&html`: returns `{active[], upcoming[] (removed, always empty), past{currentPage,maxPerPage,currentPageResults[{tour,round}],previousPage,nextPage}}`. No auth needed.
- `GET /api/broadcast/search?q=&page=` (study:read): returns a paginator of `{tour, round}`.
- `GET /api/broadcast/calendar/{year}/{month}`: exists in lila routes and returns 200 JSON, but is **not in the OpenAPI spec**. It is handy for walking past events month by month.
- `GET /api/broadcast/{tourId}` (8 characters): returns tour + rounds + group.
- `GET /api/broadcast/{tourSlug}/{roundSlug}/{roundId}`: slugs can be `-`. Returns round info and game previews.
- `GET /broadcast/{tourId}/players`: no `/api` prefix, no auth. Returns `[{name,title,rating,fideId,fed,played,score,ratingsMap,ratingDiffs,performances,rank}]`.
- `GET /broadcast/{tourId}/players/{playerId}`: `playerId` is the fideId, or the name if there is none.
- PGN export: `GET /api/broadcast/round/{roundId}.pgn` and `GET /api/broadcast/{tourId}.pgn`, with `clocks` [true] and `comments` [true]. Use these only for finished events and never poll them.
- Live streams: `GET /api/stream/broadcast/round/{roundId}.pgn`, `/api/stream/broadcast/tour/{tourId}.pgn`, `/api/stream/broadcast/group/{groupId}.pgn`. They first send every game, then resend a game's **full PGN** each time it changes. Deduplicate by `GameURL`.

**PGN tags seen live:** `Event, Site (= game URL), Date, Round ("6.1" = round.board), White, Black, Result, WhiteElo, BlackElo, WhiteTitle, BlackTitle, WhiteFideId, BlackFideId, Variant, ECO, Opening, UTCDate, UTCTime, BroadcastName, BroadcastURL, GameURL`. The monthly DB files also carry `TimeControl, Board, StudyName, ChapterName`.

**Gotchas:**
- In the API export, `Event` came back as `"Round 6: White - Black"` (round + chapter name), so use `BroadcastName` for the tournament name.
- `Date` was inconsistent within one round, so prefer the round's `startsAt`.
- Amateur events may have no Elo or FIDE tags and may put the rating inside the name, e.g. `"2162 Arhan Javeri"`.
- Clock and eval comments look like `{ [%eval 0.1] [%clk 1:00:00] }`.

## 5. database.lichess.org
- **Broadcast files**: `https://database.lichess.org/broadcast/lichess_db_broadcast_YYYY-MM.pgn.zst`.
  - **First month 2020-01.** Latest is 2026-10, which appeared on 2026-11-11, so expect about 10 days of lag after month end.
  - 82 files, 767 MB, 1,299,343 games.
  - Index: `/broadcast/list.txt`; checksums: `/broadcast/sha256sums.txt`.
  - **Licence: CC BY-SA 4.0.** Attribution is required, and anything derived must also be shared under BY-SA.
  - The server supports HTTP range requests.
- **Standard games**: `https://database.lichess.org/standard/lichess_db_standard_rated_YYYY-MM.pgn.zst` (plus `.torrent`), from 2013-01. Each file holds one month (not cumulative); recent months are about 30 GB.
- **Variants**: `/{variant}/lichess_db_{variant}_rated_YYYY-MM.pgn.zst`.
- Licence for game, puzzle and eval exports: **CC0**.
- Opening names: github.com/lichess-org/chess-openings.

## 6. What this means for the app
- **Collecting a user's games**: stream `/api/games/user` as NDJSON with the token. Ask for `clocks, evals, accuracy, opening` as needed, use `since` for incremental syncs, and keep one stream at a time.
- **Explorer**: proxy it through the server with the token and cache aggressively. Masters works without a token; `/lichess` and `/player` need one. Stay under 20 requests per minute.
- **Broadcasts**: use the monthly `.pgn.zst` files for past events, and the authenticated round or tour stream for live ones.
