# ChessMonitor feature inventory (as of 2026-11-23)

**Method.** I read the site pages, all 27 FAQ articles and 17 of the 19 blog posts. The two I didn't open are the FIDE-history post and the startup-grant post. The `/u/*` profile pages sit behind a bunny.net JavaScript challenge, and Lichess blog pages sit behind a Cloudflare challenge, so I could not render either. I did not try to get past those challenges.

Instead, profile-tab, filter and Studio details come from the site's own public JavaScript files, read once each. Those details are marked "(bundle)". They are reliable as UI labels, but each feature's exact behaviour is inferred from them.

**Source keys**
- **H** = chessmonitor.com/
- **P** = /pricing (comparison table plus the tooltip text from its JavaScript)
- **F:x** = /article/x
- **B:x** = /blog/x
- **CL** = /changelog. Its last entry is 2025-10-19, so it is out of date.
- **AS** = apps.apple.com/app/chessmonitor/6755627535
- **SJ** = /studio/assets/index-BZh5QU3Y.js
- **CW** = thechesswiki.pages.dev/wiki/chessmonitor
- **NK** = nikhilchess.substack.com/p/chessmonitor-review

**Tiers.** Basic is free, Plus is paid, Pro is Professional.
- Web prices were not in the page HTML (they load from the Paddle payment widget). Third-party figures: Plus $7.90/mo or $5.90/mo billed yearly; Pro $59.90/mo or $44.90/mo billed yearly [CW, NK]. **UNVERIFIED.**
- App Store in-app purchases: $9.99/mo and $79.99/yr [AS].

## 1. Profiles and linked accounts
- **Link accounts** by Chess.com or Lichess OAuth login; you can add several accounts from the same site by logging into each in turn [F:what-is-oauth]. Limits: Basic 1+1, Plus 5+5, Pro 10+10. Existing over-limit users are grandfathered but can't add more [P, B:2025-april-update-search-filters-masters-plans].
- **Merged profile**: one page combines all linked accounts, user PGN databases and optionally a FIDE/Ultra identity. Example: Hikaru = 2 Chess.com accounts + Masters profile [B:2025-masters-database]. The "Add Profile" button sits under the accounts list [B:2024-create-update-and-bookmark-other-chess-players].
- **Sign-in options**: email/password, Google, Apple, Lichess, Chess.com (OAuth callback routes in the site's route list) [B:2024-june-update-new-features].
- **Re-login refreshes profile info**, including renamed Chess.com accounts [F:i-changed-my-chess-com-user-name...].
- **Remove Account** from /account [F:i-want-to-remove-an-added-account...].
- **What is imported**: standard chess only. Variants such as Chess960 and games against bots are excluded [F:the-number-of-games-is-different...].
- **Time-control class** follows each source site's own classification (5+5 is Blitz on Chess.com but Rapid on Lichess). UltraBullet is merged into Bullet [B:2024-july-server-upgrade-pgn-export].
- **Profile URL forms**: `/u/<slug>` (e.g. `/u/magnus-carlsen`), `/u/fide:<FIDEID>`, `/u/<random id>`. Tab routes: `/u/<p>/{games,explorer,openings,opponents[/most-played|/famous],worldmap,activity,rating}` (bundle).

## 2. Profile tabs
Tab titles and descriptions come from the _app bundle; Basic vs Plus comes from [P].
- **Overview** (all tiers). "Overall statistics and the last few games" [P]. Shows:
  - a per-time-control table: games, Elo estimate, W/D/L bar
  - the accounts list with Update buttons
  - Elo Rating Estimate, or Official FIDE Rating for FIDE players
  - Latest Game (mini board), Activity for the last 3 months, a Rating chart (Elo estimate, last year)
  - Games by Color, Termination × Result (Checkmate / Resign / Clock …)
  - top White and Black openings, Latest Games, a Subscriber badge (bundle)
- **Games** (all tiers).
  - Paged list, 20 per page, max 500 pages. Columns: Game, Time, Pieces (colour), Result, Opponent + rating, Moves, Opening, Source.
  - "Overall" W/D/L summary; an "Export / Import" box with Download and Add Games (bundle).
  - **PGN bulk export is Plus+.** One file, at most 10,000 games per download (above that, the UI asks you to filter). Player names are normalised to the account name [P, B:2024-july-server-upgrade-pgn-export, bundle].
- **Explorer** (all tiers). Personal opening tree. Details:
  - Board with flip, FEN and PGN paste fields; per-move row shows games (K/M format), W/D/L bar, then either engine eval or "last played" date, plus a link to games at that position.
  - Summary shows opening name + ECO, total games, W/D/L.
  - Transpositions supported since June 2026 [B:2026-transpositions-and-broadcast].
  - Engine-in-explorer, two phases [B:2025-engine-powered-opening-explorer]: phase 1 is a high-MultiPV scan of all moves to depth 15 or 3 s; phase 2 deepens the top N lines (default 3). Mini eval bars on a log scale from −5 to +5, with "·•·" dots on lines being calculated.
  - Eval can be toggled between inside the table and above it [B:2026-ultra-database].
  - Preferences: win rates from the player's perspective (green/red) or as White/Black; hovering a move plays it on the board instead of drawing an arrow [B:2025-june-update-explorer-engine-integration; /account/settings bundle].
  - Opening names come from lichess-org/chess-openings. Main-line opening detection uses move order, not position hashing, so counts can differ from the explorer [B:2024-july-server-upgrade-pgn-export, F:why-do-the-values...].
- **Openings** (all tiers). White and Black opening tables: name (board preview on hover), ECO, games, average moves, W/D/L.
  - Order: Most Played / Best / Worst. Colour: Both / White / Black.
  - Extra filters: Min. Moves 1–5, Max. Moves 1–5, Min. Games 1/5/10/20/50/100/200/500.
  - Clicking an opening opens the explorer with the same filters [bundle, CL 2025-04-25].
- **Opponents.** Basic view is all tiers; the advanced view is Plus+ ("see all famous (and normal) opponents") [P].
  - Most Played Opponents and Famous (titled) Opponents, each with a "More" link to a paged full list. Rows: name, profile, games, rating, W/D/L, View games.
  - Win / Loss / Draw Behavior tables: termination type, frequency, average moves [bundle, B:2024-june-update-new-features].
- **World Map** (all tiers). SVG choropleth of opponents' countries.
  - View options: Opponents / Games / Yes-No. Table: flag, country, games, opponents, W-D-L, plus a full country list.
  - Country data fills in over hours to days. User PGN databases are excluded [F:the-world-map-is-empty..., CL 2024-08-05].
- **Activity** (all tiers).
  - Calendar heatmap by day: square size = games, colour = score. Also activity by hour (24 bars), by weekday, and an hour × weekday grid.
  - Timezone setting: mine or UTC (bundle). Colours made "greener" around a 50% score [B:2024-june-update-new-features].
- **Rating** (all tiers).
  - Rating history chart, selectable by account and time control, or by "Elo Estimate".
  - Rating averages over the last 10/20/50/100/200/500/1k/2k/5k/10k/20k/50k games, plus all games.
  - Monthly Elo-estimate history; Official FIDE rating graph for FIDE players; historical FIDE estimation; a marker for the March 2024 FIDE adjustment below 2000 [B:2024-june-update-new-features, B:2024-updated-fide-ratings-elo-history, bundle].
- **Elo estimate** [B:2023-elo-calculation, CL 2025-04-23, CL 2025-05-26].
  - Model: one linear regression per site and time control, mapping online rating to FIDE standard; about ±118 at 95%.
  - Built from time controls in your last 100 games that have ≥20 games each.
  - Weights: bullet 1, blitz 3, rapid 9. Weights for classical and correspondence: UNVERIFIED.
  - Comparison value taken from ratings 20 games ago. Not available in the mobile app.

## 3. Filters
Filters live in the URL query and support multi-select since Aug 2024. They apply to the Games, Explorer and Openings tabs [B:2024-updated-fide-ratings-elo-history].
- **Basic (all tiers)**:
  - Color (white/black)
  - Date: 24h / 7d / 30d / 3m / 6m / 12m / custom from–to
  - Time Control (multi): bullet, blitz, rapid, classical, correspondence, unknown
  - Source/Account (multi; includes user PGN databases)
  - Rated + Unrated: rated / unrated [B:2024-july-server-upgrade-pgn-export]
  - Outcome (multi): win / draw / loss
- **Advanced (Plus+)** [P, B:2025-april-update-search-filters-masters-plans]:
  - Opponent Strength, relative to your rating: −200 / −100 / ±100 / +100 / +200
  - Opponent Name, with autocomplete
  - Event/Tournament, with autocomplete
- **Position filter**: games reached by a chosen line, coming from the explorer (bundle).
- **Termination filter**: [P] names an "Outcome & Termination" filter row, but the filter config in the code has no termination key. **UNVERIFIED.**

## 4. Updating
- **Click to Update** (all tiers; free users can update only their own page). The first download can take minutes up to a day; later updates are incremental and take seconds [F:what-happens-when-i-press-update].
- **Queue**: your position is shown on /account, at roughly 1 minute per user ahead of you. You don't need to stay on the site [F:what-is-the-queue, F:is-there-a-way-to-see-how-long...].
- **Cooldown** after an update ("Recently updated. It can only be updated every X"; X unknown) (bundle).
- **High-priority updates** and **Daily Auto Refresh** (opt-in, 09:00 UTC) are Plus+ [P, settings bundle].
- Pages are cached, so game counts can differ between pages while a download runs [F:my-games-are-being-downloaded...].

## 5. Search, other players, bookmarks, privacy
- **Unified search** (`/search?q=&source=fide.chesscom.lichess`) covers Ultra/FIDE, Chess.com and Lichess, searching the two sites' public APIs in parallel. Matches on name, FIDE ID or username, with suggestions as you type. Results show Elo-estimate range, FIDE rating, last active, game count, and whether the player is already in the database [B:2025-masters-database, B:2024-create-update..., bundle].
- **View any Chess.com/Lichess profile**: Plus+. **Create other profiles**: Plus 25, Pro 100. **Update other profiles**: Plus 50, Pro 500. Tooltips call these monthly limits [P]. An older blog post said Plus could create 30 [B:2025-april-update-search-filters-masters-plans]; the pricing page is the current figure.
- Profiles you create are private to you, can be renamed and can merge several accounts [B:2024-create-update...].
- **Bookmarks** (Plus+): star next to the name, a dropdown in the top bar, and a `/players/bookmarks` list, most recent first [F:what-are-bookmarks].
- **Players lists**: Popular; Top Bullet / Blitz / Rapid over the last 30 days (`/players`).
- **Custom name**: all tiers, up to 100 characters. **Custom page address**, **private profile** (only you can see it when logged in) and **hide a single account**: Plus+ [P, F:my-account-is-showing-my-real-name..., settings bundle].
- **Subscriber crown** toggle; link Discord and Reddit for a subscriber-only channel and flair [settings bundle].

## 6. Ultra Database (formerly Masters)
- **Size**: 10,558,953 games on the counter at /database when I read it. Covers over-the-board, correspondence and tournament games from Lichess broadcasts, TWIC and 20+ other sources; about 22M PGNs reduced by de-duplication. Only players with a current or past FIDE ID; FIDE ratings refreshed monthly [B:2025-masters-database].
- **Live updates** (since May 2026): games are added as soon as they finish, via the Lichess API. Games in progress are not included [B:2026-ultra-database].
- **Player pages** `/u/fide:<id>`: the overview is free; full statistics, explorer and PGN download are Plus [P, B:2025-masters-database].
- **Global Explorer** at `/explorer` (listed as all tiers [P]):
  - Source: Ultra Database (default) or Online, with a time-control filter for Online.
  - Free users hit a depth limit: "Please upgrade for deeper lines." (bundle).
  - Transpositions supported.
- **Live Broadcasts** (beta, app only, powered by Lichess broadcasts): one large board plus a list of smaller boards, with "fast scroll" [B:2026-transpositions-and-broadcast].

## 7. Custom databases and PGN
- **Limits**: Basic 1 database × 20 games; Plus 10 × 1,000; Pro 20 × 10,000 [P]. A 2024 post gave Plus as 5 × 5,000 [B:2024-pgn-databases]; the pricing page is the current figure.
- **Adding games**: upload PGN file(s) or paste PGN; "Input Moves" is marked coming soon. Every game must include your name, so generic databases aren't supported yet [F:how-to-upload-a-generic-database...].
- **Duplicate check** (per database): same colour, same date, same opponent and the same position after move 40 (or the final position if earlier) [F:are-duplicate-games-detected].
- **Visibility**: private by default, including for free users; untick "Hide database" to make it public. Each game page shows visibility and has Delete, Export PGN, FEN of the final position and a link to the source game [B:2024-pgn-databases, /game bundle].
- **ChessBase** users export to PGN first [F:how-can-i-upload-my-games-from-chessbase].

## 8. Studio (beta; Plus and Pro only; `/studio`, a separate app)
Labels below are from [SJ] unless cited otherwise.
- **Workspace** [B:2026-chessmonitor-studio]:
  - Every board is a tab; tabs can be split or docked side by side, floated or popped out ("Open as window"), maximized, renamed, cloned.
  - Panels: notation, engine, explorers, game lists, player profile, live broadcasts.
  - Preset layouts: Default, Explorer, Database Games, My Explorer, Player Profile, Tutorial.
  - Light / dark / system theme, UI scale.
- **Board**: themes, piece sets (Cburnett, Chessnut, Celtic, Fantasy, Spatial, Pecita, RhosGFX, Kiwen Suwi …), coordinates, eval bar side, material balance, annotation glyphs on the board, arrows and highlights, one-click moves, promotion choice, setup / edit-position mode, paste FEN.
- **Notation**: variations (promote, make main line, delete, collapse), null moves, text before/after a move, the full NAG set (!!, ?, novelty, zugzwang, ±, …), edit game headers, show clock times / eval / depth / W/D/L, block or inline layout, figurine notation, cut / delete before or after a move, clean up variations.
- **Engine**: Stockfish 19 (94 MB or 1 MB nets), 18, 17.1, 16, 16 classical (no NNUE) or 11. Settings: lines, depth, threads.
  - Actions: show threat, insert best move / best line / all lines, store eval with the move, engine arrows, multiple engine panels.
  - **Remote engines** run on your own server via a URL. Cloud engines (e.g. Lc0) are planned [B:2026-chessmonitor-studio].
- **Explorers and databases**: Ultra Database, Online Database (Lichess + Chess.com), Player Database, My Explorer. Each has a games table with configurable columns and the same filters as the site, including Opp. strength and Opponent name. Toggle percentages vs counts; "Go to next transposition".
- **My Files**: folders and databases (e.g. "Saved Repertoires", "Imported PGNs"). Open, import or insert PGN (from a file or the clipboard), save / save as, export PGN with or without metadata or main line only, copy FEN / PGN.
  - Search the current position across all files; Recycle Bin; per-database game limit.
  - Syncs with the mobile app. Databases uploaded earlier through the account are read-only for now.
- **Other**: find player and bookmarks in the sidebar; fully remappable keyboard shortcuts.

## 9. Mobile app (iOS 15+ and Android, launched 2026-04-24) [AS, B:2026-chessmonitor-mobile-app]
- Bottom navigation: Home, Player, My Files, My Profile [H mockup].
- Focus is opponent prep: linked accounts, player search and bookmarks, on-device Stockfish (18, now 19).
- Open the Ultra or personal explorer from any game position; live broadcasts (beta); fast scroll.
- My Files syncs with Studio (version 1.4.0, 2026-10-08).
- No Elo estimate in the app yet.

## 10. Pro-only services and community
- **Pro services**: video onboarding, monthly developer discussions, custom tournament prep ("scouting of opponent, weakness analysis, opening preparation and more"; scope agreed case by case) [P]. Pro users can also ask staff to create profiles of other players [F:how-do-i-find-or-create-profiles...].
- **Community**: Feature Suggestions board with upvotes; voting power Basic 1 / Plus 10 / Pro 20 [P]. Beta access for Plus+. Changelog, newsletter, Discord, Reddit.
- **Partner/affiliate programme**: exists but its terms aren't described anywhere I could read. **UNVERIFIED.**

## Not present in any source
I found no "chess personality", accuracy/ACPL statistics, streaks, best wins, longest games or player-vs-player comparison. ChessMonitor's own Lichess post (via search summary) says it focuses on statistical patterns rather than move-by-move evaluation.

Unlinked routes exist for `/tools/quick-prep` (a mobile-style explorer with engine), `/tools/infographics/tournament` and `/puzzle/mate-in-3`. Whether ordinary users can reach them: **UNVERIFIED.**

## Implementation notes from their client code
These are their internal tRPC procedure names (bundle), useful as a module map for the rebuild:
- `user.player`, `games`, `explorer`, `openings`, `opponents`, `opponentsDetails`, `opponentsMap`, `activity`, `rating`, `suggestEventName`, `suggestOpponentName`
- `global.explorerGlobal`, `gamesGlobal`, `game`, `searchSuggestion`, `playerSuggestion`
- `auth.accountSet`, `unlink`, `setPrivate`, `queuePlayer`, `bookmarks`, `refresh`, `refreshInfo`, `settings`

Their stack [/credits]: Next.js, Mantine, Express, tRPC, MySQL (Percona), RabbitMQ, Redis, Elasticsearch for name search, and lichess-org/chess-openings. Data sources: the Chess.com Published-Data API, the Lichess API, and database.lichess.org.
