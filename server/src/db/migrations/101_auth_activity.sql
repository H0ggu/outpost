-- 101_auth_activity: sign-in activity, pending user deletions and remembered devices (auth module).
--
--   users.last_seen_at  most recent sign-in or session activity (src/auth/session.ts writes it when a
--                       session is created and with the throttled sliding-expiry update). Unlike the
--                       sessions, it survives logout, revocation and the expired-session purge, so
--                       AdminUser.lastSeenAt is null only for users who never signed in.
--   users.deleting_at   set when an admin deletes the user (src/auth/purge.ts): the account is disabled
--                       and hidden at once, its games databases are purged in small batches, and the
--                       row itself is deleted last. Pending deletions resume after a restart.
--   known_devices       browsers that signed in to an account before (cookie `outpost_device`, only the
--                       SHA-256 of its value is stored). They are exempt from the per-account sign-in
--                       ceiling, so failed attempts from elsewhere cannot lock the owner out
--                       (src/auth/devices.ts, src/auth/throttle.ts).

ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN deleting_at INTEGER;

UPDATE users SET last_seen_at = (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = users.id);

CREATE INDEX users_deleting ON users (deleting_at) WHERE deleting_at IS NOT NULL;

CREATE TABLE known_devices (
  token_hash   TEXT    PRIMARY KEY,               -- hex SHA-256 of the random cookie value
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX known_devices_user ON known_devices (user_id, last_used_at);
CREATE INDEX known_devices_used ON known_devices (last_used_at);
