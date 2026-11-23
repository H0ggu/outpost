// Lichess and Chess.com clients, game importers and opponent geo lookups — PLAN §7 (owner: jobs).
// Handlers for the 'sync', 'geo' and 'rebuild' job kinds (registerJobHandler from routes/jobs.ts).
// Every upstream call goes through ctx.upstream / app.upstream (../http/upstream.ts: User-Agent,
// token, shared 429 cool-down); map API games to NormalizedGame and store them with insertGame
// (../chess/store.ts). Helpers: @outpost/shared/chess (time classes, result codes, stdUci).
export {};
