-- 100_auth_totp: TOTP bookkeeping for the auth module (PLAN §10).
--
--   totp_last_step       RFC 6238 time step (unix seconds / 30) of the last accepted code. A code is
--                        accepted only for a step strictly greater than this, so a code (or an older
--                        one inside the ±1 step window) can never be replayed.
--   totp_pending_secret  base32 secret from POST /api/me/totp/setup, waiting to be confirmed with a
--                        valid code (POST /api/me/totp/enable). totp_secret stays unchanged meanwhile.
--   totp_pending_at      when the pending secret was issued (it expires, see src/auth/totp.ts).
--   password_changed_at  last password change (setup/signup/admin reset/self-service), for the UI and audits.

ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending_at INTEGER;
ALTER TABLE users ADD COLUMN password_changed_at INTEGER;

-- Admin invite list (newest first) and "used by" lookups.
CREATE INDEX invites_created ON invites (created_at);
CREATE INDEX invites_used_by ON invites (used_by) WHERE used_by IS NOT NULL;
CREATE INDEX invites_created_by ON invites (created_by) WHERE created_by IS NOT NULL;
