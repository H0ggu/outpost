# Decisions taken at integration

The lead's answers to the module agents' open questions (2026-11-23), one line each with its reason,
so the owner can review and change them. **Do** = implemented at integration; **Keep** = the module's
behaviour stays. `docs/PLAN.md` remains the source of truth; where a decision changed it, PLAN says so.

## Data and privacy
1. **Do: FIDE sources link reference-database games only, one copy per game.** PLAN §5 builds FIDE profiles from reference-DB games, and a public FIDE profile must not expose someone's private PGN collection. One rule: migration `601` (trigger `reference_fide_player_games`; `502` was merged into it), followed by `insertGame`/`rebuildPlayerGames`.
2. **Keep: reference databases are instance-wide.** No per-viewer filtering of FIDE rows. A licensed OTB database added later is visible to every signed-in user, and to anonymous visitors when `anonymousBrowsing` is on.
3. **Keep: orphan policy.** A source and its unused games are deleted when no profile uses the source any more (re-adding it downloads again). It also runs right after a deleted user is purged (I1), not only at the periodic sweep.
4. **Keep: deleting a user.** Reference DBs go to the system; lichess, chesscom and fide sources stay; personal databases, profiles, files, prep and invites are deleted.
5. **Keep: the profile owner's username is shown on public profiles.** It tells viewers who maintains the profile.
6. **Keep: database reads need a session even with `anonymousBrowsing` on.** Anonymous browsing covers public profiles and their stats only (PLAN §10). Related: a profile's `pgn` source counts only for viewers who may read its database.
7. **Keep: the per-user limits chosen by the profiles module** (file quota, game allowance, pending imports, paste size, export rate).

## Auth
8. **Do: setting up TOTP requires the current password** (`TotpSetupRequest.password`, required by the server). A stolen session could otherwise enable TOTP and lock the owner out. Disabling takes the password or a code, as before.
9. **Keep: lockout design** (per-account and per-IP limits plus the known-device exemption). It resists both guessing and targeted lockouts.
10. **Do: one username/password policy** in the contract (`ACCOUNT_USERNAME_RE`, `USERNAME_MIN/MAX_LENGTH`, `PASSWORD_MIN/MAX_LENGTH`), the server's rules being the truth, so the forms never disagree with the server.
11. **Do: no probe of tests.stockfishchess.org** on the admin status page (a volunteer-run server); the `stockfish-nnue` status entry was dropped from the contract.

## Engine and Studio
12. **Do: a cloud-eval miss with `emptyOnMiss=1` answers 200 `{pvs: []}`** instead of 404, so the browser logs no failed request per position. Without the flag a miss stays 404. The Studio's socket shim sends the flag and treats `pvs: []`, a 404 and a 204 as a miss.
13. **Do: vendor lila's GPLv2+ `mono` piece set** (6 SVGs, via `scripts/vendor-lichess.sh`, listed in NOTICE.md) for the Studio's material difference, replacing the dimmed-cburnett stand-in. GPLv2+ is compatible with AGPL-3.0-or-later.
14. **Keep: lila's study code stays in the Studio bundle.** Fewer patches to maintain at each re-vendor.
15. **Keep: the unsaved-changes warning on reload.** The page can't tell a reload from closing the tab.
16. **Keep: one comment per move.** It matches PGN; imported multi-part comments are joined.
17. **Do (optional): `GET /api/broadcasts/round/:roundId/game/:gameId.pgn`**, one board cut from the cached round PGN, so opening a board doesn't download the whole round. The round page uses it and falls back to the round PGN (matched by player names) only on a 404; the Studio still receives `?pgn=`.

## Sync and data
18. **Keep: the daily auto refresh catches up later the same UTC day** if the server was down at the hour.
19. **Keep: `initialSyncMonths` applies per source at first import; a full resync ignores it.** The admin UI must say so.
20. **Do: geo lookups.** Lichess batches stay unlimited; Chess.com lookups stop at 1,000 requests per run, most recently met opponents first, and the next scheduled (hourly) sweep continues after a pause. All stay at background priority. Polite to the PubAPI without losing the opponents that matter most.
21. **Keep: broadcast games without a TimeControl tag stay `unknown`.** Guessing classical would be wrong for many events.
22. **Do: `broadcastAutoImport` (off by default) is exposed in GET/PUT `/api/admin/settings`** and as a toggle in the admin settings page (always shown; it says when the missing Lichess token keeps it idle), so the owner can switch it on without SQL.
23. **Keep: a `lichess:<user>` explorer spec with no local games answers 404** asking to add the account to a profile, rather than spending the token's budget on a proxy.
24. **Keep: performance rating uses the FIDE dp table.** It is published and documented; Lichess's exact formula is unconfirmed.
25. **Keep for now: a cold reference-explorer query costs about 1 s on 1M games.** Later optimisation: precompute shallow plies after a reference import.
26. **Keep: rate budgets** (tablebase 30/min per client of 120 per instance; broadcasts 60 upstream calls/min).
27. **Keep: activity bounds** (games from 1400 to tomorrow; `days` capped at 40 years) so long OTB careers still show.
28. **Keep: PGN export names each side after the account that played it** (ChessMonitor's normalisation).
29. **Keep: the `games_stats` covering index** (about 65 bytes per game) for fast cold-cache stats.

## Web
30. **Do: optional env `SOURCE_URL` → `SessionInfo.sourceUrl`**; the footer links to it when set, otherwise to the AGPL text and NOTICE. Operators of modified instances can then meet AGPL §13.
31. **Keep: the nav collapses below 1180 px.** Simpler than a "More" menu.
32. **Do: a minGames control on the prep page** (the server already supports `PrepReportParams.minGames`).
33. **Keep: the profile Explorer tab opens the board at a line filter's position, explorer unrestricted.**
34. **Do: `OPENINGS_RANK_MIN_GAMES` in the contract**; the server ranks best/worst with it and the openings page says "(min N games)".
35. **Do: event-name autocomplete**: `GET /api/profiles/:slug/events?q=` (top 20 distinct events of the visible sources, prefix matches first) and a datalist on the filters bar, as ChessMonitor has.
36. **Keep: a chunk-load retry reloads the page.** A second failed load usually means a new deployment.

## Taken while wiring the modules (integration, 2026-11-23)
Not asked of the lead; each follows a module's hand-back note or a mismatch found between the web
and the server. Same format: **what**, then why.

I1. **A purged user's orphaned accounts go at once**: the purger runs `sweepOrphans` after deleting the user row. Their profiles are deleted at once, and the periodic sweep only runs where the workers do (decisions 3 and 4: accounts other profiles still track stay).
I2. **`cancelQueuedJobs(db, dedupeKey)` in the jobs module**; profiles uses it instead of updating `jobs` itself. Only the jobs module writes `jobs`, and the helper also clears the cancelled job's checkpoint.
I3. **The explorer's `ref:<fideId>` counts a game once across reference databases** (the first stored copy). One coherent rule with decision 1, so a FIDE player's explorer and profile agree. The reference explorer over whole databases still counts every copy (it reads by database through a covering index; deduplicating there would cost the 1M-game scans).
I4. **The unified search passes the viewer to `searchReferencePlayers`**, so admins find players of private reference databases and `profileSlug` includes the viewer's own private profiles.
I5. **Chess960 games without their FEN tag are skipped as `variant`** (chessops reads the Variant tag as standard chess, so they would have been replayed from the standard start). With a FEN they stay `fromPosition` skips, as before.
I6. **Shared limits are contract constants**: `PGN_UPLOAD_MAX_BYTES` (50 MB), `PGN_PASTE_MAX_BYTES` (5 MB) and `SEARCH_QUERY_MIN/MAX_LENGTH` (2/100), next to decision 10's account policy. The import panel allowed 50 MB of pasted text, which the server refuses above 5 MB.
I7. **`DatabaseInfo.builtin`** flags the built-in broadcast database in `GET /api/reference`. The admin page found it by a source label an admin can change.
I8. **The activity tab counts games without a time of day** (date-only PGN and reference games): totals and score come from `byWeekday`, and a note says how many games the hour charts leave out. A FIDE or PGN profile showed "No games yet".
I9. **The admin status "Check again" asks for `?refresh=1`**, and the panel shows the token check's state and error, when the probes ran and the job counts. Without it the button got the server's one-minute cache back.
I10. **The Studio's player picker offers the user's PGN databases** (`db:<id>`, "my DBs" in PLAN §5), which the server already read but nothing in the UI reached.
I11. **A My Files search hit inside a variation opens at that position** (lila tree path by ply and position), not at the main line's node of the same ply.
I12. **The broadcasts page lists upcoming tours** (`BroadcastsResponse.upcoming`), and the prep cards say when lines come from the latest games only (`sampledGames`).
I13. **Kit fixes the page modules had worked around**: icon-font glyphs out of accessible names (CSS alt text), the tab underline clipped by the scrolling tab bar, the doubled search box in the header, a `HydrateFallback`; `useDebouncedValue` moved into the kit; the unused `StubPage` removed.
I14. **Wording follows the server**: the Lichess token is needed for the Lichess opening explorer and broadcasts, not for Outpost's own player explorer (decision 23); the settings page names the Studio's layout presets as the Studio does; the auth throttles' wait (`retryAfterSec`) is shown; job counters are worded; the PGN download says each side is named after its account (decision 28).

### Kept as the modules left them (open for the owner)
- Chess.com geo lookups: after a capped run (1,000 requests) no new Chess.com lookup job starts for 50 minutes, so the hourly sweep continues; a fresh sync's new opponents wait for that too (about 1,000 lookups per hour at most).
- Decision 8 is met at setup: `POST /api/me/totp/setup` needs the password, `enable` only a code for the secret that call created.
- A sync warning kept in `last_sync_error` after a successful sync (Lichess `tosViolation`, a closed Chess.com account) shows like an error (caution icon and message) on the profile.

### Deferred
- The explorer proxy's request budgets (Lichess explorer 20/min, tablebase, cloud eval) are not shown on the admin status page: they are per-process and short-lived; exposing them needs a registry on `app` and a contract field.
- Reference imports from a URL follow redirects inside the shared client and check the final address (scheme, host, resolved addresses) before reading anything; intermediate hops are not checked and DNS rebinding stays possible. Admin-only. Checking each hop needs a `redirect: 'manual'` option in `app.upstream`.
- Coordinates inside the board (`.acc-preview-board` in account.css) stay page-local: only the settings preview draws coordinates, and moving the rules into the kit's board.css could disturb pgn-viewer's own coordinates.
- No "full resync" button exists (the server supports `enqueueSync(…, {full: true})`); decision 19's note is on the first-import setting.
- Not built: Lichess `/api/user/{u}/rating-history` (rating charts come from synced games), rejecting far-future PGN dates at import (stats already ignores them), recovering `parsePgnGames` after a too-complex game (reference splits games itself), rendering the real pgn-viewer in tests (`server.deps.inline`), and live tests of the Lichess FIDE directory and the token-only endpoints (no token here).

