# Chess.com PubAPI: implementation notes (checked 2026-11-23)

**How this was checked.** "LIVE" means I tested it against `api.chess.com` today. The test accounts were `hikaru` and six random Icelandic accounts; I used a generic User-Agent and sent requests one at a time. "DOC" means the official page https://www.chess.com/news/view/published-data-api, which says "Updated: Apr 22, 2026" but "Last reviewed 2022-05-10". The revision gist was last changed in May 2022, so **the docs are behind what the API actually returns**. Code against what the API returns, not the docs.

## 0. General
- **Base URL:** `https://api.chess.com/pub/`. Read-only, public data only, no authentication. Responses are JSON-LD; plain JSON parsing is fine. Timestamps are Unix seconds and text is always English.
- **Status codes:** 200, 301 (non-canonical URL), 304, 404 (bad URL or no such user, e.g. `{"code":0,"message":"User \"x\" not found."}`), 410 (gone), 429 (rate limited), 403 (no or blocked User-Agent, see §4).
- **Odd but valid:** a month in the future or before the account existed returns 200 `{"games":[]}`. A single-digit month (`/2026/1`) returns **404**, so always zero-pad `MM`.
- **CORS:** `access-control-allow-origin: *` is set (LIVE). Browsers cannot set `User-Agent`, though, so send requests through your server.
- **Compression and HTTP/2:** `Accept-Encoding: gzip` works and HTTP/2 is supported. A monthly archive of 583 games is about 2.4 MB uncompressed (roughly 4 KB per game).
- **JSONP:** a `?callback=fn` parameter exists. You don't need it.
- **Terms (support article 9650547):**
  - Commercial use is allowed if you don't "abuse/spam our users, disrupt/harm our service, or copy our features or IP".
  - You must state that you are **not affiliated with Chess.com**.
  - Browser extensions "may not do scraping or access undocumented endpoints".

## 1. Endpoints
| Endpoint | Notes |
|---|---|
| `/player/{u}` | Profile (§3) |
| `/player/{u}/stats` | Ratings and records (§3) |
| `/player/{u}/games/archives` | `{"archives":[url,...]}` with monthly URLs in ascending order. Empty array if the player has no games. |
| `/player/{u}/games/{YYYY}/{MM}` | `{"games":[...]}` in **ascending `end_time`** order (§2) |
| `/player/{u}/games/{YYYY}/{MM}/pgn` | Concatenated PGN. LIVE `Content-Type: application/vnd.chess-pgn; charset=utf-8` (the docs say `application/x-chess-pgn`). `Content-Disposition: attachment; filename="ChessCom_{u}_{YYYYMM}.pgn"` |
| `/player/{u}/games/live/{baseSec}/{incSec}` | Added Nov 10, 2024 (forum post by Martin_Stahl, a Chess.com forum moderator). Returns **every** live game the player has at that time control, across all years, in one response: 18.6 MB for hikaru at 180/0. Game objects here have **no `tcn`, `uuid` or `initial_setup`**. |
| `/player/{u}/games` | Current daily (correspondence) games: `url, fen, pgn, turn, move_by, draw_offer?, last_activity, start_time, time_control, time_class, rules, tournament?, match?`. Here `white`/`black` are **profile URLs**, not objects. |
| `/player/{u}/games/to-move` | `url, move_by, draw_offer?, last_activity` |
| `/player/{u}/clubs` | `{"clubs":[{@id,name,last_activity,icon,url,joined}]}`. LIVE: **`@id` is the web URL** (`https://www.chess.com/club/{slug}`), not the API URL. Take the slug from it and call `/club/{slug}`. |
| `/player/{u}/tournaments` | `finished[]`: `url` (web), `@id` (API), `wins, losses, draws, placement, status, total_players`, plus undocumented `time_class` and `type` (e.g. `swiss`) (LIVE). `points_awarded` is documented but was not seen. `status` values include `withdrew` and `registered`. `in_progress[]` and `registered[]` hold `{url,@id,status}`. |
| `/player/{u}/matches` | Daily team matches only: `finished[]{name,url,@id,club,results{played_as_white,played_as_black},board}`, `in_progress[]`, `registered[]` |
| `/player/{u}/is-online` | **REMOVED**. LIVE: 404 `Data provider not found`. A wrapper's changelog says it was removed on 2021-08-25, but the docs still list it. Use the profile's `last_online` instead. |
| `/country/{ISO}` | `{@id,code,name}`. The code must be **uppercase** (`/country/is` returns 404). Non-ISO codes: XA, XB, XC, XE, XG, XK, XP, XS, XW, XX. |
| `/country/{ISO}/players` | LIVE: `{"players":[...10000 usernames], "comment":"Results are temporarily reduced to the first 10000 players for performance reasons"}`. These are alphabetical and limited to recently active players. `max-age=3600`. |
| `/country/{ISO}/clubs` | List of club URLs |
| `/titled/{TITLE}` | Titles: GM, WGM, IM, WIM, FM, WFM, NM, WNM, CM, WCM. Must be **uppercase** (`/titled/gm` returns 404). Returns `{"players":[usernames]}`. GM had 1753 names (LIVE). |
| Other | `/club/{slug}`, `/club/{slug}/members` (`weekly`/`monthly`/`all_time` lists of `{username,joined}`), `/club/{slug}/matches` (finished list capped at the latest 1000), `/tournament/{id}[/{round}[/{group}]]`, `/match/{id}[/{board}]`, `/match/live/{id}[/{board}]`, `/puzzle`, `/puzzle/random`, `/streamers`, `/leaderboards` (top 50 per category: `daily, daily960, live_rapid, live_blitz, live_bullet, live_bughouse, live_blitz960, live_threecheck, live_crazyhouse, live_kingofthehill, tactics, lessons`) |

**Usernames are case-insensitive, and the canonical path is lowercase.**
- LIVE: `/player/Hikaru` and every sub-path (`/stats`, `/games/...`, `/pgn`) return **301** to the lowercase URL. The body is `{"code":0,"message":"Invalid values. Try {...}"}` with a `location` field.
- **Lowercase usernames before requesting** to avoid the extra round trip.
- The profile's `username` field is lowercase. `url` (`/member/Hikaru`) keeps the display case. In game objects, `white.username` keeps the display case and `@id` is lowercase.
- Use `player_id` (profile) or the player `uuid` (game objects) as the stable key. The docs say `player_id` never changes, but its "future availability is not guaranteed".
- Usernames can change. Whether old games then show the old or the new name is UNVERIFIED, so key on `uuid`.

## 2. Game objects in the monthly archive (LIVE)
**Keys seen:** `url, pgn, time_control, end_time, rated, accuracies?, tcn, uuid, initial_setup, fen, start_time? (daily only), time_class, rules, white, black, eco?, tournament?, match?`
- `white` / `black` contain `{rating, result, @id, username, uuid}`.
- **`rating` is the post-game rating.** I checked this: the last game's `rating` equals `stats.last.rating`, and a loss shows 3463 then 3449. The docs say the same. The PGN `WhiteElo`/`BlackElo` values are equal to this JSON rating, so they are **also post-game**. Lichess PGN ratings are pre-game, so convert one side before comparing.
- `accuracies {white, black}` (floats) appear **only on games that were reviewed**. In ordinary accounts that was about 10–40% of games (e.g. 78/208, 20/248, 7/23).
- `eco` is a **URL** such as `https://www.chess.com/openings/Sicilian-Defense-Canal-Attack...`, not a code. The ECO code is in the PGN `[ECO]` tag. The opening name has no tag, so derive it from the `ECOUrl` slug or classify the moves yourself (e.g. lichess chess-openings TSV). `eco` is sometimes missing (14/366 games).
- `time_control` is in PGN form: `"180"`, `"180+2"`, or `"1/259200"` for daily (1 move per N seconds).
- `time_class` is one of `daily | rapid | blitz | bullet`. **Do not compute it from `time_control`**: older games at 600-second time controls are labelled `blitz` (LIVE). Use the field.
- `rules`: the docs list `chess, chess960, bughouse, kingofthehill, threecheck, crazyhouse`. LIVE also returned the undocumented **`oddschess`**. For opening statistics, filter to `rules=="chess"`.
- `initial_setup` is a FEN. For chess960 it uses `KQkq` castling, while the PGN `[FEN]` tag uses Shredder notation (`GBgb`).
- `fen` is the final position. Some old games omit the move counters (`"... b - -"`).
- `tcn` is Chess.com's compact move encoding, 2 characters per move, undocumented. Decoders exist: `@savi2w/chess-tcn` (npm), `chess-tcn` (PyPI). It is easier to parse the `pgn`.
- `uuid` is the game UUID. `tournament` and `match` are API URLs.
- **There is no `start_time` for live games.** Get the start from the PGN `UTCDate` + `UTCTime` tags. `EndDate` + `EndTime` give the end.

**PGN tags in order (LIVE):** `Event` ("Live Chess", "Let's Play!", "Live Chess - Chess960", "Live Chess - Odds Chess"), `Site`, `Date`, `Round "-"`, `White`, `Black`, `Result`, `Tournament`? (web URL), `Variant`? ("Chess960"), `SetUp`?, `FEN`?, `CurrentPosition`, `Timezone "UTC"`, `ECO`, `ECOUrl`, `UTCDate`, `UTCTime`, `WhiteElo`, `BlackElo`, `TimeControl`, `Termination`, `StartTime`, `EndDate`, `EndTime`, `Link`.
- There is **no `Opening` tag** and no `WhiteRatingDiff`.
- Live games carry `{[%clk h:mm:ss(.d)]}` after each move, which supports time-usage statistics. Daily games have no clock comments.
- `Termination` strings are "`{user} won by resignation|on time|by checkmate|game abandoned`" or "`Game drawn by repetition|agreement|stalemate|insufficient material|timeout vs insufficient material|50-move rule`".

**Result codes (DOC list; all except `lose`, `kingofthehill`, `threecheck` and `bughousepartnerlose` were seen LIVE):**
- **Win:** `win`
- **Draw:** `agreed, repetition, stalemate, insufficient, 50move, timevsinsufficient`
- **Loss:** `checkmated, timeout, resigned, lose, abandoned, kingofthehill, threecheck, bughousepartnerlose`

Classify from the player's own side: `win` is W, anything in the draw set is D, everything else is L. Cross-check against the PGN `Result` tag. Treat unknown codes as L and log them.

## 3. Profile and stats (LIVE)
**Profile keys:** `avatar?, player_id, @id, url, name?, username, title?, followers, country (URL …/pub/country/US; ISO code = last path segment), location?, last_online, joined, status, is_streamer, twitch_url?, verified (bool), league, streaming_platforms ([{type, channel_url}])`
- `verified`, `league` and `streaming_platforms` are **undocumented but present**. `league` values seen: `Wood`, `Crystal`, `Legend`.
- **`fide` is not in the profile**, despite the docs. It is in stats (below).
- `status` (DOC) is one of `closed, closed:fair_play_violations, basic, premium, mod, staff`. A Diamond member showed `premium`, so `status` doesn't distinguish membership tiers.
- How closed accounts respond (404 vs 410 vs a profile with `status: closed`) is UNVERIFIED.

**Stats keys:** `chess_daily, chess960_daily, chess_rapid, chess_blitz, chess_bullet` (a key is missing if never played; there is **no live-960 stats key**), `fide` (int, **0 when unset**), `tactics`, `puzzle_rush`, `lessons`?
- Each game-type object has:
  - `last {rating, date, rd}`: current Glicko rating and RD. `date` is the end time of the last game.
  - `best {rating, date, game}`: `game` is a game URL.
  - `record {win, loss, draw}`; daily types add `time_per_move, timeout_percent`.
  - Daily types may also have `tournament {count, withdraw, points, highest_finish}` (DOC).
- `tactics {highest, lowest}`, each `{rating, date}`.
- `puzzle_rush {best {total_attempts, score}, daily?}`. **Gotcha:** an empty `puzzle_rush` comes back as `[]` (an array), not `{}`.

## 4. Rate limits, caching, User-Agent
**User-Agent is enforced:**
- Since 2023-06-20 (official announcement), requests need a recognizable UA with contact details (email and/or Chess.com username), or they get **403**.
- LIVE: an empty UA, curl's default UA and `python-requests/x` all got **403**. A custom string without contact details got 200. Include contact details anyway.
- Format from the support article: `User-Agent: my-tool/1.2 (username: X; contact: me@example.com)`. The self-hosted app should let the operator configure this.

**Rate limits:**
- "Serial access rate is unlimited." Parallel requests "may" get 429, depending on server load. "Abnormal or suspicious activity" can get the client blocked entirely.
- No numeric limit is published. A 2019 forum post mentions a concurrency limit of 3 (UNVERIFIED, old).
- Whether 429 responses carry `Retry-After` is UNVERIFIED.
- **Use one request queue for the whole process, one request in flight**, with exponential backoff on 429 and 5xx.

**Freshness:**
- The docs contradict themselves: "refresh at most once every 12 hours" in one place, "24 hours if not noted otherwise" in another.
- Observed: `cache-control: public, max-age=5` on player endpoints and `max-age=3600` on country players. Cloudflare `cf-cache-status` is HIT, MISS, EXPIRED or REVALIDATED.
- In practice the current month includes games within hours. Hikaru's last game appeared and matched `stats.last`.
- On 2025-04-04 there was a backend regression where tournament games went missing; staff said it was fixed on 04-09.
- A thread opened 2025-12-18 reported `{"code":0,"message":"An internal error has occurred..."}` on archives and monthly endpoints. A moderator said it worked again on 12-19.
- **Treat 5xx and "internal error" bodies as retryable.**

**Conditional requests:**
- ETags are weak (`W/"..."`). LIVE: `If-None-Match` returns **304**.
- **`If-Modified-Since` did NOT return 304** in any of my tests, whether I sent the server's own value or an RFC 1123 date.
- `Last-Modified` uses a non-standard format (`Monday, 23-Nov-2026 00:12:28 GMT+0000`) and reflects when the cache was regenerated. A 2014 archive showed today's date. **Use ETag only.**

**Import strategy:**
1. Fetch `/games/archives`.
2. Fetch each month serially. Store past months with their ETag and revalidate them rarely. Re-poll the current month and the previous month (late daily games) with `If-None-Match`.
3. For a one-time bulk import of a single time control, `/games/live/{base}/{inc}` is one request, but the response is very large.

**Deprecations and outlook:**
- `is-online` has been removed.
- The docs say about 3% of players still use the legacy "v2" site, so some of their data may be stale.
- A forum commenter described the API as being in "maintenance mode", meaning no new features. This is not an official statement (UNVERIFIED).
- No official announcements about the API from 2024–2026 were found apart from the Nov 2024 `games/live/{base}/{inc}` endpoint.

## 5. Player search
- **There is no official search or autocomplete endpoint.**
- Undocumented options:
  - `https://www.chess.com/members/search?phrase=...` is an HTML page, not an API.
  - Endpoints under `https://www.chess.com/callback/...` (e.g. `/callback/user/popup/{u}`, which LIVE returned 200 JSON with `bestRating`, `membership`, `countryId`, and more).
  - Risks: they can change without notice, the User Agreement forbids automated retrieval outside the API, extensions are explicitly barred from them, and Cloudflare may block them.
- **Recommendation:**
  1. Check an exact username with a debounced `GET /player/{lowercase}`, where 404 means the user doesn't exist.
  2. Build a local autocomplete index from usernames already seen in imported games (opponents and recently searched names).
  3. Optionally seed that index from `/titled/{T}` for all 10 titles and from `/leaderboards`.
  4. Do not use the callback endpoints by default. If you include one, put it behind an explicit opt-in setting.

## 6. Rating history
**There is no official endpoint.** `stats` has only `last`, `best` and `record`.

**Rebuilding it from games:**
1. Walk all archives.
2. Filter `rated == true`. Group by `(rules, time_class)`: `chess960` games are rated as daily-960; live 960 and other variants have separate ratings.
3. For the player's side (match `uuid`, or lowercased `username`), emit `(end_time, rating)`. This value is post-game, so it gives the rating curve directly.
4. Per-game change = this rating minus the previous rating in the same group. The first game's change is unknown, because the starting rating is chosen at signup.

**Caveats:**
- Unrated games still carry a `rating`; ignore them.
- Fair-play rating refunds and other adjustments create jumps that appear between games. This is UNVERIFIED but likely.
- Days with no games carry the last value forward.
- Cross-check the final point against `stats.{type}.last.rating`.

**Undocumented shortcut:** `https://www.chess.com/callback/live/stats/{u}/chart?daysAgo=30&type=blitz` returns `[{timestamp(ms), rating}]` with daily points. It worked LIVE today but carries the same terms and stability risk as §5. Use it only as an opt-in.

## Sources
- https://www.chess.com/news/view/published-data-api
- https://gist.github.com/andreij/0e3309200c0a6bb26308817a168203f3/revisions
- https://support.chess.com/en/articles/9650547-what-is-the-pubapi-and-how-do-i-use-it
- https://www.chess.com/announcements/view/breaking-change-user-agent-contact-info-required
- https://www.chess.com/club/chess-com-developer-community/announcements
- https://www.chess.com/clubs/forum/view/backend-updates-with-potential-api-impacts
- https://www.chess.com/clubs/forum/view/pub-player-games-api-endpoint-not-updating-in-realtime
- https://www.chess.com/clubs/forum/view/api-bug-games-archives-endpoint-returns-internal-error-for-valid-user
- https://www.chess.com/clubs/forum/view/rate-limiting-2023
- https://www.chess.com/clubs/forum/view/api-rfc-deprecate-and-remove-is-online-endpoint
- https://www.chess.com/clubs/forum/view/guide-unofficial-api-documentation
- https://github.com/savi2w/chess-tcn

Raw LIVE samples are saved in `/private/tmp/claude-501/-Users-hoggu-Documents-Github/1fce186a-5489-4f2e-95b2-846214e2658f/scratchpad/cc/`: `m.json` and `n.json` are monthly archives, `d.json` is a 2014 archive with daily and 960 games, `l.json` is a live/600/0 sample, plus `stats.json`, `prof.json` and `chart.json`.