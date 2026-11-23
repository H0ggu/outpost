# Explorer fixtures (synthetic)

Shapes of the Lichess explorer answers that lila's explorer UI parses
(`web/vendor/lila/analyse/src/explorer/interfaces.ts`). The tests compare Outpost's answers with
these key by key.

- `masters-sample.json`: the shape of `explorer.lichess.org/masters?…&play=e2e4,c7c5,g1f3&moves=4&topGames=4`
  as recorded on 2026-11-23 (key order and types kept, counts kept); player names replaced with
  synthetic ones and game ids made up.
- `lichess-player-sample.ndjson`: the documented shape of `explorer.lichess.org/player` (an NDJSON
  stream whose last line is the answer; research `docs/research/lichess-api.md` §3). It can't be
  recorded here (the player explorer needs a token), so every value is synthetic.
- `tablebase-sample.json`, `cloud-eval-sample.json`: shapes of tablebase.lichess.ovh/standard and
  lichess.org/api/cloud-eval (2026-11-23); positions and evaluations only, no personal data.
