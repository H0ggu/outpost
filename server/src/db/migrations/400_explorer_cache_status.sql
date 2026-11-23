-- 400_explorer_cache_status: HTTP status of cached upstream answers (explorer module, PLAN §4).
--
-- The explorer caches "not found" answers too (cloud-eval 404s, unknown masters game ids) for a
-- shorter time than successes, so http_cache needs the status. Existing rows are successes.
-- Explorer keys are prefixed `ex:<kind>:` (src/explorer/cache.ts); other modules keep their own
-- prefixes and can ignore the column (it defaults to 200).

ALTER TABLE http_cache ADD COLUMN status INTEGER NOT NULL DEFAULT 200 CHECK (status BETWEEN 100 AND 599);
