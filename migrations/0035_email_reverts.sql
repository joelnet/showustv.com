-- Email-change safety. When a verified account's email is swapped
-- to a new address (POST /auth/verify-email), the PREVIOUS address is emailed a
-- security notice carrying a one-click revert link. This table holds that
-- single-use, short-lived revert token.
--
-- Mirrors password_resets (0026) and email_verifications (0007): one pending
-- revert per user (a newer email change replaces the row), only the token's
-- SHA-256 digest is stored (the raw token lives solely in the emailed link, so
-- a DB leak can't revert anyone's email), and the worker deletes the row on
-- first presentation, valid or expired. prev_email is the address to restore;
-- a short TTL (expires_at) bounds the window either way.
--
-- ⚠️ Apply before/with the deploy: POST /auth/verify-email writes this table on
-- every email swap and POST /auth/revert-email reads it, so both break if the
-- table is missing.
CREATE TABLE email_reverts (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prev_email TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
) STRICT;
